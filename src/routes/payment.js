const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const { CREDIT_PACKAGES } = require('./credits');
const router = express.Router();
const prisma = new PrismaClient();

// Criar sessão de checkout (assinatura premium)
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { type, packageId } = req.body; // type: 'subscription' | 'credits'
    const user = req.user;

    let sessionConfig = {
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/plans?canceled=true`,
      client_reference_id: user.id,
      customer_email: user.email,
    };

    if (type === 'subscription') {
      // Assinatura mensal premium (R$ 39,99/mês)
      sessionConfig.mode = 'subscription';
      const lineItem = { quantity: 1 };
      if (process.env.STRIPE_PRICE_PREMIUM) {
        lineItem.price = process.env.STRIPE_PRICE_PREMIUM;
      } else {
        // Cria o preço recorrente automaticamente (sem depender de price manual no painel)
        lineItem.price_data = {
          currency: 'brl',
          product_data: { name: 'Premium Mensal', description: 'Imagens e vídeos ilimitados com IA em 4K' },
          unit_amount: 3999,
          recurring: { interval: 'month' }
        };
      }
      sessionConfig.line_items = [lineItem];
    } else {
      // Compra de créditos avulsos
      const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);
      if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });

      sessionConfig.mode = 'payment';
      sessionConfig.line_items = [{
        price_data: {
          currency: 'brl',
          product_data: { name: pkg.name, description: `${pkg.images} imagens + ${pkg.videos} vídeos` },
          unit_amount: pkg.price
        },
        quantity: 1
      }];
      sessionConfig.metadata = { userId: user.id, packageId: pkg.id, credits: pkg.images };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
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
    const paid = data.data.find(s => s.payment_status === 'paid');
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

    const user = req.user;
    if (session.mode === 'subscription') {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          plan: 'PREMIUM',
          creditsImages: 500,
          creditsVideos: 50,
          stripeCustomerId: session.customer
        }
      });
    } else {
      const credits = parseInt(session.metadata?.credits || 0);
      if (credits > 0) {
        await prisma.user.update({
          where: { id: user.id },
          data: { creditsPurchased: { increment: credits } }
        });
      }
    }

    await prisma.payment.create({
      data: {
        userId: user.id,
        stripePaymentId: session.payment_intent || session.id,
        amount: session.amount_total,
        currency: session.currency,
        status: 'COMPLETED',
        type: session.mode === 'subscription' ? 'SUBSCRIPTION' : 'CREDITS',
        creditsAmount: session.mode === 'payment' ? parseInt(session.metadata?.credits) : null
      }
    });

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    res.json({ success: true, user: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao confirmar pagamento' });
  }
});

// Webhook Stripe (atualizar créditos após pagamento)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.userId;

    if (session.mode === 'subscription') {
      // Ativar premium
      await prisma.user.update({
        where: { id: userId },
        data: {
          plan: 'PREMIUM',
          creditsImages: 500,
          creditsVideos: 50,
          stripeCustomerId: session.customer
        }
      });
    } else {
      // Adicionar créditos comprados
      const credits = parseInt(session.metadata?.credits || 0);
      if (credits > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: { creditsPurchased: { increment: credits } }
        });
      }
    }

    // Registrar pagamento
    await prisma.payment.create({
      data: {
        userId,
        stripePaymentId: session.payment_intent || session.id,
        amount: session.amount_total,
        currency: session.currency,
        status: 'COMPLETED',
        type: session.mode === 'subscription' ? 'SUBSCRIPTION' : 'CREDITS',
        creditsAmount: session.mode === 'payment' ? parseInt(session.metadata?.credits) : null
      }
    });
  }

  res.json({ received: true });
});

module.exports = router;
