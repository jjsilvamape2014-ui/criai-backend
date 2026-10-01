// Testes do contrato do pedido (CRIAI v2 adaptado). Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/contract');

// --- casos obrigatórios do pedido ---
test('1) imagem 1080x1350 para Instagram → tipo imagem', () => {
  assert.strictEqual(C.detectRequested('Crie uma imagem 1080x1350 para Instagram sobre black friday').tipo, 'imagem');
});
test('2) "Faça um anúncio" sem dados → precisa_clareza', () => {
  const r = C.precheck({ message: 'Faça um anúncio', knowsBusiness: false, hasImage: false });
  assert.strictEqual(r.status, 'precisa_clareza');
  assert.ok(r.duvidas.length >= 1);
});
test('3) roteiro de Reels 15s → tipo roteiro_video', () => {
  assert.strictEqual(C.detectRequested('Roteiro de Reels 15s para clínica odontológica').tipo, 'roteiro_video');
});
test('4) vídeo mas só legenda → pede confirmação', () => {
  const r = C.precheck({ message: 'Quero vídeo, mas me entregue só legenda', knowsBusiness: true, hasImage: false });
  assert.strictEqual(r.status, 'precisa_clareza');
});

// --- imagem nunca vira vídeo; vídeo nunca vira imagem/texto ---
test('enforce: pediu imagem, IA escolheu vídeo → image', () => {
  assert.deepStrictEqual(C.enforce('video', 'cria um post para instagram da promoção').action, 'image');
});
test('enforce: pediu vídeo, IA escolheu imagem → video', () => {
  assert.strictEqual(C.enforce('image', 'faz um vídeo da minha pizzaria').action, 'video');
});
test('enforce: pediu vídeo, IA só respondeu → video', () => {
  assert.strictEqual(C.enforce('answer', 'quero um reels da minha loja').action, 'video');
});
test('enforce: pediu roteiro, IA ia renderizar → write', () => {
  assert.strictEqual(C.enforce('video', 'roteiro de reels para minha clínica').action, 'write');
});
test('enforce: ação coerente não muda', () => {
  assert.strictEqual(C.enforce('image', 'cria uma arte para o feed').corrigido, false);
  assert.strictEqual(C.enforce('video', 'vídeo da JN Refrigeração').corrigido, false);
});

// --- insumo não é entrega ---
test('logo/foto como insumo de vídeo continuam vídeo', () => {
  assert.strictEqual(C.detectRequested('anima minha logo girando').tipo, 'video');
  assert.strictEqual(C.detectRequested('faz um vídeo com essa foto do produto').tipo, 'video');
  assert.strictEqual(C.detectRequested('vídeo da JN com legendas').tipo, 'video');
});
test('pedido com conteúdo não é bloqueado', () => {
  assert.strictEqual(C.precheck({ message: 'vídeo da minha pizzaria Forno Bom, entrega grátis', knowsBusiness: false, hasImage: false }), null);
});
test('pedido vazio com empresa conhecida segue', () => {
  assert.strictEqual(C.precheck({ message: 'faz um anúncio', knowsBusiness: true, hasImage: false }), null);
});

// --- JSON da entrega de texto ---
test('validateWrite rejeita roteiro sem cenas e aceita o correto', () => {
  assert.strictEqual(C.validateWrite({ entrega: { corpo: 'x', roteiro_cenas: [] } }, 'roteiro_video'), null);
  const ok = C.validateWrite({ entrega: { headline: 'H', corpo: '', cta: 'C', roteiro_cenas: [{ tempo: '0-3s', tela: 'A', fala: 'a' }, { tempo: '3-6s', tela: 'B', fala: 'b' }] }, validacao: { faltou: ['preço'] } }, 'roteiro_video');
  assert.strictEqual(ok.entrega.roteiro_cenas.length, 2);
  assert.deepStrictEqual(ok.validacao.faltou, ['preço']);
});
test('writeText tenta de novo quando o JSON vem inválido', async () => {
  let calls = 0;
  const fake = async () => (++calls === 1 ? 'não é json' : JSON.stringify({ entrega: { headline: 'Promo', corpo: 'Texto', cta: 'Peça já' } }));
  const w = await C.writeText({ message: 'legenda da promoção', tipo: 'copy', project: {}, callLLM: fake });
  assert.strictEqual(calls, 2);
  assert.strictEqual(w.entrega.headline, 'Promo');
});

// --- rodada 2 (bateria de 40 frases em produção) ---
test('comentário sobre o vídeo não vira vídeo novo', () => {
  assert.strictEqual(C.enforce('answer', 'o video ficou bom obrigado').action, 'answer');
  assert.strictEqual(C.enforce('answer', 'gostei do vídeo, valeu').action, 'answer');
});
test('pedido com verbo continua corrigido', () => {
  assert.strictEqual(C.enforce('answer', 'faz um vídeo da minha loja').action, 'video');
});
test('legenda para a foto anexada → texto', () => {
  assert.strictEqual(C.detectRequested('escreve a legenda para essa foto').tipo, 'copy');
  assert.strictEqual(C.detectRequested('tira o fundo dessa foto').tipo, 'imagem');
});
test('personagem falando detectado no contrato', () => {
  assert.strictEqual(C.detectSpeech('cria um video de apresentação, falando bom dia eu sou o delta', true).fala, 'Bom dia eu sou o delta.');
  assert.strictEqual(C.detectSpeech('vídeo falando sobre a empresa', true), null);
  assert.strictEqual(C.detectSpeech('faz ele falar oi', false), null);
});

test('"post de ..." sem verbo é pedido de imagem, não resposta', () => {
  const c = require('../src/contract');
  assert.strictEqual(c.enforce('answer', 'post de bom dia para a Ótica Visão Clara').action, 'image');
});

test('pergunta sobre Instagram continua sendo resposta, não imagem', () => {
  const c = require('../src/contract');
  assert.strictEqual(c.enforce('answer', 'quais horários são melhores para postar no Instagram?').action, 'answer');
});
