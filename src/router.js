// 🧭 ROTEADOR do Cérebro: a IA entende a mensagem ANTES de agir.
//
// As regras por palavra-chave erravam feio: com uma imagem anexada, qualquer frase
// virava "editar a imagem" (até "você não consegue ler a imagem?"). Aqui a IA olha a
// conversa, o que está escrito nas imagens (visão), a marca e o último vídeo, e decide:
//   video        → criar um anúncio em vídeo (e com qual estilo)
//   adjust_video → refazer o último vídeo com um ajuste
//   image        → criar/editar imagem (segue o fluxo de imagem que já existe)
//   answer       → só responder (pergunta, dúvida, reclamação) — sem gastar crédito
//   ask          → falta UM fato essencial que não dá para deduzir
// Também devolve o nome da marca lido da logo, para ninguém precisar repetir.
// Sem chave de LLM ou em erro → null, e o Cérebro usa as regras antigas.
const { callLLM } = require('./llm');

const ACTIONS = ['video', 'adjust_video', 'animate', 'speak', 'clip', 'image', 'answer', 'ask'];
const STYLES = ['motion', 'presenter', 'photo'];

const SYSTEM = [
  'Você é o cérebro de um estúdio de criação com IA para pequenos negócios no Brasil (anúncios, vídeos, artes, logos).',
  'Muitos clientes NÃO sabem pedir: escrevem pouco, de forma vaga ou fazem perguntas. Seu trabalho é ENTENDER a intenção real usando todo o contexto e decidir a próxima ação. Deduza o máximo; pergunte só o essencial.',
  'Responda SOMENTE um JSON válido:',
  '{"action":"video|adjust_video|animate|speak|clip|image|answer|ask","style":"motion|presenter|photo|","request":"...","motion":"...","speech":"...","gender":"male|female","brand":"...","reply":"...","question":"..."}',
  'Como decidir action:',
  '- video: quer um vídeo/anúncio animado/comercial/reels, OU "apresentação/animação/vinheta/abertura da logo ou da marca" (isso é vídeo, não imagem).',
  '- animate: quer dar MOVIMENTO à própria imagem enviada (mascote, personagem, logo, produto), sem pedir anúncio, narração ou roteiro. Ex.: "deixa a barriga do mascote girando como uma betoneira", "faz o boneco acenar", "a logo girando", "faz ele piscar". Tem prioridade sobre video quando a mensagem descreve um movimento de algo DA IMAGEM.',
  '- clip: quer um VÍDEO CRIATIVO que NÃO é anúncio/comercial de empresa: uma cena, uma ideia visual ("um astronauta surfando numa onda", "cachorro correndo na praia em câmera lenta", "transforma essa foto num vídeo cinematográfico"). Anúncio, propaganda, divulgação ou vídeo DA EMPRESA/marca/loja é video, não clip.',
  '- speak: quer que o PERSONAGEM/MASCOTE da imagem FALE uma frase (ex.: "cria um vídeo dele falando bom dia, eu sou o Delta", "faz o mascote dizer: aproveite a promoção"). Não é anúncio: a fala é a do cliente.',
  'speech (só para speak): a fala EXATA pedida, só com pontuação e maiúsculas corrigidas (ex.: "Bom dia! Eu sou o Delta."). gender: male ou female, pelo personagem ("o Delta" → male).',
  '- Imagem de MASCOTE/personagem com o nome da empresa é o mascote DA EMPRESA, não um brinquedo à venda. Nunca invente que é produto infantil.',
  '- MENSAGEM QUE É SÓ UM DADO (endereço, telefone, preço, horário, Instagram), sem pedido: NUNCA é animate nem speak. Se já existe um vídeo recente, é adjust_video (colocar o dado no vídeo); senão é answer, confirmando que anotou e perguntando onde usar.',
  '- speak SÓ quando o cliente pede explicitamente que o personagem/pessoa DA IMAGEM fale ("faz ele falar", "ela dizendo", "o mascote fala"). Um texto de anúncio colado (mesmo longo) é video (anúncio), não speak.',
  '- adjust_video: já existe um vídeo recente e a mensagem pede mudar algo NELE (falar o nome, trocar cor, voz, telefone, texto, duração, formato).',
  '- image: quer criar ou editar uma IMAGEM (post, banner, flyer, arte, logo nova, trocar fundo, remover algo da foto).',
  '- answer: é pergunta, dúvida, comentário ou reclamação ("você não consegue ler a imagem?", "ficou bom", "como baixo?"). NUNCA transforme pergunta em edição.',
  '- Pedido em forma de pergunta é PEDIDO, não pergunta: "consegue fazer um vídeo da minha logo?", "pode colocar o nome?", "dá pra falar o telefone no vídeo?" → video/adjust_video/image.',
  '- Se a mensagem RESOLVE uma pendência da conversa (o estúdio pediu um dado e o cliente responde, mesmo reclamando: "está na logo, você não lê?"), EXECUTE o pedido original com o que você leu (action do pedido original, com request completo) em vez de só responder.',
  '- NUNCA use ask só porque falta o nome da marca, o telefone ou o preço: crie assim mesmo (o estúdio avisa no final o que faltou). ask é só quando não dá para saber NEM o que anunciar/criar.',
  '- ask: falta um fato essencial que não está no pedido, nas imagens nem na conversa. Raramente necessário.',
  'style (só para video/adjust_video): presenter se pedir pessoa/apresentador(a)/alguém falando; photo se pedir fotos/realista; senão motion.',
  'motion (para clip): em INGLÊS, o roteiro visual completo para um modelo de vídeo: sujeito, ação, cenário, movimento de câmera, luz e estilo, em uma frase rica. Se houver imagem anexada, descreva o que acontece A PARTIR dela, mantendo o que está nela.',
  'motion (para animate): em INGLÊS, descrição precisa do movimento para um modelo image-to-video: O QUE se move, COMO se move (direção, velocidade, repetição) e que TODO o resto continua igual (mesmo personagem, cores, letras, pose, fundo, câmera parada). Use o que a visão leu da imagem para nomear as partes. Ex.: "The round white belly of the blue-and-red robot mascot spins continuously around its vertical axis like a concrete mixer drum, smooth steady rotation, the letters on the belly rotate with it. The rest of the mascot stays exactly the same: same pose, thumbs up, colors and helmet. Static camera, plain background unchanged."',
  'request: o pedido COMPLETO e claro em português, já com tudo que você deduziu do contexto (marca, ramo, serviços, telefone, cores lidos das imagens ou da conversa). Ex.: "Vídeo de apresentação da marca SOL Provedor de Internet, provedor de internet, cores azul e amarelo, Instagram @sol.provedor". Não invente preço, telefone nem promoção.',
  'brand: nome da empresa se aparecer no pedido, na conversa ou no TEXTO DAS IMAGENS (ex.: logo com "SOL PROVEDOR DE INTERNET" → "SOL Provedor de Internet"). Vazio se não souber.',
  'reply (só para answer): resposta curta, simpática e útil em português. Se a pessoa perguntou se você lê imagens, diga o que você leu nelas e ofereça o próximo passo (ex.: "Li sim: é a logo da SOL Provedor de Internet. Quer um vídeo de apresentação dela?").',
  'question (só para ask): UMA pergunta curta e objetiva.',
  'Sem markdown, sem explicações fora do JSON.'
].join('\n');

function parseJson(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

function buildContext({ message, session }) {
  const mem = (session && session.memory) || {};
  const hist = ((session && session.history) || []).slice(-8)
    .map((h) => `${h.role === 'user' ? 'Cliente' : 'Estúdio'}: ${String(h.message || '').replace(/\s+/g, ' ').slice(0, 300)}${h.videoUrl ? ' [entregou um vídeo]' : ''}${h.imageUrl ? ' [entregou uma imagem]' : ''}`);
  const current = new Set(mem.refImages || []);
  const imgs = (mem.refDescriptions || []).filter((d) => current.has(d.src)).map((d) => d.caption).filter(Boolean).slice(-3);
  const p = mem.project || {};
  return [
    `Mensagem atual do cliente: ${message}`,
    `Imagens anexadas agora: ${(mem.refImages || []).length}`,
    imgs.length ? `O que está nas imagens (visão, textos exatos): ${imgs.join(' | ')}` : '',
    p.brand ? `Marca já conhecida: ${p.brand}` : '',
    (p.facts || []).length ? `Fatos já informados: ${p.facts.map((f) => `${f.key}: ${f.value}`).join('; ')}` : '',
    mem.lastAdRequest ? `Último vídeo feito a partir do pedido: ${mem.lastAdRequest}` : '',
    hist.length ? `Conversa recente:\n${hist.join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

// Contadores desde que o servidor subiu: mostram em /api/diagnostics quantas vezes o
// roteador falhou e o Cérebro ficou sem entender o pedido. Antes isso era invisível.
const stats = { ok: 0, failed: 0, lastError: null, lastFailedAt: null };
function noteFailure(reason) {
  stats.failed++;
  stats.lastError = String(reason || '').slice(0, 160);
  stats.lastFailedAt = new Date().toISOString();
}

async function routeMessage({ message, session }) {
  if (!isEnabled()) return null;
  try {
    // JSON validado; se vier inválido, uma segunda tentativa antes de desistir.
    // Cada tentativa pode repetir a chamada (erro 5xx / tempo esgotado) e usa raciocínio
    // curto: era o raciocínio longo do gpt-oss que estourava os 25 s e fazia o Cérebro
    // cair nas regras por palavra-chave, que "pediam uma coisa e faziam outra".
    let r = null;
    const errors = [];
    for (let attempt = 1; attempt <= 2 && !r; attempt++) {
      const text = await callLLM(SYSTEM, buildContext({ message, session }), {
        temperature: attempt === 1 ? 0.1 : 0,
        maxTokens: 500,
        maxAttempts: 2,
        timeout: Number(process.env.ROUTER_TIMEOUT_MS) || 45000,
        reasoningEffort: process.env.ROUTER_REASONING_EFFORT || 'low',
        json: true,
        errors
      });
      const parsed = parseJson(text);
      if (parsed && ACTIONS.includes(parsed.action)) r = parsed;
      else console.warn(`router: JSON inválido (tentativa ${attempt}):`, String(text || '').slice(0, 120));
    }
    if (!r) {
      noteFailure(errors[errors.length - 1] || 'resposta vazia ou JSON inválido');
      return null;
    }
    stats.ok++;
    const str = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
    return {
      action: r.action,
      style: STYLES.includes(r.style) ? r.style : '',
      request: str(r.request, 600),
      brand: require('./brandInfo').isGenericBrand(r.brand) ? '' : str(r.brand, 50),
      reply: str(r.reply, 600),
      question: str(r.question, 200),
      motion: str(r.motion, 700),
      speech: str(r.speech, 400),
      gender: r.gender === 'female' ? 'female' : 'male'
    };
  } catch (e) {
    console.error('router: falhou:', e.message);
    noteFailure(e.message);
    return null;
  }
}

// O roteador está ligado (chave de IA configurada e não desligado por variável)?
function isEnabled() {
  return process.env.CEREBRO_ROUTER !== 'false' && !!process.env.LLM_API_KEY;
}

// Garante que o texto do pedido carregue o estilo que o roteador escolheu
// (o pipeline de vídeo escolhe o estilo pelas palavras do pedido).
function requestWithStyle(request, style) {
  const r = String(request || '');
  if (style === 'presenter' && !/(apresentador|apresentadora|apresentando|pessoa)/i.test(r)) return `${r} (com apresentadora)`;
  if (style === 'photo' && !/(com fotos?|realista)/i.test(r)) return `${r} (com fotos realistas)`;
  if (!/(v[íi]deo|comercial|reels|an[úu]ncio)/i.test(r)) return `Vídeo: ${r}`;
  return r;
}

// Pedido de movimento do cliente (português, do jeito dele) → prompt de image-to-video em inglês,
// usando o que a visão leu da imagem para nomear as partes. Sem LLM → o próprio texto.
async function motionPrompt(message, captions = []) {
  const sys = [
    'You write prompts for an image-to-video model (Kling). The user (Brazilian Portuguese) describes how the image should move.',
    'Write ONE English paragraph: WHAT moves, HOW (direction, speed, repetition), and that EVERYTHING ELSE stays identical (same character/object design, colors, letters, pose, background). Static camera. No text added.',
    'Use the image description to name the parts precisely. Output only the prompt.',
    'IMPORTANT for logos, text and letters: video models duplicate and deform letters when they move. NEVER make letters or words slide, fly, spin, bounce, rearrange or appear one by one. Keep all text perfectly still and sharp. For "present/animate my logo" use only: a slow camera push-in, a soft light sweep/shine passing across the logo, a subtle glow pulse, gentle particles or light in the background.'
  ].join('\n');
  const user = `Image: ${(captions || []).join(' | ') || '(no description)'}\nUser request: ${message}`;
  try {
    const t = await callLLM(sys, user, { temperature: 0.2, maxTokens: 400, json: false, timeout: 30000 });
    const out = String(t || '').replace(/```/g, '').trim();
    if (out.length > 20) return out.slice(0, 900);
  } catch (e) {
    console.error('router: prompt de movimento falhou:', e.message);
  }
  return `Animate the image: ${message}. Keep everything else identical. Static camera.`;
}

// ---------------------------------------------------------------------------
// Plano B quando o roteador falha
// ---------------------------------------------------------------------------
// Sem o roteador, o Cérebro adivinhava o pedido por palavra-chave — e é aí que "pede
// uma coisa e faz outra". Agora: se o pedido diz EXPLICITAMENTE o que é (imagem,
// vídeo, roteiro) ou é claramente uma edição da imagem anexada, segue sem perguntar;
// se é ambíguo, pergunta UMA vez (sem gastar crédito) em vez de chutar.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const EDIT_VERB = /\b(mud\w*|deix\w*|troc\w*|tir[ae]\w*|remov\w*|apag\w*|aument\w*|diminu\w*|clare\w*|escure\w*|corrig\w*|acrescent\w*|adicion\w*|coloc\w*|poe|substitu\w*|recort\w*|melhor[ae]\w*)\b/;

function needsClarification(message, { hasImage = false } = {}) {
  const C = require('./contract');
  if (C.detectRequested(message).tipo) return false; // disse o que quer
  const m = norm(message);
  if (hasImage && EDIT_VERB.test(m)) return false; // "tira o fundo" com imagem = edição
  if (!hasImage && (C.isQuestion(message) || !C.isCreationRequest(message))) return false; // conversa
  return true;
}

// Opções da pergunta (a de editar só aparece se há imagem anexada)
function clarifyOptions(hasImage) {
  return hasImage ? ['image', 'edit', 'video'] : ['image', 'video'];
}

const OPTION_LABEL = { image: 'uma imagem nova (post, arte, banner)', edit: 'editar a imagem que você enviou', video: 'um vídeo' };
// Texto que é somado ao pedido original: palavras que as regras entendem sem ambiguidade
const OPTION_TEXT = { image: 'Crie uma nova imagem do zero (post/arte).', edit: 'Edite a imagem que eu enviei.', video: 'Quero em vídeo.' };

function clarifyQuestion(hasImage) {
  const opts = clarifyOptions(hasImage);
  return 'Só para eu não errar: você quer\n' + opts.map((o, i) => `${i + 1}) ${OPTION_LABEL[o]}`).join('\n') +
    `\nResponda com o número (${opts.map((_, i) => i + 1).join(', ')}) ou com a palavra.`;
}

// Resposta do cliente → opção escolhida (ou null se ele mudou de assunto)
function clarifyChoice(answer, options) {
  const m = norm(answer).trim();
  const num = m.match(/^\s*([1-3])\b/);
  if (num && options[Number(num[1]) - 1]) return options[Number(num[1]) - 1];
  if (/\bv[i]deo|reels|anima/.test(m)) return 'video';
  if (options.includes('edit') && /\b(edit\w*|essa|esta|mesma|enviei|mandei)\b/.test(m)) return 'edit';
  if (/\b(imagem|post|arte|banner|nova|zero)\b/.test(m)) return 'image';
  return null;
}

function applyClarifyChoice(originalMessage, choice) {
  return `${String(originalMessage || '').trim().replace(/[.!?\s]+$/, '')}. ${OPTION_TEXT[choice]}`;
}

module.exports = { routeMessage, requestWithStyle, motionPrompt, isEnabled, stats, needsClarification, clarifyOptions, clarifyQuestion, clarifyChoice, applyClarifyChoice, _internals: { buildContext, parseJson, SYSTEM, noteFailure } };
