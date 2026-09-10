// Teste SECO do extractIntent: simula o LLM com resposta JSON pré-definida via
// servidor HTTP local (OpenAI-compatível), validando a regra "pergunte só se
// essencial" e os campos question/options/missing SEM gastar cota real.
const http = require('http');
const path = require('path');

process.env.LLM_PROVIDER = 'groq';
process.env.LLM_API_KEY = 'gsk_dry_test';
process.env.LLM_MODEL = 'dry-test-model';

const PORT = 8791;
const llm = require(path.join(__dirname, '..', 'llm.js'));

const CASES = [
  {
    label: 'vago → deve fazer UMA pergunta',
    user: 'Crie um anúncio para minha loja',
    canned: {
      can_take_over: true,
      intent: { objective: 'vender/divulgar', business_type: 'loja', product: '', audience: '', emotion: '', platform: 'instagram', visual_style: 'comercial' },
      confirmation: 'Entendi. Você quer um anúncio para divulgar a sua loja nas redes sociais.',
      direction: 'Vou montar uma composição comercial com destaque para a vitrine, cores da marca e um espaço reservado para a oferta.',
      question: 'O que você quer divulgar?',
      options: ['Um produto', 'A loja', 'Uma promoção'],
      missing: 'product'
    },
    expect: {
      canTakeOver: true,
      hasQuestion: true,
      optionsLen: 2,
      confirmationStartsWith: 'Entendi'
    }
  },
  {
    label: 'específico → NÃO deve perguntar',
    user: 'Crie um anúncio para minha loja de roupas femininas, divulgando vestidos de verão',
    canned: {
      can_take_over: true,
      intent: { objective: 'divulgar', business_type: 'loja de roupas femininas', product: 'vestidos de verão', audience: 'mulheres', emotion: 'verão, leveza', platform: 'instagram', visual_style: 'comercial' },
      confirmation: 'Entendi. Você quer divulgar os vestidos de verão da sua loja feminina no Instagram.',
      direction: 'Vou destacar os vestidos em um cenário ensolarado, com paleta de verão e o preço/condições em espaço reservado.',
      question: '',
      options: [],
      missing: ''
    },
    expect: {
      canTakeOver: true,
      hasQuestion: false,
      optionsLen: 0
    }
  },
  {
    label: 'imagem concreta → usuário é lei (sem pergunta)',
    user: 'uma mulher em uma cafeteria tomando café, luz da janela',
    canned: {
      can_take_over: false,
      intent: { objective: '', business_type: '', product: '', audience: '', emotion: 'aconchego', platform: '', visual_style: 'fotográfico' },
      confirmation: 'Entendi. Você quer uma fotografia de uma mulher em uma cafeteria tomando café com luz de janela.',
      direction: '',
      question: '',
      options: [],
      missing: ''
    },
    expect: {
      canTakeOver: false,
      hasQuestion: false,
      optionsLen: 0
    }
  }
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const user = (parsed.messages || []).map((m) => m.content).join(' ') || '';
      const found = [...CASES].sort((a, b) => b.user.length - a.user.length).find((c) => user.includes(c.user));
      const payload = found ? found.canned : CASES[0].canned;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'null' } }] }));
    }
  });
});

let allOk = true;
server.listen(PORT, async () => {
  process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}`;
  for (const c of CASES) {
    try {
      const r = await llm.extractIntent(c.user);
      const okQuestion = r.question ? r.question.length > 0 && r.question.length <= 80 : r.question === '';
      const checks = {
        'canTakeOver': r.canTakeOver === c.expect.canTakeOver,
        'pergunta (presente/ausente)': (!!r.question) === c.expect.hasQuestion,
        'options tamanho': (r.options || []).length >= c.expect.optionsLen,
        'confirmation começa com Entendi': (r.confirmation || '').startsWith('Entendi'),
        'question curta': okQuestion
      };
      const fail = Object.entries(checks).filter(([, ok]) => !ok);
      console.log(`${fail.length ? '✗' : '✓'} ${c.label}`);
      if (fail.length) {
        allOk = false;
        for (const [k] of fail) console.log(`    - falhou: ${k}`);
        console.log('    resposta:', JSON.stringify(r).slice(0, 300));
      } else if (c.expect.hasQuestion) {
        console.log(`    pergunta: "${r.question}" | options: ${JSON.stringify(r.options)}`);
      }
    } catch (e) {
      allOk = false;
      console.log(`✗ ${c.label} — erro: ${e.message}`);
    }
  }
  server.close();
  console.log(allOk ? '\n✅ extractIntent OK (3/3)' : '\n❌ extractIntent com falhas');
  process.exit(allOk ? 0 : 1);
});