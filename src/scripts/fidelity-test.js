/*
  TESTE DO CÉREBRO — mede a FIDELIDADE da Criativa AI ao pedido do usuário.

  Biblioteca de prompts difíceis + auditoria visual automática:
    - interpretar (plano obrigatório/nao_alterar/estilo)
    - gerar de verdade (fala.ai)
    - conferir com visão se os elementos obrigatórios e textos apareceram
    - reportar fidelidade em % por caso e geral

  Uso:
    node src/scripts/fidelity-test.js            # gera os 3 primeiros casos + audita
    node src/scripts/fidelity-test.js --all      # roda a biblioteca inteira (custa créditos fal)
    node src/scripts/fidelity-test.js --dry      # SÓ planeja (sem gerar, sem custo) — ideal p/ checar interpretação
    node src/scripts/fidelity-test.js --limit 5  # roda só os 5 primeiros

  Resultado: src/scripts/fidelity-report.json (e imagens em src/scripts/fidelity-out/).
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const gen = require('../routes/generate');
const vision = require('../vision');

// ── BIBLIOTECA DE PROMPTS DIFÍCEIS ────────────────────────────────────────────────
// required = elementos que DEVEM aparecer (a visão confere 1 a 1 — mesmo audit do loop real).
// texts = textos exatos que DEVEM estar impressos (legíveis e corretos).
// checks = afirmações ESTRITAS (contagem exata, posição esquerda/direita, cores
//          dominantes, ausência) validadas pela auditoria estrita. Qualquer parte
//          errada derruba a afirmação — é o que torna o % uma métrica real.
const LIBRARY = [
  {
    id: 'count-two-phones',
    prompt: 'Um homem segurando dois celulares, um azul na mão esquerda e um preto na direita.',
    required: ['um homem', 'dois celulares', 'um celular azul', 'um celular preto'],
    texts: [],
    checks: [
      'existem exatamente 2 celulares na imagem, nenhum a mais',
      'há um celular azul e um celular preto',
      'o celular azul está na mão esquerda do homem',
      'o celular preto está na mão direita do homem'
    ]
  },
  {
    id: 'woman-details',
    prompt: 'Mulher de cabelo preto usando vestido vermelho, segurando uma bolsa azul, em frente a uma loja.',
    required: ['mulher', 'cabelo preto', 'vestido vermelho', 'bolsa azul', 'loja'],
    texts: [],
    checks: [
      'a mulher tem cabelo preto',
      'o vestido da mulher é vermelho',
      'a mulher segura uma bolsa azul',
      'há uma loja ao fundo',
      'a mulher está de pé em frente à loja'
    ]
  },
  {
    id: 'car-by-house',
    prompt: 'Uma Ferrari vermelha estacionada na frente de uma casa branca de dois andares, ao pôr do sol.',
    required: ['carro vermelho', 'casa branca', 'dois andares'],
    texts: [],
    checks: [
      'há um carro esportivo vermelho em destaque',
      'o carro está estacionado na frente da casa',
      'a casa é branca e tem dois andares (janelas em dois níveis)',
      'o cenário está ao pôr do sol (tom alaranjado/dourado)'
    ]
  },
  {
    id: 'two-cats',
    prompt: 'Um gato preto e um gato branco sentados lado a lado em um sofá.',
    required: ['um gato preto', 'um gato branco', 'sofá'],
    texts: [],
    checks: [
      'existem exatamente 2 gatos na imagem',
      'um gato é preto e o outro é branco',
      'os gatos estão lado a lado (um ao lado do outro)',
      'os dois gatos estão sobre um sofá'
    ]
  },
  {
    id: 'boy-balloon',
    prompt: 'Retrato de um menino de camisa amarela segurando um balão azul, fundo de parque.',
    required: ['menino', 'camisa amarela', 'balão azul', 'parque'],
    texts: [],
    checks: [
      'o menino usa camisa amarela',
      'o menino segura um balão azul',
      'o balão é azul e fica acima da cabeça do menino',
      'o fundo é um parque (árvores/gramado)'
    ]
  },
  {
    id: 'burger-price',
    prompt: 'Post quadrado de hamburgueria com o preço R$ 29,90 e a frase Peça já hoje, fundo vermelho escuro.',
    required: ['hambúrguer', 'fundo vermelho escuro'],
    texts: ['R$ 29,90', 'Peça já hoje'],
    checks: [
      'o fundo é vermelho escuro (tom vinho/terracota)',
      'é um post quadrado com o hambúrguer como elemento central',
      'o texto "R$ 29,90" está impresso corretamente',
      'a frase "Peça já hoje" está impressa corretamente'
    ]
  },
  {
    id: 'pizza-word',
    prompt: 'Anúncio de pizza com o texto Pizza do Chefe em destaque sobre fundo de madeira rústica.',
    required: ['pizza', 'fundo de madeira'],
    texts: ['Pizza do Chefe'],
    checks: [
      'o fundo é de madeira rústica',
      'há uma pizza em destaque no anúncio',
      'o texto "Pizza do Chefe" está impresso corretamente'
    ]
  },
  {
    id: 'beach-no-people',
    prompt: 'Praia tropical ao entardecer com guarda-sóis vermelhos e um barco branco ao fundo, sem pessoas.',
    required: ['praia tropical', 'guarda-sóis vermelhos', 'barco branco'],
    texts: [],
    checks: [
      'há guarda-sóis vermelhos na imagem',
      'há um barco branco ao fundo',
      'NÃO há nenhuma pessoa na imagem',
      'o cenário é de praia ao entardecer'
    ]
  },
  {
    id: 'acai-bowl',
    prompt: 'Copo de açaí cremoso com cobertura de banana em rodelas, granola e morangos, em uma mesa de madeira.',
    required: ['açaí', 'banana em rodelas', 'granola', 'morangos', 'mesa de madeira'],
    texts: [],
    checks: [
      'há rodelas de banana sobre o açaí',
      'há granola no copo',
      'há morangos na cobertura',
      'o copo/tigela é de açaí cremoso',
      'a superfície embaixo é de madeira'
    ]
  },
  {
    id: 'dog-glasses',
    prompt: 'Cachorro golden retriever usando óculos de sol, sentado em uma poltrona estilo anos 70.',
    required: ['cachorro', 'golden retriever', 'óculos de sol', 'poltrona'],
    texts: [],
    checks: [
      'o cachorro tem pelagem dourada (golden retriever)',
      'o cachorro usa óculos de sol',
      'o cachorro está sentado',
      'a poltrona tem estilo retrô anos 70'
    ]
  }
];

const OUT_DIR = path.join(__dirname, 'fidelity-out');
const REPORT_PATH = path.join(__dirname, 'fidelity-report.json');

function parseArgs(argv) {
  const opts = { dry: false, all: false, limit: 3 };
  argv.forEach((a) => {
    if (a === '--dry') opts.dry = true;
    if (a === '--all') { opts.all = true; opts.limit = Infinity; }
    if (a.startsWith('--limit')) opts.limit = Number(a.split('=')[1] || argv[argv.indexOf(a) + 1]) || 3;
  });
  return opts;
}

async function auditImage(url, required, texts, checks) {
  const out = { elementPass: null, elementMissing: [], textPass: null, textMissing: '', strictPass: null, strictMissing: [] };
  if (required && required.length) {
    const r = await vision.checkImageElements(url, required);
    if (r) {
      out.elementMissing = r.missing || [];
      out.elementPass = r.ok === true && out.elementMissing.length === 0;
    }
  }
  if (texts && texts.length) {
    const t = await vision.checkImageText(url, texts);
    if (t) {
      out.textMissing = t.missing || '';
      out.textPass = t.ok === true;
    }
  }
  if (checks && checks.length) {
    const s = await vision.checkImageStrict(url, checks);
    if (s) {
      out.strictMissing = s.missing || [];
      out.strictPass = s.ok === true && out.strictMissing.length === 0;
    }
  }
  return out;
}

async function saveImage(url, id) {
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    let buf = null;
    if (typeof url === 'string' && url.startsWith('data:')) {
      const b64 = url.split(',')[1];
      buf = b64 ? Buffer.from(b64, 'base64') : null;
    } else if (/^https?:\/\//.test(url || '')) {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      buf = res.data;
    }
    if (!buf) return null;
    const file = path.join(OUT_DIR, `${id}.png`);
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    return null;
  }
}

async function runCase(c, opts) {
  console.log('\n──────────');
  console.log(`Caso: ${c.id} — ${c.prompt}`);

  // 1) Cérebro interpreta e renderiza o prompt
  const enh = await gen.enhanceImagePrompt(c.prompt);
  const elements = (enh.required && enh.required.elements) || [];
  const texts = (enh.required && enh.required.texts) || [];
  console.log(`   plano obrigatório: ${elements.length ? elements.join(' | ') : '(nenhum)'}`);
  console.log(`   textos: ${texts.length ? texts.join(' | ') : '(nenhum)'}`);
  console.log(`   estrito (${(c.checks || []).length} afirmações): ${(c.checks || []).join(' | ').slice(0, 120)}…`);
  console.log(`   prompt renderizado: ${(enh.prompt || '').slice(0, 160)}…`);

  if (opts.dry) {
    return {
      id: c.id, prompt: c.prompt, dry: true, elements, texts,
      generatedPrompt: enh.prompt || '', model: null,
      audit: { elementPass: null, elementMissing: [], textPass: null, textMissing: '', strictPass: null, strictMissing: [] },
      imageSaved: null, score: null
    };
  }

  // 2) Modelo (mesma decisão da produção)
  const model = !gen.looksLikeTextPiece(c.prompt) ? 'flux2pro' : 'ideogram';
  console.log(`   gerando com ${model}…`);
  const url = await gen.generateImageFromProviders(enh.prompt || c.prompt, {
    model, width: 1024, height: 1024
  });
  if (!url) throw new Error('nenhuma imagem gerada');

  const imageSaved = await saveImage(url, c.id);
  console.log(`   salvo em: ${imageSaved || 'não salvo'}`);

  // 3) Auditoria visual: elementos (loop real) + textos + estrito (métrica dura)
  const audit = await auditImage(url, c.required, c.texts, c.checks);
  const elScore = c.required.length ? (c.required.length - audit.elementMissing.length) / c.required.length : 1;
  const txScore = c.texts.length ? (audit.textPass ? 1 : 0) : 1;
  const stScore = c.checks && c.checks.length ? (c.checks.length - audit.strictMissing.length) / c.checks.length : 1;
  const score = Math.round(((elScore * 0.3) + (txScore * 0.3) + (stScore * 0.4)) * 100);
  console.log(`   elementos faltando: ${audit.elementMissing.length ? audit.elementMissing.join(', ') : 'nenhum'}`);
  if (c.texts.length) console.log(`   texto: ${audit.textPass ? 'OK' : 'faltando: ' + audit.textMissing}`);
  console.log(`   estrito: ${audit.strictMissing.length ? '\n      ✗ ' + audit.strictMissing.join('\n      ✗ ') : 'todas as afirmações OK'}`);
  console.log(`   FIDELIDADE DO CASO: ${score}%`);

  return { id: c.id, prompt: c.prompt, dry: false, elements, texts, generatedPrompt: enh.prompt || '', model, audit, imageSaved, score };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const batch = LIBRARY.slice(0, opts.limit);
  const n = Math.min(batch.length, opts.limit);

  if (!process.env.FAL_KEY) {
    console.error('Sem FAL_KEY no .env — impossível gerar. (Modo --dry funciona sem chave.)');
    process.exit(1);
  }

  console.log(`TESTE DO CÉREBRO — ${n} caso(s) · ${opts.dry ? 'modo DRY (sem custo)' : 'geração REAL (gasta créditos fal)'}`);
  console.log('· mede: interpretação + geração + auditoria visual (fidelidade ao pedido).\n');

  const results = [];
  try {
    for (const c of batch) results.push(await runCase(c, opts));
  } catch (e) {
    console.error('\nFalhou no meio do teste:', e.message);
  }

  const scored = results.filter((r) => r.score !== null);
  const overall = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
    : null;

  const report = {
    runAt: new Date().toISOString(),
    dry: !!opts.dry,
    cases: n,
    generated: scored.length,
    overallFidelity: overall,
    results,
    note: 'overallFidelity = 30% elementos + 30% textos + 40% auditoria ESTRITA (contagem exata, posição esquerda/direita, cores, ausência) via Qwen2.5-VL.'
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n──────────────────────────────`);
  if (overall !== null) {
    console.log(`FIDELIDADE DA CRIATIVA AI: ${overall}% (${scored.length} caso(s) com imagem)`);
    console.log(`Relatório: ${REPORT_PATH}`);
    if (!opts.dry) console.log('Imagens: ' + OUT_DIR);
  } else {
    console.log('Modo dry — nenhuma fidelidade medida (só interpretação). Rode sem --dry para gerar.');
  }
}

main().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});