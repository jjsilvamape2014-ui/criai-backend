// 📜 CONTRATO DO PEDIDO (CRIAI v2, versão adaptada)
//
// Problema: o cliente pede uma coisa e a IA faz outra (pediu imagem, veio vídeo; pediu
// roteiro, veio vídeo pronto). A IA que gera não pode ser a única a decidir o tipo.
// Aqui, em código (determinístico, sem IA):
//   1) detectRequested: o que o cliente PEDIU EXPLICITAMENTE (imagem, vídeo, roteiro, texto)
//   2) precheck: antes da IA — conflito ("vídeo, mas só a legenda") ou pedido vazio
//      ("faça um anúncio") → pergunta curta, sem gastar crédito
//   3) enforce: depois do roteador — a ação escolhida pela IA tem que bater com o pedido;
//      se não bater, a ação é corrigida (imagem nunca vira vídeo; vídeo nunca vira só texto)
// Campos como canal, tom e restrições NÃO são obrigatórios: têm padrão (Instagram/Reels,
// tom do ramo, sem restrição). Só é obrigatório o que não dá para deduzir: o que anunciar.

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const RX = {
  // pedido de texto (roteiro/legenda/copy) — entregue como texto, sem renderizar
  roteiro: /\broteiros?\b|\bscript\b/,
  copy: /\b(legenda|legendas|copy|copies|headline|texto do anuncio|texto para|textos para|so o texto|apenas o texto|so texto|so a legenda|apenas a legenda|so legenda)\b/,
  // pedido de imagem estática
  // (logo só conta como entrega quando é para CRIAR uma logo; "anima minha logo" é insumo)
  imagem: /\b(imagem|imagens|foto|fotos|post|posts|arte|artes|banner|flyer|panfleto|card|carrossel|thumbnail|story estatico)\b|\b\d{3,4}\s*x\s*\d{3,4}\b|\b(cri\w*|faz\w*|faca|gera\w*|desenh\w*)\s+(uma\s+|a\s+|minha\s+)?(nova\s+)?(logo|logotipo|logomarca)\b/,
  // pedido de vídeo
  video: /\b(video|videos|reels|reel|tiktok|animacao|animado|animada|anima|animar|animando|girando|comercial|vinheta|motion)\b/,
  // pedido explícito de "só texto" dentro de um pedido de vídeo
  onlyText: /\b(so|apenas|somente)\s+(a\s+|o\s+)?(legenda|legendas|texto|copy|roteiro)\b/,
};

// O que o cliente pediu. Retorna { tipo, conflito } — tipo: 'imagem' | 'video' | 'roteiro_video' | 'copy' | null
function detectRequested(message) {
  const m = norm(message);
  const hasVideo = RX.video.test(m);
  const hasImage = RX.imagem.test(m);
  const onlyText = RX.onlyText.test(m);
  if (hasVideo && onlyText) return { tipo: null, conflito: 'video_vs_texto' };
  if (RX.roteiro.test(m)) return { tipo: 'roteiro_video', conflito: null };
  const textForImage = RX.copy.test(m) && /\b(para|pra|p\/|dessa|desta|nessa|da|do)\s+(essa\s+|esta\s+|a\s+|o\s+|minha\s+)?(foto|imagem|post|arte)\b/.test(m);
  if (onlyText || textForImage || (RX.copy.test(m) && !hasVideo && !hasImage)) return { tipo: 'copy', conflito: null };
  // "vídeo … (com) legendas" é vídeo com legenda na tela, não pedido de texto
  if (hasVideo && hasImage) {
    // "anúncio em vídeo com a foto do produto": foto é insumo, vídeo é a entrega
    const vi = m.search(RX.video), ii = m.search(RX.imagem);
    return { tipo: vi <= ii || /\b(com|usando|a partir d[ae])\s+(a\s+|as\s+|essa\s+|esta\s+)?(foto|imagem|logo)/.test(m) ? 'video' : 'imagem', conflito: null };
  }
  if (hasVideo) return { tipo: 'video', conflito: null };
  if (hasImage) return { tipo: 'imagem', conflito: null };
  return { tipo: null, conflito: null };
}

// Pedido vazio: só palavras de pedido, sem dizer O QUE anunciar ("faça um anúncio")
const FILLER = /\b(faz|faca|faça|fazer|cria|crie|criar|gera|gere|gerar|quero|preciso|me|um|uma|uns|umas|de|do|da|dos|das|com|pra|para|o|a|os|as|em|meu|minha|novo|nova|anuncio|anuncios|propaganda|divulgacao|campanha|video|videos|imagem|post|arte|reels|legal|bonito|bom|boa|profissional|agora|por|favor)\b/g;
function isEmptyRequest(message) {
  const rest = norm(message).replace(FILLER, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return rest.split(/\s+/).filter((w) => w.length > 2).length === 0;
}

// Antes da IA: decide se precisa perguntar. Retorna null (segue) ou { status, tipo, duvidas }.
function precheck({ message, knowsBusiness, hasImage }) {
  const req = detectRequested(message);
  if (req.conflito === 'video_vs_texto') {
    return { status: 'precisa_clareza', tipo: 'roteiro_video', duvidas: ['Você quer o VÍDEO pronto (com narração e animação) ou SÓ o texto (roteiro/legenda) para usar em outro lugar?'] };
  }
  if (isEmptyRequest(message) && !knowsBusiness && !hasImage) {
    return {
      status: 'precisa_clareza',
      tipo: req.tipo || 'anuncio',
      duvidas: ['O que você quer anunciar? (produto/serviço, nome da empresa e, se tiver, preço e WhatsApp)' +
        (req.tipo ? '' : ' E prefere em vídeo (Reels/Status) ou imagem (post)?')],
    };
  }
  return null;
}

// Depois do roteador: a ação da IA tem que bater com o que foi pedido.
// Retorna { action, corrigido, motivo }.
const ROUTER_TIPO = { video: 'video', adjust_video: 'video', animate: 'video', speak: 'video', image: 'imagem', answer: 'texto', ask: 'pergunta' };
// É um pedido de criação? ("faz", "cria", "quero"…) — comentário ("ficou bom", "obrigado") não é
const ASK_VERB = /\b(faz|faca|fazer|fas|cria|crie|criar|gera|gere|gerar|quero|queria|preciso|precisa|manda|mande|monta|monte|produz\w*|desenvolv\w*|elabor\w*|me\s+(da|de|ve|arruma)|pode\s+(fazer|criar)|consegue\s+(fazer|criar))\b/;
const FEEDBACK = /\b(ficou|gostei|amei|adorei|obrigad\w*|valeu|perfeito|show|top|legal demais|nao gostei|ruim|horrivel|errado|errou)\b/;
function isCreationRequest(message) {
  const m = norm(message);
  if (FEEDBACK.test(m) && !ASK_VERB.test(m)) return false;
  // começa pela peça ("post de bom dia para a Ótica…", "arte para promoção…") também é pedido
  if (/^(um |uma )?(post|arte|banner|flyer|panfleto|imagem|story|stories|reels|video|anuncio|logo\w*|card)\b/.test(m)) return true;
  return ASK_VERB.test(m) || m.split(/\s+/).length <= 8; // pedido curto sem verbo ("reels da minha loja")
}

function enforce(action, message) {
  const req = detectRequested(message).tipo;
  if (!isCreationRequest(message)) return { action, corrigido: false };
  const got = ROUTER_TIPO[action] || null;
  if (!req || !got || got === 'pergunta') return { action, corrigido: false };
  if (req === 'imagem' && got === 'video') return { action: 'image', corrigido: true, motivo: 'pediu imagem; a IA escolheu vídeo' };
  if (req === 'video' && got === 'imagem') return { action: 'video', corrigido: true, motivo: 'pediu vídeo; a IA escolheu imagem' };
  if (req === 'video' && got === 'texto') return { action: 'video', corrigido: true, motivo: 'pediu vídeo; a IA só respondeu' };
  const question = /\?\s*$/.test(String(message)) || /^(qual|quais|como|quando|onde|por ?que|o que|quanto|quantos|tem como|da pra|d[aá] para)\b/.test(norm(message));
  if (req === 'imagem' && got === 'texto' && !question) return { action: 'image', corrigido: true, motivo: 'pediu imagem/post; a IA só respondeu' };
  if ((req === 'roteiro_video' || req === 'copy') && (got === 'video' || got === 'imagem')) {
    return { action: 'write', corrigido: true, motivo: `pediu ${req === 'copy' ? 'texto' : 'roteiro'}; a IA ia renderizar` };
  }
  return { action, corrigido: false };
}

// ---------------------------------------------------------------------------
// Entrega de TEXTO (roteiro de vídeo, legenda, copy) — JSON validado, sem renderizar
// ---------------------------------------------------------------------------
const WRITE_SYSTEM = [
  'Você é o Cérebro CRIAI, redator de anúncios para pequenos negócios no Brasil.',
  'Entregue EXATAMENTE o tipo pedido (roteiro de vídeo ou texto/legenda). Não invente preço, telefone, endereço, prêmio ou estatística; se faltar, escreva sem eles.',
  'Nunca use marcadores como [nome da empresa] ou (XX) XXXX-XXXX.',
  'Responda SOMENTE JSON válido:',
  '{"tipo":"roteiro_video|copy","entrega":{"headline":"...","corpo":"...","cta":"...","roteiro_cenas":[{"tempo":"0-3s","tela":"...","fala":"..."}]},"validacao":{"faltou":["..."]}}',
  'roteiro_video: roteiro_cenas com 3 a 6 cenas somando a duração pedida (padrão 15 s); fala curta em português; tela = o que aparece. copy: headline, corpo (até 60 palavras) e cta; roteiro_cenas vazio.',
  'validacao.faltou: informações que fariam falta para o anúncio (ex.: preço, WhatsApp). Pode ser vazio.',
].join('\n');

function parseJson(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

// Valida a forma do JSON; retorna o objeto normalizado ou null
function validateWrite(obj, tipo) {
  if (!obj || typeof obj !== 'object' || !obj.entrega || typeof obj.entrega !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const cenas = Array.isArray(obj.entrega.roteiro_cenas) ? obj.entrega.roteiro_cenas.slice(0, 8).map((c) => ({
    tempo: str(c && c.tempo, 20), tela: str(c && c.tela, 160), fala: str(c && c.fala, 240),
  })).filter((c) => c.tela || c.fala) : [];
  const out = {
    tipo,
    entrega: { headline: str(obj.entrega.headline, 120), corpo: str(obj.entrega.corpo, 900), cta: str(obj.entrega.cta, 120), roteiro_cenas: cenas },
    validacao: { faltou: (obj.validacao && Array.isArray(obj.validacao.faltou) ? obj.validacao.faltou : []).map((f) => str(f, 80)).filter(Boolean).slice(0, 4) },
  };
  // checagem em código (não é a IA se auto-avaliando): o formato bate com o tipo pedido?
  if (tipo === 'roteiro_video' && out.entrega.roteiro_cenas.length < 2) return null;
  if (tipo === 'copy' && !out.entrega.corpo && !out.entrega.headline) return null;
  return out;
}

async function writeText({ message, tipo, project, callLLM, captions = [] }) {
  const p = project || {};
  const user = [
    `Pedido: ${message}`,
    captions.length ? `Imagem enviada pelo cliente (descrição): ${captions.join(' | ')}` : '',
    `Tipo a entregar: ${tipo}`,
    p.brand ? `Marca: ${p.brand}` : '',
    (p.facts || []).length ? `Fatos: ${p.facts.map((f) => `${f.key}: ${f.value}`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await callLLM(WRITE_SYSTEM, user, { temperature: attempt === 1 ? 0.6 : 0.3, maxTokens: 1500, json: true, timeout: 45000 });
    const C = require('./claims');
    const src = C.sourceOf({ request: message, project: p, refCaptions: captions });
    const raw = parseJson(text);
    if (raw && raw.entrega) raw.entrega = C.cleanPlan(raw.entrega, src);
    const ok = validateWrite(raw, tipo);
    if (ok) return ok;
  }
  return null;
}

// Texto do chat a partir da entrega validada
function formatText(w) {
  const e = w.entrega;
  const parts = [];
  if (w.tipo === 'roteiro_video') {
    parts.push('🎬 Roteiro do vídeo:');
    e.roteiro_cenas.forEach((c, i) => parts.push(`${i + 1}. ${c.tempo ? `[${c.tempo}] ` : ''}Tela: ${c.tela}${c.fala ? `\n   Fala: “${c.fala}”` : ''}`));
    if (e.cta) parts.push(`\nChamada final: ${e.cta}`);
  } else {
    if (e.headline) parts.push(`Título: ${e.headline}`);
    if (e.corpo) parts.push(e.corpo);
    if (e.cta) parts.push(`Chamada: ${e.cta}`);
  }
  if (w.validacao.faltou.length) parts.push(`\nPara ficar completo, me diga: ${w.validacao.faltou.join(', ')}.`);
  parts.push(w.tipo === 'roteiro_video' ? '\nQuer que eu transforme esse roteiro no vídeo pronto? É só dizer "faz o vídeo".' : '');
  return parts.filter(Boolean).join('\n');
}

// "…falando bom dia, eu sou o Delta" com imagem → { fala, feminina } ou null
function detectSpeech(message, hasImage) {
  if (!hasImage || /(an[úu]ncio|promo[çc][ãa]o|vender|venda|pre[çc]o|r\$)/i.test(message)) return null;
  const m = String(message || '').match(/\b(falando|dizendo|fala|falar|diga|dizer|diz)\b\s*[:,"“']?\s*(.{3,})$/i);
  if (!m || /^(sobre|do|da|de|com|que)\b/i.test(m[2])) return null;
  let fala = m[2].replace(/["”']+$/, '').trim();
  fala = fala.charAt(0).toUpperCase() + fala.slice(1);
  if (!/[.!?]$/.test(fala)) fala += '.';
  return { fala, feminina: /\b(a|uma)\s+(mascote|personagem|menina|mulher)|\bsou a\b/i.test(message) };
}

module.exports = { isCreationRequest, detectSpeech, detectRequested, isEmptyRequest, precheck, enforce, validateWrite, writeText, formatText, parseJson };
