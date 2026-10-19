/*
  Registra o endpoint de webhook do Stripe — o caminho que credita a compra sem
  depender de o cliente voltar para o site.

  POR QUE ISSO IMPORTA: o crédito também é aplicado em /api/payment/confirm,
  chamado pela página do painel quando o cliente volta do Stripe. Mas quem paga e
  fecha a aba, ou perde o sinal no celular, nunca chega nessa página — sem o
  webhook essa pessoa pagou e não recebeu nada.

  Uso:
    node src/scripts/register-webhook.js https://criai-backend-production.up.railway.app
    node src/scripts/register-webhook.js https://criai-backend-production.up.railway.app --force

  ATENÇÃO AO MODO: a chave em STRIPE_SECRET_KEY decide tudo. Com sk_test_ o
  webhook só recebe eventos de teste; quando as chaves de produção entrarem, é
  preciso rodar este script de novo (e o endpoint antigo pode ser apagado no
  painel do Stripe).

  A secret do webhook só é mostrada UMA vez, na criação. Se já existe endpoint
  para a URL, o script avisa e não cria outro (--force cria assim mesmo).
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { modo } = require('../billingStatus');

const baseUrl = process.argv[2];
const force = process.argv.includes('--force');
const events = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
];

function uso(msg) {
  if (msg) console.error(`✗ ${msg}\n`);
  console.error('Uso: node src/scripts/register-webhook.js <url-publica-do-backend> [--force]');
  console.error('Ex.: node src/scripts/register-webhook.js https://criai-backend-production.up.railway.app');
  process.exit(1);
}

async function main() {
  if (!baseUrl || baseUrl.startsWith('--')) uso('Informe a URL pública do backend.');

  const m = modo();
  if (m === 'missing') uso('STRIPE_SECRET_KEY não está configurada (no .env ou no ambiente).');
  if (m === 'unknown') uso('STRIPE_SECRET_KEY não parece uma chave do Stripe (deve começar com sk_live_ ou sk_test_).');

  if (m === 'test') {
    console.warn('⚠ Chave de TESTE: este webhook só vai receber eventos de teste.');
    console.warn('  Quando as chaves de produção (sk_live_…) entrarem, rode este script de novo.\n');
  }

  if (!/^https:\/\//i.test(baseUrl)) {
    uso('A URL precisa ser https: o Stripe recusa endpoint http ou localhost.');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/api/payment/webhook`;

  const existentes = await stripe.webhookEndpoints.list({ limit: 100 });
  const mesmoUrl = (existentes.data || []).filter((e) => e.url === url);

  if (mesmoUrl.length && !force) {
    console.log(`Já existe ${mesmoUrl.length} endpoint(s) para ${url}:\n`);
    for (const e of mesmoUrl) {
      console.log(` - ${e.id} | status ${e.status} | eventos: ${(e.enabled_events || []).join(', ')}`);
    }
    console.log('\nA secret de um endpoint existente NÃO pode ser lida de novo — ela só aparece na criação.');
    console.log('Se você perdeu a secret: apague o endpoint no painel do Stripe (Dashboard → Developers → Webhooks)');
    console.log('e rode este script outra vez, OU rode com --force para criar um novo (o antigo continua lá, recebendo os mesmos eventos).');
    return;
  }

  console.log(`Registrando webhook em: ${url} (modo ${m})`);
  const webhook = await stripe.webhookEndpoints.create({ url, enabled_events: events, api_version: '2024-06-20' });

  console.log('\n✅ Webhook criado!');
  console.log(`   id: ${webhook.id}`);
  console.log(`   url: ${webhook.url}`);
  console.log(`   eventos: ${(webhook.enabled_events || []).join(', ')}\n`);
  console.log('Guarde esta secret (ela só aparece agora) e configure no serviço do backend:');
  console.log(`\n   STRIPE_WEBHOOK_SECRET=${webhook.secret}\n`);
  console.log('Se o serviço rodar na Railway, dá para definir direto:');
  console.log(`   railway variables --set "STRIPE_WEBHOOK_SECRET=${webhook.secret}"`);
  console.log('\nSem essa variável o backend responde 400 em /api/payment/webhook e ignora a assinatura —');
  console.log('o crédito ainda cai pelo /confirm quando o cliente volta ao site, mas quem não volta fica sem.');
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
