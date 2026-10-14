// Testes da escolha do modelo de imagem e da espera no limite da visão. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/imageModels');

test('peça com texto → Ideogram 3; sem texto → FLUX 2 Pro; com referência → edição', () => {
  delete process.env.IMAGE_MODEL_TEXT; delete process.env.IMAGE_MODEL_PHOTO;
  assert.strictEqual(M.pickImageModel({ needsText: true }), 'ideogram');
  assert.strictEqual(M.pickImageModel({ needsText: false }), 'flux2pro');
  assert.strictEqual(M.pickImageModel({ hasReference: true, needsText: true }), undefined);
});
test('variáveis voltam ao modelo antigo', () => {
  process.env.IMAGE_MODEL_TEXT = 'fluxpro';
  assert.strictEqual(M.pickImageModel({ needsText: true }), 'fluxpro');
  delete process.env.IMAGE_MODEL_TEXT;
});
test('modelo novo que falha tenta o Flux Pro 1.1 antes da Stability', () => {
  assert.ok(M.hasFalFallback('ideogram'));
  assert.ok(M.hasFalFallback('flux2pro'));
  assert.ok(!M.hasFalFallback('fluxpro'));
  assert.ok(!M.hasFalFallback(undefined));
});
test('quais pedidos contam como "tem texto"', () => {
  const TC = require('../src/textCheck');
  const { extractTextTokens } = require('../src/llm');
  const has = (m) => TC.pieceTexts(extractTextTokens(m), m).length > 0;
  assert.ok(has('post de bom dia para a padaria'));
  assert.ok(has('arte da promoção pizza grande R$ 49,90'));
  assert.ok(has('banner escrito "Liquidação de verão"'));
  assert.ok(!has('foto de um café na mesa de madeira, luz da manhã'));
});
test('espera no limite da Groq: cabeçalho, mensagem ou 3 s', () => {
  const { retryWaitMs } = require('../src/vision')._internals;
  assert.strictEqual(retryWaitMs({ headers: { 'retry-after': '2' } }), 2300);
  assert.strictEqual(retryWaitMs({ headers: {}, data: { error: { message: 'Please try again in 1.5s.' } } }), 1800);
  assert.strictEqual(retryWaitMs({ headers: {}, data: { error: { message: 'try again in 640ms' } } }), 940);
  assert.strictEqual(retryWaitMs({ headers: {}, data: {} }), 3000);
});
