const test = require('node:test');
const assert = require('node:assert');

test('peça nova não parte da imagem anterior; ajuste sim', () => {
  const c = require('../src/contract');
  assert.ok(c.isNewPiece('faz um post para a padaria Pão Quente'));
  assert.ok(c.isNewPiece('agora faz outro post de dia das mães'));
  assert.ok(!c.isNewPiece('muda o fundo para azul'));
  assert.ok(!c.isNewPiece('deixa o texto maior'));
  assert.ok(!c.isNewPiece('coloca a logo nessa imagem'));
});

test('layouts de texto variam com o pedido e o estilo', () => {
  const L = require('../src/textLayouts');
  const seen = new Set();
  for (const m of ['post da pizzaria', 'post da loja de roupas', 'post da academia', 'post do mercado', 'arte da padaria', 'post da barbearia', 'post do pet shop']) {
    seen.add(L.chooseLayout({ texts: ['Oferta R$ 10,00'], message: m }).layout);
  }
  assert.ok(seen.size >= 2, `só ${[...seen]}`);
  assert.strictEqual(L.chooseLayout({ texts: ['x'], message: 'salão de beleza' }).look, 'elegante');
  for (const layout of ['band', 'top', 'tag', 'panel', 'frame']) {
    const svg = L.layoutSvg({ W: 1080, H: 1080, texts: ['Pizza grande R$ 49,90', '(11) 97777-1234'], hex: '#c62828', look: 'impacto', layout });
    assert.ok(svg.includes('97777-1234') && !/NaN|undefined/.test(svg), layout);
  }
});

test('logo: composição pedida pelo cliente e variação pelo nome', () => {
  const LM = require('../src/logoMaker');
  assert.strictEqual(LM.pickLogoLayout('logo horizontal da Linha Fácil', 'Linha Fácil'), 'horizontal');
  assert.strictEqual(LM.pickLogoLayout('logo em selo', 'X'), 'emblem');
  assert.strictEqual(LM.pickLogoLayout('só o nome', 'X'), 'wordmark');
  const set = new Set(['Doce Sabor Confeitaria', 'Auto Center Silva', 'Linha Fácil', 'Pizzaria Bella Napoli'].map((n) => LM.pickLogoLayout('logo', n)));
  assert.ok(set.size >= 3);
});

test('textos da peça: tema, nome, produto com preço, telefone', () => {
  const TC = require('../src/textCheck');
  const { extractTextTokens } = require('../src/llm');
  const m = 'faz um post para a padaria Pão Quente: pão francês R$ 12,90 o kg. WhatsApp (11) 95555-1212';
  assert.deepStrictEqual(TC.pieceTexts(extractTextTokens(m), m, 'Pão Quente'), ['Pão Quente', 'Pão francês R$ 12,90', '(11) 95555-1212']);
  const g = 'faz um post de bom dia para a Ótica Visão Clara';
  assert.deepStrictEqual(TC.pieceTexts(extractTextTokens(g), g, 'Ótica Visão Clara'), ['Bom dia!', 'Ótica Visão Clara']);
  const c = require('../src/contract');
  assert.ok(c.isNewPiece('post para o salão Studio Bela: escova progressiva R$ 120,00. WhatsApp (21) 98888-1111'));
});
