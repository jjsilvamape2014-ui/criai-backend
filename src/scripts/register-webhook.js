/* 
  Registra o endpoint de webhook do Stripe automaticamente.
  Útil em produção (modo live), depois que o backend tiver domínio público.

  Uso (modo teste):
    node src/scripts/register-webhook.js https://criai-backend-production.up.railway.app

  Com eventos padrão de checkout + assinatura.
  Requer STRIPE_SECRET_KEY no ambiente (.env).
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const baseUrl = process.argv[2];
const events = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
];

async function main() {
  if (!baseUrl) {
    console.error('Informe a URL pública do backend. Ex: node src/scripts/register-webhook.js https://x.up.railway.app');
    process.exit(1);
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/payment/webhook`;
  console.log(`Registrando webhook em: ${url}`);

  const webhook = await stripe.webhookEndpoints.create({
    url,
    enabled_events: events,
    api_version: '2024-06-20'
  });

  console.log('\n✅ Webhook criado!');
  console.log('Copie esta secret e configure no Railway (variável STRIPE_WEBHOOK_SECRET):\n');
  console.log(webhook.secret);
  console.log('\n⚠ Guarde acima: só aparece uma vez.');
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});