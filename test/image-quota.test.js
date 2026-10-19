// Testes da cobrança/estorno de imagem — pegam o bug em que uma falha de
// geração criava crédito do nada (devolvia 1 crédito comprado mesmo sem cobrar).
// Rodar: npm test  (funções puras: não toca banco nem rede)
const test = require('node:test');
const assert = require('node:assert');
const IQ = require('../src/imageQuota');

test('conta ilimitada (PREMIUM) não cobra nada — e por isso não devolve nada', () => {
  const charge = IQ.cobrancaImagem({ ilimitado: true, creditosComprados: 50 });
  assert.deepStrictEqual(charge, { p: 0, v: 0 });
  // era exatamente esse o bug: catch devolvia { creditsPurchased: +1 } mesmo aqui
  assert.deepStrictEqual(IQ.estornoParaPrisma(charge), {});
});

test('tem crédito comprado → cobra do comprado e devolve do comprado', () => {
  const charge = IQ.cobrancaImagem({ ilimitado: false, creditosComprados: 3 });
  assert.deepStrictEqual(charge, { p: 1, v: 0 });
  assert.deepStrictEqual(IQ.estornoParaPrisma(charge), { creditsPurchased: { increment: 1 } });
});

test('sem crédito comprado → cobra das imagens do mês e devolve pras imagens do mês', () => {
  const charge = IQ.cobrancaImagem({ ilimitado: false, creditosComprados: 0 });
  assert.deepStrictEqual(charge, { p: 0, v: 1 });
  // bug antigo mandava isso pra creditsPurchased (carteira errada, criando crédito)
  assert.deepStrictEqual(IQ.estornoParaPrisma(charge), { creditsImages: { increment: 1 } });
});

test('falha antes da cobrança (charge nulo) não devolve nada', () => {
  assert.deepStrictEqual(IQ.estornoParaPrisma(null), {});
  assert.deepStrictEqual(IQ.estornoParaPrisma(undefined), {});
  assert.deepStrictEqual(IQ.estornoParaPrisma({ p: 0, v: 0 }), {});
});

test('charge incompleto só devolve o que existe', () => {
  assert.deepStrictEqual(IQ.estornoParaPrisma({ p: 2, v: 0 }), { creditsPurchased: { increment: 2 } });
  assert.deepStrictEqual(IQ.estornoParaPrisma({ p: 0, v: 3 }), { creditsImages: { increment: 3 } });
});

test('valores não numéricos não viram crédito', () => {
  assert.deepStrictEqual(IQ.estornoParaPrisma({ p: 'abc', v: null }), {});
  assert.deepStrictEqual(IQ.cobrancaImagem({ ilimitado: false, creditosComprados: 'abc' }), { p: 0, v: 1 });
});
