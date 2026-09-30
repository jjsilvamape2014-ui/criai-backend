const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/claims');
const TC = require('../src/textCheck');

test('promessa que o cliente não fez sai da fala; o resto fica', () => {
  const out = C.cleanVoice('A JN Refrigeração instala seu ar-condicionado com garantia. Fazemos avaliação gratuita. Chame no WhatsApp.', 'vídeo da JN Refrigeração, WhatsApp');
  assert.strictEqual(out, 'Chame no WhatsApp.');
  assert.strictEqual(C.cleanVoice('Conforto imediato e economia de energia.', 'JN'), '');
  assert.deepStrictEqual(C.disallowed('nosso técnico instala em até 48h', 'JN'), ['prazo']);
});
test('prompt sem texto não manda escrever nada', () => {
  const p = TC.textFreePrompt('Instagram post for Forno Bom pizzeria, steaming pizza, while bold text **Promoção de Terça** in black font and price **R$ 49,90** appear; warm lighting.');
  assert.ok(!/Promoção|49,90|font/.test(p));
  assert.ok(/steaming pizza/.test(p));
  assert.deepStrictEqual(TC.requiredTexts(['R$ 49,90,']), ['R$ 49,90']);
});
test('promessa que o cliente fez fica', () => {
  assert.strictEqual(C.cleanVoice('Aproveite a promoção com 20% de desconto!', 'promoção 20% de desconto'), 'Aproveite a promoção com 20% de desconto!');
  assert.deepStrictEqual(C.disallowed('Certificado de qualidade por carga', 'XYZ: certificado de qualidade por carga'), []);
});
test('texto de tela perde só o trecho', () => {
  assert.strictEqual(C.cleanText('Oferta por tempo limitado!', 'pizzaria'), 'Oferta!');
});
test('textos obrigatórios ignoram tamanho da imagem', () => {
  assert.deepStrictEqual(TC.requiredTexts(['1350', 'Black Friday', 'R$ 49,90']), ['Black Friday', 'R$ 49,90']);
});
