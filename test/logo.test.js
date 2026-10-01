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
test('símbolo com fundo/tile é rejeitado; ícone limpo é aceito e recolorido', async () => {
  const sharp = require('sharp');
  const tile = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#fcd34d"/><rect x="100" y="100" width="312" height="312" rx="60" fill="#2563eb"/></svg>')).png().toBuffer();
  assert.strictEqual(await L.processSymbol(tile, '#1d4ed8'), null);
  const icon = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#fff"/><circle cx="256" cy="256" r="90" fill="#f59e0b"/></svg>')).png().toBuffer();
  assert.ok(await L.processSymbol(icon, '#1d4ed8'));
});
test('ajuste da logo: nome não engole a resposta seguinte', () => {
  assert.strictEqual(L.extractName('cria um logo com o nome Linha Fácil. faz em verde'), 'Linha Fácil');
  assert.strictEqual(L.extractColor('cria um logo com o nome Linha Fácil. faz em verde').name, 'verde');
  assert.strictEqual(L.businessOf('cria um logo com o nome Linha Fácil na cor azul. é uma loja de roupas', 'Linha Fácil'), 'roupas');
});
test('ramo → ícone do app; sem ramo → monograma', () => {
  assert.strictEqual(L.iconFor('barbearia'), 'scissors');
  assert.strictEqual(L.iconFor('roupas'), 'bag');
  assert.strictEqual(L.iconFor('concreto'), 'building');
  assert.strictEqual(L.iconFor('xpto'), null);
});

test('nome da logo com artigo antes e cor solta depois', () => {
  const L = require('../src/logoMaker');
  assert.strictEqual(L.extractName('Quero uma logo para a Doce Sabor Confeitaria, cor rosa. Sem enrolação.'), 'Doce Sabor Confeitaria');
  assert.strictEqual(L.extractName('cria uma logomarca pro Bar do Zé, cor verde'), 'Bar do Zé');
  assert.strictEqual(L.extractName('faz um logo com o nome Linha Fácil azul'), 'Linha Fácil');
  assert.strictEqual(L.extractName('logo com o nome "Azul Turismo"'), 'Azul Turismo');
});

test('"logo da Auto Center Silva em vermelho" (sem verbo) é pedido de logo', () => {
  const L = require('../src/logoMaker');
  assert.ok(L.isLogoRequest('logo da Auto Center Silva em vermelho'));
  assert.ok(!L.isLogoRequest('logo da empresa no vídeo'));
});
