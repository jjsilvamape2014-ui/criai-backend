/*
  RETESTE DO ANÚNCIO FALADO — de ponta a ponta, nos MESMOS caminhos da produção:

    1) A "fala" do usuário entra como texto (ex: transcrita pelo microfone).
    2) extractIntent: pedido concreto de anúncio com preço → NÃO deve fazer pergunta.
    3) enhanceImagePrompt (plano obrigatório/nao_alterar + render) → prompt deve
       carregar o preço e a frase VERBATIM (com acentos).
    4) Escolha de modelo idêntica à produção: looksLikeTextPiece → ideogram.
    5) Geração REAL em fal.ai (ideogram) — a frase impressa na imagem.
    6) Auditoria visual REAL via Qwen2.5-VL: o preço e a frase estão legíveis.

  O LLM é simulado localmente (mesma técnica dos dry-tests: mock OpenAI-compatível),
  porque a chave .env local (Gemini) está em cota 429 — em produção é o Groq real.
  Geração e auditoria são REAIS e gastam créditos fal. Sem custo? rode com --plan.
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

process.env.LLM_PROVIDER = 'groq';
process.env.LLM_API_KEY = 'gsk_spoken_ad_test';
process.env.LLM_MODEL = 'spoken-ad-test-model';

const PORT = 8792;
const llm = require(path.join(__dirname, '..', 'llm.js'));
const gen = require(path.join(__dirname, '..', 'routes', 'generate.js'));
const vision = require(path.join(__dirname, '..', 'vision.js'));

// O que o usuário FALOU (transcrição típica do microfone)
const SPOKEN = 'hamburguer artesanal custa R$ 29,90, peça ja hoje';

// Plano que o "cérebro" (Groq em produção) extrairia desta fala.
const CANNED_PLAN = {
  obrigatorio: ['hambúrguer artesanal', 'o preço R$ 29,90'],
  nao_alterar: ['R$ 29,90', 'Peça já hoje'],
  pode_interpretar: ['fundo', 'cores', 'enquadramento'],
  estilo: 'post comercial de hamburgueria, apetitoso'
};

const CANNED_INTENT = {
  can_take_over: true,
  intent: {
    objective: 'vender/divulgar',
    business_type: 'hamburgueria',
    product: 'hambúrguer artesanal',
    audience: 'público geral',
    emotion: 'apetite, urgência',
    platform: 'instagram',
    visual_style: 'comercial'
  },
  confirmation: 'Entendi. Você quer um anúncio da hamburgueria com o hambúrguer artesanal, o preço e um chamada para comprar agora.',
  direction: 'Vou montar um post comercial com o hambúrguer em destaque, fundo vermelho escuro e o preço e a frase impressos com destaque.',
  question: '',
  options: [],
  missing: ''
};

const RENDER_PROMPT =
  'Announcement poster for an artisanal burger joint, juicy burger as the hero, ' +
  'dark red background, bold printed text verbatim: "R$ 29,90" and "Peça já hoje!", ' +
  'commercial offer style for social media.\n' +
  '###CONF:Entendi. Criei seu anúncio de hambúrguer com o preço e a frase que você falou.';

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
    else if (content.includes('You are the planning brain of an AI image studio')) payload = JSON.stringify(CANNED_PLAN);
    else if (content.includes('Render ONE detailed English image prompt')) payload = RENDER_PROMPT;
    else payload = JSON.stringify(CANNED_PLAN);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
  });
});

const OUT_DIR = path.join(__dirname, 'spoken-ad-out');
const REPORT_PATH = path.join(__dirname, 'spoken-ad-report.json');

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
  console.log(`RETESTE DO ANÚNCIO FALADO — ${planOnly ? 'modo PLANO (sem custo)' : 'ponta a ponta (mock Groq + geração real + auditoria real)'}`);
  console.log(`Fala simulada: "${SPOKEN}"\n`);

  // 1) Intenção: pedido concreto (preço + frase) → NÃO deve perguntar nada.
  const intent = await llm.extractIntent(SPOKEN);
  ok('extractIntent não pergunta para fala com preço + frase', !!intent && intent.question === '', intent ? JSON.stringify(intent.question) : 'null');
  const biz = (intent && intent.intent && intent.intent.businessType) || '';
  ok('negócio extraído da fala', !!biz, biz || '(vazio)');
  ok('canTakeOver ativo (direção comercial)', !!intent && intent.canTakeOver);

  // 2) Render do prompt: preço e frase devem sobreviver VERBATIM.
  const enh = await gen.enhanceImagePrompt(SPOKEN);
  const renderPrompt = enh.prompt || '';
  ok('prompt renderizado preenchido', renderPrompt.length > 20, renderPrompt.slice(0, 60) + '…');
  ok('prompt renderizado contém "R$ 29,90"', renderPrompt.includes('R$ 29,90'));
  ok('prompt renderizado contém "Peça já hoje"', /Peça já hoje/i.test(renderPrompt));
  ok('confirmação em português gerada (###CONF)', !!enh.reply && /^Entendi\./i.test(enh.reply), enh.reply || '');
  const textsRequired = (((enh.required || {}).texts) || []);
  console.log(`   textos exigidos para auditoria: ${JSON.stringify(textsRequired)}`);

  // 3) Modelo: mesma decisão da produção (anúncio com texto → ideogram).
  const model = gen.looksLikeTextPiece(SPOKEN) ? 'ideogram' : 'flux2pro';
  ok('modelo escolhido = ideogram (texto na peça)', model === 'ideogram', `decidido: ${model}`);

  if (planOnly) {
    finish(model);
    return;
  }

  console.log(`\nGerando com ${model} (mesma decisão da produção)…`);

  const url = await gen.generateImageFromProviders(renderPrompt, { model, width: 1024, height: 1024 });
  if (!url) {
    ok('imagem gerada (fal/ideogram)', false, 'nenhuma URL');
    finish(model);
    return;
  }
  ok('imagem gerada (fal/ideogram)', true, url.slice(0, 80) + '…');

  const saved = await saveImage(url, 'anuncio-falado');
  console.log(`   salvo em: ${saved || 'não salvo'}`);

  // 4) Auditoria real: o que foi falado está IMPRESSO e legível?
  const textAudit = await vision.checkImageText(url, ['R$ 29,90', 'Peça já hoje']);
  ok('texto IMPRESSO "R$ 29,90" verificado por visão', textAudit.ok === true, textAudit.ok ? '' : (textAudit.missing || []).join('; '));
  ok('texto IMPRESSO "Peça já hoje" verificado por visão', textAudit.ok === true, textAudit.ok ? '' : (textAudit.missing || []).join('; '));

  const strict = await vision.checkImageStrict(url, [
    'é um post de hamburgueria (hambúrguer é o elemento central)',
    'o preço "R$ 29,90" está escrito corretamente na imagem',
    'a frase "Peça já hoje" está escrita corretamente na imagem'
  ]);
  const strictMissing = (strict && strict.missing) || [];
  ok('auditoria estrita (3 afirmações)', strict && strict.ok === true && strictMissing.length === 0, strictMissing.length ? strictMissing.join('; ') : '');

  finish(model);
}

function finish(model) {
  const allPass = checks.every((c) => c.pass);
  const report = {
    runAt: new Date().toISOString(),
    spoken: SPOKEN,
    planOnly: process.argv.includes('--plan'),
    model,
    checks,
    allPass,
    note: 'Anúncio Falado: fala → intenção (sem pergunta) → prompt com preço/frase verbatim → ideogram real → texto auditado por visão (Qwen2.5-VL). LLM interpretativo simulado (Groq em produção); geração e auditoria REAIS.'
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n${allPass ? '✅ ANÚNCIO FALADO OK — fala virou imagem com o texto certo' : '❌ ANÚNCIO FALADO COM FALHAS'}`);
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