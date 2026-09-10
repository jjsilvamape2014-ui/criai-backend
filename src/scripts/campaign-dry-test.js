const http = require('http');
const path = require('path');

process.env.LLM_PROVIDER = 'groq';
process.env.LLM_API_KEY = 'gsk_dry_test';
process.env.LLM_MODEL = 'dry-test-model';

const PORT = 8793;
const llm = require(path.join(__dirname, '..', 'llm.js'));

const CANNED = {
  caption: '🛍️ Hamburgueria do Zé! Novo smash com bacon chegaram. Chame no WhatsApp!',
  cta: 'Chame no WhatsApp',
  hashtags: ['#hamburguer', '#smashburger', '#promocao'],
  plan: [
    'DIA 1 — Apresentação: smash com bacon (Imagem)',
    'DIA 2 — Prova social: cliente mordendo o lanche (Reels)',
    'DIA 3 — Bastidores: preparo da carne (Story)'
  ]
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(CANNED) } }] }));
  });
});

server.listen(PORT, async () => {
  process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}`;
  let allOk = true;
  const intent = { businessType: 'hamburgueria', product: 'smash com bacon', audience: 'jovens', emotion: 'gostoso e urbano', objective: 'divulgar', platform: 'instagram' };
  const t = await llm.campaignTexts(intent, 'divulgar minha hamburgueria, smash com bacon');
  const checks = {
    'legenda não vazia': !!t.caption && t.caption.length > 10,
    'CTA não vazio': !!t.cta,
    'hashtags 3+': (t.hashtags || []).length >= 3,
    'plano 3+ dias': (t.plan || []).length >= 3,
    'valores vêm da IA': t.caption.includes('smash')
  };
  Object.entries(checks).forEach(([k, ok]) => { if (!ok) allOk = false; console.log(`${ok ? '✓' : '✗'} campaignTexts — ${k}`); });

  const p = llm.buildCampaignPrompts(intent, 'divulgar minha hamburgueria, smash com bacon');
  const pChecks = {
    'post fala 1:1/QUADRADO': /QUADRADO|1:1/i.test(p.postPrompt),
    'story fala 9:16/VERTICAL': /9:16|VERTICAL/i.test(p.storyPrompt),
    'post menciona biz': p.postPrompt.includes('hamburgueria'),
    'textos em PT': (p.postPrompt + p.storyPrompt).includes('português')
  };
  Object.entries(pChecks).forEach(([k, ok]) => { if (!ok) allOk = false; console.log(`${ok ? '✓' : '✗'} buildCampaignPrompts — ${k}`); });

  server.close();
  console.log(allOk ? '\n✅ campanha dry OK' : '\n❌ campanha dry com falhas');
  process.exit(allOk ? 0 : 1);
});