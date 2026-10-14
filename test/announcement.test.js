// Comunicado longo colado vira post com pouco texto. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/llm');

const AVISO = `🚀 Lembrete importante, equipe XYZ! 💜💙

Os benefícios MediQuo (Telemedicina) e TotalPass (Bem-estar) já estão disponíveis para todos vocês! 🎉

👉 Não deixem de aproveitar:
🏥 Consultas online 24h com médicos e especialistas
🏋️ Acesso a milhares de academias, treinos e conteúdos de saúde mental

criar uma imagem`;

test('comunicado longo é detectado; pedido curto ou com aspas não', () => {
  assert.strictEqual(L.isLongAnnouncement(AVISO), true);
  assert.strictEqual(L.isLongAnnouncement('post da pizzaria com promoção de terça'), false);
  assert.strictEqual(L.isLongAnnouncement(AVISO + ' com o texto "Cuide-se"'), false);
});
test('sem IA, o título sai da 1ª linha, curto e sem emoji', () => {
  const t = L.fallbackAnnouncementTexts(AVISO);
  assert.ok(t.length >= 1 && t.length <= 2);
  assert.strictEqual(t[0], 'Lembrete importante, equipe XYZ');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t.join(' ')));
});
test('sem chave de IA, condenseAnnouncement ainda devolve pedido com textos entre aspas', async () => {
  const old = process.env.LLM_API_KEY; delete process.env.LLM_API_KEY;
  const c = await L.condenseAnnouncement(AVISO, 'XYZ');
  assert.ok(c && c.texts.length >= 1);
  assert.match(c.request, /"Lembrete importante, equipe XYZ"/);
  if (old) process.env.LLM_API_KEY = old;
});

test('texto escrito por código não passa da borda: frases demais saem do fim', () => {
  const L = require('../src/textLayouts');
  const svg = L.layoutSvg({ W: 1024, H: 1024, texts: ['XYZ', 'Benefícios MediQuo e TotalPass', 'Consultas 24h e academias disponíveis', 'Acesse agora pelo RH e comece a usar hoje mesmo'], layout: 'band' });
  assert.ok(svg.includes('Benefícios MediQuo e TotalPass'));
  assert.ok(!svg.includes('Acesse agora pelo RH e comece a usar hoje mesmo'));
});
