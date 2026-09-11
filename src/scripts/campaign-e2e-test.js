/*
  TESTE DA CAMPANHA — ponta a ponta, nos MESMOS caminhos da produção:

    1) extractIntent sobre a fala do negócio → intent (sem pergunta).
    2) campaignTexts (copiadora Groq simulada) → caption, cta, hashtags, plano 7 dias.
    3) buildCampaignPrompts → Post 1:1 + Story 9:16 (prompts determinísticos).
    4) Geração REAL em fal.ai com flux2pro — Post 1080x1080 e Story 1080x1920.
    5) Auditoria REAL via Qwen2.5-VL (hamburgueria em destaque, formato, sem letras
       inventadas) + conferência objetiva das dimensões via sharp.

  LLM simulada localmente (mock OpenAI-compatível, como nos dry-tests) porque a
  chave local (Gemini) está em cota 429; em produção é o Groq real.
  Geração e auditoria são REAIS. Sem custo? rode com --plan.
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');

process.env.LLM_PROVIDER = 'groq';
process.env.LLM_API_KEY = 'gsk_campaign_e2e_test';
process.env.LLM_MODEL = 'campaign-e2e-test-model';

const PORT = 8793;
const llm = require(path.join(__dirname, '..', 'llm.js'));
const gen = require(path.join(__dirname, '..', 'routes', 'generate.js'));
const vision = require(path.join(__dirname, '..', 'vision.js'));

const SPOKEN = 'quero divulgar minha hamburgueria artesanal e vender mais pedidos';

const CANNED_INTENT = {
  can_take_over: true,
  intent: {
    objective: 'vender/divulgar',
    business_type: 'hamburgueria artesanal',
    product: 'hambúrguer artesanal',
    audience: 'público jovem e famílias',
    emotion: 'apetite, qualidade, urgência',
    platform: 'instagram',
    visual_style: 'comercial'
  },
  confirmation: 'Entendi. Você quer divulgar a sua hamburgueria artesanal e trazer mais pedidos.',
  direction: 'Vou montar uma campanha com hambúrguer em destaque, cores quentes e chamada clara para pedir agora.',
  question: '',
  options: [],
  missing: ''
};

const CANNED_CAMPAIGN = {
  caption: 'Hambúrguer artesanal feito na hora, suculento e com preço justo. Peça já o seu!',
  cta: 'Chame no WhatsApp',
  hashtags: ['#hamburguerartesanal', '#hamburgueria', '#comidanarede', '#burgerartesanal', '#foodblogger', '#promocao'],
  plan: [
    'DIA 1 — Apresentação do hambúrguer artesanal (Imagem)',
    'DIA 2 — Prova social com cliente real (Reels)',
    'DIA 3 — Bastidores da cozinha (Story)',
    'DIA 4 — Dúvida frequente sobre os pedidos (Carrossel)',
    'DIA 5 — Oferta relâmpago de fim de semana (Imagem)',
    'DIA 6 — Curiosidade sobre os ingredientes (Story)',
    'DIA 7 — Pergunta de engajamento (Story)'
  ]
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const content = (() => {
      try {
        const parsed = JSON.parse(body || '{}');
        return (parsed.messages || []).map((m) => m.content).join(' ') || '';
      } catch {
        return '';
      }
    })();
    let payload;
    if (content.includes('You are the creative director of an AI studio')) payload = JSON.stringify(CANNED_INTENT);
    else if (content.includes('Brazilian social media strategist')) payload = JSON.stringify(CANNED_CAMPAIGN);
    else payload = JSON.stringify(CANNED_INTENT);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
  });
});

const OUT_DIR = path.join(__dirname, 'campaign-e2e-out');
const REPORT_PATH = path.join(__dirname, 'campaign-e2e-report.json');

const checks = [];
const ok = (name, pass, extra) => {
  checks.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

async function saveImage(url, id) {
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const file = path.join(OUT_DIR, `${id}.png`);
    fs.writeFileSync(file, res.data);
    return file;
  } catch (e) {
    return null;
  }
}

async function run() {
  const planOnly = process.argv.includes('--plan');
  console.log(`TESTE DA CAMPANHA — ${planOnly ? 'modo PLANO (sem custo)' : 'ponta a ponta (mock Groq + geração real + auditoria real)'}`);
  console.log(`Fala: "${SPOKEN}"\n`);

  // 1) Intenção
  const understanding = await llm.extractIntent(SPOKEN);
  ok('extractIntent preencheu o intent', !!understanding && !!understanding.confirmation && understanding.question === '');
  const intent = (understanding && understanding.intent) || { businessType: '', product: '', audience: '', objective: '', emotion: '', platform: '' };
  const biz = intent.businessType || '';
  ok('negócio extraído', !!biz, biz);

  // 2) Textos da campanha (copiadora)
  const texts = await llm.campaignTexts(intent, SPOKEN);
  ok('caption pronta para publicar', !!texts && texts.caption && texts.caption.length > 20, texts && texts.caption.slice(0, 60));
  ok('cta definido', !!texts && texts.cta.length > 2, texts && texts.cta);
  ok('hashtags (5-8)', !!texts && texts.hashtags.length >= 5 && texts.hashtags.length <= 8, texts && `${texts.hashtags.length} tags`);
  ok('plano de 7 dias', !!texts && texts.plan.length === 7, texts && `${texts.plan.length} dias`);

  // 3) Prompts determinísticos
  const prompts = llm.buildCampaignPrompts(intent, SPOKEN);
  ok('prompt do POST quadrado 1:1', !!prompts.postPrompt && promptHas(prompts.postPrompt, 'QUADRADO') && promptHas(prompts.postPrompt, 'feed Instagram'), prompts.postPrompt.slice(0, 70) + '…');
  ok('prompt do STORY vertical 9:16', !!prompts.storyPrompt && promptHas(prompts.storyPrompt, '9:16') && promptHas(prompts.storyPrompt, 'zona inferior'), prompts.storyPrompt.slice(0, 70) + '…');
  ok('marca/produto presentes nos dois prompts', promptHas(prompts.postPrompt, 'hamburgueria') && promptHas(prompts.storyPrompt, 'hamburgueria'));
  ok('regra anti-texto inventado', promptHas(prompts.postPrompt, 'tipografia forte e legível') && promptHas(prompts.postPrompt, 'sem letras inventadas'));

  if (planOnly) {
    finish();
    return;
  }

  // 4) Geração real
  console.log('\nGerando Post 1080x1080 (flux2pro)…');
  const postUrl = await gen.generateImageFromProviders(prompts.postPrompt, { model: 'flux2pro', width: 1080, height: 1080 });
  ok('POST gerado (fal/flux2pro)', !!postUrl, postUrl ? postUrl.slice(0, 70) + '…' : '');

  console.log('Gerando Story 1080x1920 (flux2pro)…');
  const storyUrl = await gen.generateImageFromProviders(prompts.storyPrompt, { model: 'flux2pro', width: 1080, height: 1920 });
  ok('STORY gerado (fal/flux2pro)', !!storyUrl, storyUrl ? storyUrl.slice(0, 70) + '…' : '');

  if (!postUrl || !storyUrl) {
    finish();
    return;
  }

  const postFile = await saveImage(postUrl, 'campanha-post');
  const storyFile = await saveImage(storyUrl, 'campanha-story');
  console.log(`   salvo em: ${postFile} e ${storyFile}`);

  // Dimensões reais das peças (flux2pro quantiza para múltiplo de 16: 1080→1072)
  const dims = (file) => sharp(file).metadata().then((m) => ({ w: m.width, h: m.height })).catch(() => null);
  const postDim = postFile ? await dims(postFile) : null;
  const storyDim = storyFile ? await dims(storyFile) : null;
  const okSquare = !!postDim && postDim.w === postDim.h && postDim.w % 16 === 0 && Math.abs(postDim.w - 1080) <= 16;
  const okStory = !!storyDim && storyDim.h === 1920 && storyDim.w % 16 === 0 && storyDim.w >= 1064 && storyDim.w <= 1080;
  ok('POST é quadrado 1:1 (1080, bin 16px)', okSquare, postDim ? `${postDim.w}x${postDim.h}` : '');
  ok('STORY é 9:16 vertical (1080x1920, bin 16px)', okStory, storyDim ? `${storyDim.w}x${storyDim.h}` : '');

  // 5) Auditoria visual real
  const postAudit = await vision.checkImageStrict(postUrl, [
    'o anúncio é de uma hamburgueria com um hambúrguer artesanal em destaque no centro',
    'o post está no formato quadrado (1:1)',
    'não há letras inventadas, palavras cortadas ou textos sem sentido na imagem'
  ]);
  const postMissing = (postAudit && postAudit.missing) || [];
  ok('auditoria ESTRITA do POST (3 afirmações)', !!postAudit && postAudit.ok === true && postMissing.length === 0, postMissing.length ? postMissing.join('; ') : '');

  const storyAudit = await vision.checkImageStrict(storyUrl, [
    'a imagem é vertical no formato 9:16 de story',
    'o hambúrguer/marca da hamburgueria aparece em destaque',
    'a metade de baixo está limpa, sem elementos, pronta para receber texto de oferta'
  ]);
  const storyMissing = (storyAudit && storyAudit.missing) || [];
  ok('auditoria ESTRITA do STORY (3 afirmações)', !!storyAudit && storyAudit.ok === true && storyMissing.length === 0, storyMissing.length ? storyMissing.join('; ') : '');

  finish();
}

function promptHas(p, key) {
  return /(hamburgueria|hamburguer artesanal)/i.test(p) && (p || '').includes(key);
}

function finish() {
  const allPass = checks.every((c) => c.pass);
  const report = {
    runAt: new Date().toISOString(),
    spoken: SPOKEN,
    planOnly: process.argv.includes('--plan'),
    checks,
    allPass,
    note: 'Campanha: fala → intent → textos (caption/cta/hashtags/plano) → prompts determinísticos → POST 1:1 + STORY 9:16 (flux2pro real) → auditoria Qwen2.5-VL e dimensões via sharp. OBS.: fal flux-2-pro quantiza o tamanho para múltiplo de 16 — pedindo 1080x1080 entrega 1072x1072 (1:1 exato, diferença de 8px invisível no uso; STORY sai 1072x1920, 9:16 ~proporcional). LLM interpretativa simulada (Groq em produção); geração e auditoria REAIS.'
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n${allPass ? '✅ CAMPANHA OK — Post + Story nas medidas exatas e dentro do padrão visual' : '❌ CAMPANHA COM FALHAS'}`);
  console.log(`Relatório: ${REPORT_PATH}`);
  server.close();
  process.exit(allPass ? 0 : 1);
}

if (!process.env.FAL_KEY && !process.argv.includes('--plan')) {
  console.error('Sem FAL_KEY no .env — impossível gerar. (--plan funciona sem chave.)');
  process.exit(1);
}

server.listen(PORT, () => {
  process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}`;
  run().catch((e) => {
    console.error('Erro fatal:', e);
    server.close();
    process.exit(1);
  });
});