// Valores dos planos e pacotes. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/plans');

test('padrões: grátis 10 imagens + 1 vídeo de 5 s; PREMIUM R$ 49,90 com 50 imagens + 15 s', () => {
  const s = P.summary();
  assert.strictEqual(s.free.images, 10);
  assert.strictEqual(s.free.videoSeconds, 5);
  assert.strictEqual(s.premium.price, 4990);
  assert.strictEqual(s.premium.images, 50);
  assert.strictEqual(s.premium.videoSeconds, 15);
  assert.deepStrictEqual(s.packages.map((p) => [p.credits, p.price]), [[30, 1990], [100, 5990], [250, 13990]]);
});
test('variáveis de ambiente trocam os valores sem mexer no código', () => {
  process.env.PREMIUM_MONTHLY_IMAGES = '80';
  process.env.PREMIUM_PRICE_CENTS = '5990';
  assert.strictEqual(P.PREMIUM.images(), 80);
  assert.strictEqual(P.summary().premium.priceFormatted.replace(/\s/g, ' '), 'R$ 59,90');
  delete process.env.PREMIUM_MONTHLY_IMAGES; delete process.env.PREMIUM_PRICE_CENTS;
});
test('custo no pior caso fica abaixo de ~55% do preço (premissas de out/2026)', () => {
  // imagem ~US$ 0,06; vídeo ~US$ 0,112/s; dólar ~R$ 5,50 (aproximado — conferir na fatura do fal)
  const s = P.summary();
  const usd = s.premium.images * 0.06 + s.premium.videoSeconds * 0.112;
  const custo = usd * 5.5 * 100;
  assert.ok(custo / s.premium.price < 0.55, `custo ${Math.round(custo)} centavos`);
  for (const p of s.packages) assert.ok((p.credits * 0.06 * 5.5 * 100) / p.price < 0.6, p.id);
});
