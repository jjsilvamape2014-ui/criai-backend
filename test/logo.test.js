const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logoMaker');

test('pedido de logo com nome e cor não precisa de pergunta', () => {
  const m = 'cria um logo com o nome Linha Fácil na cor azul';
  assert.ok(L.isLogoRequest(m));
  assert.strictEqual(L.extractName(m), 'Linha Fácil');
  assert.strictEqual(L.extractColor(m).name, 'azul');
});
test('nome entre aspas e "chamada"', () => {
  assert.strictEqual(L.extractName('quero um logotipo "Forno Bom" vermelho'), 'Forno Bom');
  assert.strictEqual(L.extractName('faz uma logomarca chamada Padaria São João em dourado'), 'Padaria São João');
});
test('sem nome → vazio (o app pergunta só o nome)', () => {
  assert.strictEqual(L.extractName('cria uma logo para minha barbearia'), '');
});
test('animar/colocar logo não é criar logo', () => {
  assert.ok(!L.isLogoRequest('anima minha logo'));
  assert.ok(!L.isLogoRequest('coloca a logo no canto'));
});
test('logo composta escreve o nome por código (PNG 1080x1080)', async () => {
  const png = await L.composeLogo({ name: 'Linha Fácil', hex: '#1d4ed8' });
  const meta = await require('sharp')(png).metadata();
  assert.strictEqual(meta.width, 1080);
  assert.strictEqual(meta.height, 1080);
});
