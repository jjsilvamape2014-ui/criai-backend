const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/motion/styles');

test('estilo pelo ramo e pelo tom do pedido', () => {
  assert.strictEqual(S.pickStyle('vídeo para minha pizzaria, pizza grande R$ 49,90', {}).key, 'impacto');
  assert.strictEqual(S.pickStyle('anúncio do salão de beleza da Ana', {}).key, 'elegante');
  assert.strictEqual(S.pickStyle('vídeo da JN Refrigeração, instalação de ar-condicionado', {}).key, 'tecnologico');
  assert.strictEqual(S.pickStyle('promoção de setembro, mês do cliente', {}).key, 'impacto');
  assert.strictEqual(S.pickStyle('anúncio da minha empresa de limpeza', {}).key, 'moderno');
});

test('o cliente manda: estilo pedido vence o ramo, e o pedido mais recente vence', () => {
  assert.strictEqual(S.pickStyle('vídeo da padaria estilo elegante', {}).key, 'elegante');
  assert.strictEqual(S.pickStyle('vídeo da loja estilo impacto. Ajuste pedido pelo cliente no vídeo anterior: estilo tecnológico', {}).key, 'tecnologico');
});

test('sugestão do diretor só quando nada no pedido decide', () => {
  assert.strictEqual(S.pickStyle('anúncio da minha empresa', {}, 'elegante').key, 'elegante');
  assert.strictEqual(S.pickStyle('anúncio da pizzaria', {}, 'elegante').key, 'impacto');
  assert.strictEqual(S.pickStyle('anúncio', {}, 'qualquer').key, 'moderno');
});

test('troca de estilo de um vídeo pronto', () => {
  assert.ok(S.isStyleChange('estilo elegante'));
  assert.ok(S.isStyleChange('deixa mais chamativo'));
  assert.ok(!S.isStyleChange('muda a cor para verde'));
});

test('fonte trocada no SVG e peso único para Anton', () => {
  const svg = '<text font-family="Poppins, DejaVu Sans, sans-serif" font-weight="800">A</text>';
  const out = S.applyFont(svg, S.get('impacto'), 'Poppins, DejaVu Sans, sans-serif');
  assert.match(out, /font-family="Anton, Poppins/);
  assert.match(out, /font-weight="400"/);
  assert.strictEqual(S.applyFont(svg, S.get('moderno'), 'Poppins, DejaVu Sans, sans-serif'), svg);
});

test('todas as transições geram SVG válido nas pontas', () => {
  for (const k of ['fade', 'slideUp', 'slideLeft', 'push', 'zoomPunch', 'flash', 'wipe', 'iris']) {
    for (const p of [0, 0.5, 1]) {
      const t = S.transition(k, p, { Wd: 1080, Hd: 1920, id: 'x', pal: { primary: '#123456', soft: '#abcdef' } });
      assert.ok(t.inOpen.includes('<g') && !/NaN/.test(t.inOpen + t.outOpen + t.overlay), `${k} ${p}`);
    }
  }
});
