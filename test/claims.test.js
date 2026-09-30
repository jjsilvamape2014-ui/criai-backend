const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/claims');
const TC = require('../src/textCheck');

test('promessa que o cliente não fez sai da fala; o resto fica', () => {
  const out = C.cleanVoice('A JN Refrigeração instala seu ar-condicionado com garantia. Fazemos avaliação gratuita. Chame no WhatsApp.', 'vídeo da JN Refrigeração, WhatsApp');
  assert.ok(out.includes('JN Refrigeração instala'));
  assert.ok(!/garantia|gratuita/i.test(out));
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
