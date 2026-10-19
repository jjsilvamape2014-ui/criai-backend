// URLs de retorno do Stripe. O bug que estes testes travam: FRONTEND_URL é uma
// lista separada por vírgula (CORS) e era colada crua no success_url, o que fazia
// o Stripe recusar a sessão e derrubava TODO o checkout.
const test = require('node:test');
const assert = require('node:assert');
const { returnBase, checkoutUrls } = require('../src/returnUrl');

const LISTA = 'https://criai-frontend-production.up.railway.app,https://ia.linhafacil2026.com.br,http://localhost:3000';

test('FRONTEND_URL em lista: escolhe UMA URL, sem vírgula nenhuma', () => {
  const env = { FRONTEND_URL: LISTA };
  const { success_url, cancel_url, base } = checkoutUrls(env);
  assert.strictEqual(base, 'https://criai-frontend-production.up.railway.app');
  assert.ok(!success_url.includes(','), success_url);
  assert.ok(!cancel_url.includes(','), cancel_url);
  assert.strictEqual(success_url, 'https://criai-frontend-production.up.railway.app/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}');
  assert.strictEqual(cancel_url, 'https://criai-frontend-production.up.railway.app/plans?canceled=true');
});

test('pula localhost e pega a primeira URL pública', () => {
  assert.strictEqual(returnBase({ FRONTEND_URL: 'http://localhost:3000,https://app.exemplo.com' }), 'https://app.exemplo.com');
  assert.strictEqual(returnBase({ FRONTEND_URL: 'http://127.0.0.1:3000,https://app.exemplo.com/' }), 'https://app.exemplo.com');
});

test('CHECKOUT_RETURN_URL manda em tudo (é como se escolhe o domínio bonito)', () => {
  const env = { FRONTEND_URL: LISTA, CHECKOUT_RETURN_URL: 'https://ia.linhafacil2026.com.br/' };
  assert.strictEqual(checkoutUrls(env).base, 'https://ia.linhafacil2026.com.br');
});

test('só localhost: cai no localhost (dev não quebra)', () => {
  const env = { FRONTEND_URL: 'http://localhost:3000' };
  assert.strictEqual(checkoutUrls(env).base, 'http://localhost:3000');
});

test('sem FRONTEND_URL alguma: padrão local, sem estourar', () => {
  assert.strictEqual(returnBase({}), 'http://localhost:3000');
  assert.strictEqual(returnBase({ FRONTEND_URL: '   ' }), 'http://localhost:3000');
});
