const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const plans = require('../plans');
const router = express.Router();
const prisma = new PrismaClient();

// Criar sessão de checkout (assinatura premium)
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { type, packageId } = req.body; // type: 'subscription' | 'credits' | 'video'
    const user = req.user;

    let sessionConfig = {
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/plans?canceled=true`,
      client_reference_id: user.id,
      customer_email: user.email,
    };

    if (type === 'subscription') {
      // Assinatura mensal premium (valor em plans.js; STRIPE_PRICE_PREMIUM tem prioridade se existir)
      sessionConfig.mode = 'subscription';
      const lineItem = { quantity: 1 };
      if (process.env.STRIPE_PRICE_PREMIUM) {
        lineItem.price = process.env.STRIPE_PRICE_PREMIUM;
      } else {
        // Cria o preço recorrente automaticamente (sem depender de price manual no painel)
        lineItem.price_data = {
          currency: 'brl',
          product_data: { name: 'Linha Fácil IA — Premium mensal', description: `${plans.PREMIUM.images()} imagens + ${plans.summary().premium.videoSeconds} s de vídeo por mês` },
          unit_amount: plans.PREMIUM.priceCents(),
          recurring: { interval: 'month' }
        };
      }
      sessionConfig.line_items = [lineItem];
    } else {
      // Compra de créditos avulsos (imagem) ou de um pacote de vídeo (clipes de 5 s).
      // O catálogo é decidido pelo próprio id (plans.findPackage recusa id inexistente).
      const pkg = plans.findPackage(packageId);
      if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });

      const deVideo = pkg.kind === 'video';
      sessionConfig.mode = 'payment';
      sessionConfig.line_items = [{
        price_data: {
          currency: 'brl',
          product_data: {
            name: `Linha Fácil IA — ${pkg.name}`,
            description: deVideo
              ? `${pkg.clips} vídeos de 5 s (${pkg.credits} créditos). Valem para imagem também. Não vencem.`
              : `${pkg.credits} créditos (1 imagem = 1 crédito; vídeo = ${plans.summary().videoCreditsPer5s} a cada 5 s). Não vencem.`
          },
          unit_amount: pkg.price
        },
        quantity: 1
      }];
      sessionConfig.metadata = { userId: user.id, packageId: pkg.id, credits: pkg.credits, kind: pkg.kind };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    require('../limitLog').record(user.id, 'checkout'); // painel: abriu o pagamento
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento' });
  }
});

// Webhook Stripe (atualizar créditos após pagamento)
// Recuperar a sessão paga mais recente do usuário (para confirmar sem session_id na URL)
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const data = await stripe.checkout.sessions.list({
      created: { gte: Math.floor(Date.now() / 1000) - 30 * 60 },
      limit: 20,
    });
    const paid = data.data.find(s => s.payment_status === 'paid' && (s.client_reference_id === req.user.id || (s.metadata && s.metadata.userId === req.user.id)));
    if (paid) {
      return res.json({ sessionId: paid.id });
    }
    res.json({ sessionId: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar sessão' });
  }
});

// Confirmar pagamento consultando a sessão diretamente (funciona sem webhook em dev)
router.post('/confirm', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatório' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Pagamento não confirmado' });
    }

    await applyPaidSession(session);

    const updated = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ success: true, user: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao confirmar pagamento' });
  }
});

// Aplica os efeitos de um pagamento confirmado (ativos + créditos) de forma idempotente.
async function applyPaidSession(session) {
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) return;

  const isSubscription = session.mode === 'subscription';
  const paymentId = session.payment_intent || session.id;

  // Uma vez só por pagamento: /confirm e o webhook podem chegar os dois (ou repetidos).
  // Antes os créditos eram somados ANTES dessa checagem, então repetir o /confirm somava de novo.
  if (paymentId) {
    const existing = await prisma.payment.findFirst({ where: { stripePaymentId: paymentId } });
    if (existing) return;
    await prisma.payment.create({
      data: {
        userId,
        stripePaymentId: paymentId,
        amount: session.amount_total,
        currency: session.currency,
        status: 'COMPLETED',
        type: isSubscription ? 'SUBSCRIPTION' : 'CREDITS',
        creditsAmount: !isSubscription ? parseInt(session.metadata?.credits) : null
      }
    });
  }

  if (isSubscription) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        plan: 'PREMIUM',
        creditsImages: plans.PREMIUM.images(),
        creditsVideos: 0,
        monthlyResetDate: plans.nextMonthStart(),
        stripeCustomerId: session.customer
      }
    });
  } else {
    const credits = parseInt(session.metadata?.credits || 0);
    if (credits > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { creditsPurchased: { increment: credits } }
      });
    }
  }
}

// Webhook Stripe (atualizar créditos após pagamento)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Em produção a STRIPE_WEBHOOK_SECRET DEVE estar configurada
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('[webhook] STRIPE_WEBHOOK_SECRET não configurada; ignorando assinatura');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // responds immediately após validar a assinatura
  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    try {
      await applyPaidSession(event.data.object);
    } catch (err) {
      console.error('[webhook] erro ao aplicar sessão paga:', err.message);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    // Cobertura básica: quando o assinante cancela/não renova, volta para FREE
    try {
      const customerId = event.data.object.customer;
      if (customerId) {
        await prisma.user.updateMany({
          where: { stripeCustomerId: customerId },
          data: { plan: 'FREE', creditsImages: plans.FREE.images(), creditsVideos: plans.FREE.videoCredits(), monthlyResetDate: plans.nextMonthStart() }
        });
      }
    } catch (err) {
      console.error('[webhook] erro ao rebaixar para FREE:', err.message);
    }
  }
});

module.exports = router;
