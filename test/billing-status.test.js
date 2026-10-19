// Modo do Stripe. O que estes testes travam: produção subiu meses com chave de
// TESTE e sem STRIPE_WEBHOOK_SECRET — ninguém conseguia pagar e o sintoma visível
// era só "o site não vende". O alerta tem de aparecer nesse caso e ficar quieto
// quando está tudo certo (senão ninguém lê o log).
const test = require('node:test');
const assert = require('node:assert');
const { modo, section, alerta } = require('../src/billingStatus');

const LIVE = 'sk_live_abc123';
const TESTE = 'sk_test_abc123';

test('modo: reconhece live, test, ausente e chave estranha', () => {
  assert.strictEqual(modo({ STRIPE_SECRET_KEY: LIVE }), 'live');
  assert.strictEqual(modo({ STRIPE_SECRET_KEY: TESTE }), 'test');
  assert.strictEqual(modo({}), 'missing');
  assert.strictEqual(modo({ STRIPE_SECRET_KEY: 'pk_test_abc' }), 'unknown');
});

test('section: só libera cobrança real com chave de produção', () => {
  assert.strictEqual(section({ STRIPE_SECRET_KEY: LIVE }).canCharge, true);
  assert.strictEqual(section({ STRIPE_SECRET_KEY: TESTE }).canCharge, false);
  assert.strictEqual(section({}).canCharge, false);
  // não vaza nada de dentro da chave
  const s = section({ STRIPE_SECRET_KEY: LIVE });
  assert.ok(!JSON.stringify(s).includes('abc123'), 'a chave não pode aparecer no diagnóstico');
});

test('section: diz de qual domínio o cliente volta depois de pagar', () => {
  const s = section({ STRIPE_SECRET_KEY: LIVE, CHECKOUT_RETURN_URL: 'https://ia.linhafacil2026.com.br/' });
  assert.strictEqual(s.returnBase, 'https://ia.linhafacil2026.com.br');
});

test('alerta: chave de teste em produção é o alerta mais grave', () => {
  const msg = alerta({ STRIPE_SECRET_KEY: TESTE, NODE_ENV: 'production' });
  assert.match(msg, /CHAVE DE TESTE/);
  assert.match(msg, /NENHUM cliente consegue pagar/);
});

test('alerta: chave de teste em dev não polui o log', () => {
  assert.strictEqual(alerta({ STRIPE_SECRET_KEY: TESTE }), null);
});

test('alerta: produção sem chave alguma avisa; dev sem chave fica quieto', () => {
  assert.match(alerta({ NODE_ENV: 'production' }), /STRIPE_SECRET_KEY não configurada/);
  assert.strictEqual(alerta({}), null);
});

test('alerta: produção real sem webhook avisa que quem fechar a aba perde os créditos', () => {
  const msg = alerta({ STRIPE_SECRET_KEY: LIVE, NODE_ENV: 'production' });
  assert.match(msg, /STRIPE_WEBHOOK_SECRET/);
  // com o webhook, silêncio total
  assert.strictEqual(alerta({ STRIPE_SECRET_KEY: LIVE, NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), null);
});

test('alerta: Railway conta como produção mesmo sem NODE_ENV', () => {
  assert.match(alerta({ STRIPE_SECRET_KEY: TESTE, RAILWAY_ENVIRONMENT: 'production' }), /CHAVE DE TESTE/);
});
