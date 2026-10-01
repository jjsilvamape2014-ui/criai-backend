// 🔤 LOGO COM O NOME SEMPRE CERTO
//
// IA de imagem erra letras ("Linha Fãcil") e às vezes escreve outra palavra do pedido
// ("Azul"). Aqui:
//   1) nome e cor saem do pedido, sem perguntar ("com o nome Linha Fácil na cor azul")
//   2) a IA desenha SÓ o símbolo, sem texto
//   3) o nome é escrito por código (fonte Poppins, com acentos) → nunca sai errado
//   4) sem símbolo (falha da IA) → monograma com as iniciais, também por código
require('./fontSetup');
const sharp = require('sharp');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const COLORS = {
  azul: '#1d4ed8', 'azul marinho': '#1e3a8a', 'azul claro': '#3b82f6', vermelho: '#dc2626', verde: '#16a34a',
  preto: '#111827', laranja: '#ea580c', roxo: '#7c3aed', lilas: '#a855f7', amarelo: '#ca8a04', rosa: '#db2777',
  dourado: '#b8860b', cinza: '#4b5563', marrom: '#7c4a1e', vinho: '#7f1d1d', turquesa: '#0d9488',
};

// É pedido de CRIAR uma logo? ("cria um logo…", "faz uma logomarca…", "quero um logotipo…")
function isLogoRequest(message) {
  const m = norm(message);
  // com verbo ("cria uma logo…") ou começando pela peça ("logo da Auto Center Silva em vermelho")
  return (/\b(cri\w*|faz\w*|faca|fazer|gera\w*|desenh\w*|quero|queria|preciso|monta\w*)\b[^.]{0,30}\b(logo|logotipo|logomarca)\b/.test(m) ||
    /^(uma? )?(nova )?(logo|logotipo|logomarca) (da|do|de|para|pra|pro)\b/.test(m)) &&
    !/\b(anim\w*|gir\w*|video|reels|coloc\w*|adicion\w*|p[oõ]e)\b/.test(m);
}

// Nome da marca escrito no pedido
// "Linha Fácil azul" → "Linha Fácil" (cor solta no fim não faz parte do nome)
function dropColor(name) {
  const words = String(name || '').trim().split(/\s+/);
  while (words.length > 1 && Object.keys(COLORS).includes(norm(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function extractName(message) {
  const n = extractNameRaw(message);
  return n ? dropColor(n) : n;
}

function extractNameRaw(message) {
  const s = String(message || '');
  const q = s.match(/["“']([^"”']{2,40})["”']/);
  if (q) return q[1].trim();
  const m = s.match(/(?:com o nome|com nome|chamad[ao]|de nome|nome(?: da (?:empresa|marca|loja))?(?: [ée])?)\s*[:\-]?\s*(.+?)(?=\s+(?:na|no|nas|nos|em|com|de cor|cor|nas cores|para|pra|que|e\s+(?:na|no|em|com|cor))\b|[,.;!?]|$)/i);
  if (m) {
    const name = m[1].trim().replace(/[.,;:!?]+$/, '');
    if (name.length >= 2 && name.length <= 40 && !/^(minha|meu|a|o|uma|um)\b/i.test(name)) return name;
  }
  // "logo da Linha Fácil" / "logo para Padaria São João" (nome com maiúsculas)
  // (aceita artigo no meio: "logo para a Doce Sabor", "logomarca pro Bar do Zé")
  const cap = s.match(/\blogo\w*\s+(?:da|do|de|para|pra|pro)\s+(?:(?:a|o)\s+)?((?:[A-ZÀ-Ú][\wÀ-ú'&.-]*(?:\s(?:da|do|de|dos|das|e)(?=\s[A-ZÀ-Ú]))?\s?){1,4})/);
  if (cap) return cap[1].trim();
  return '';
}

function extractColor(message) {
  const m = norm(message);
  for (const k of Object.keys(COLORS).sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${k}\\b`).test(m)) return { name: k, hex: COLORS[k] };
  const hex = String(message || '').match(/#[0-9a-f]{6}\b/i);
  return hex ? { name: hex[0], hex: hex[0] } : null;
}

// ramo do negócio (para o símbolo), tirado do pedido sem o nome e a cor
function businessHint(message, name) {
  return norm(message)
    .replace(norm(name), ' ')
    .replace(/\b(cri\w*|faz\w*|faca|fazer|gera\w*|quero|queria|preciso|uma?|o|a|logo\w*|com|nome|na|no|cor|cores|de|da|do|para|pra|minha|meu|empresa|marca|azul|vermelh\w|verde|pret\w|laranja|rox\w|amarel\w|rosa|dourad\w|cinza|marrom|vinho|turquesa|clar\w|escur\w)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Ramo do negócio reconhecível (no pedido ou no próprio nome). Sem ramo → monograma:
// um símbolo inventado sem saber o negócio vira uma forma aleatória.
const BUSINESS = /(padaria|barbearia|pizzaria|restaurante|hamburgueria|lanchonete|cafe|cafeteria|doceria|confeitaria|acai|sorveteria|academia|clinica|odonto\w*|dentista|pet\s?shop|veterinari\w*|oficina|mecanica|auto\s?pecas|imobiliaria|construtora|construcao|concreto|advocacia|advogad\w*|contabilidade|contabil|salao|beleza|estetica|moda|roupas?|calcados|farmacia|otica|escola|curso|igreja|mercado|supermercado|floricultura|tecnologia|informatica|internet|provedor|refrigeracao|ar condicionado|eletrica|eletricista|encanador|transporte|mudancas|turismo|viagens|fotografia|marketing|agencia|seguros|energia solar|hotel|pousada|lavanderia|lava\s?jato|limpeza|jardinagem|arquitetura|engenharia)/;
function businessOf(message, name) {
  const m = BUSINESS.exec(norm(`${message} ${name}`));
  return m ? m[1] : '';
}

// Ramo → ícone vetorial do próprio app (limpo, sempre consistente; a IA de imagem gera
// fotos/borrões quando pedimos símbolo)
const BIZ_ICON = [
  [/barbearia|salao|cabelei/, 'scissors'], [/odonto|dentista/, 'tooth'], [/pet|veterinari/, 'paw'],
  [/padaria|doceria|confeitaria|bolo/, 'cake'], [/pizzaria|restaurante|hamburgueria|lanchonete|cafe|acai|sorveteria/, 'food'],
  [/oficina|mecanica|auto/, 'wrench'], [/imobiliaria|hotel|pousada/, 'home'], [/construtora|construcao|concreto|arquitetura|engenharia/, 'building'],
  [/advoca|seguros/, 'shield'], [/contab/, 'chart'], [/beleza|estetica/, 'sparkles'], [/moda|roupa|calcado/, 'bag'],
  [/farmacia|clinica|igreja/, 'heart'], [/otica|fotografia/, 'eye'], [/escola|curso/, 'star'], [/mercado/, 'cart'],
  [/floricultura|jardinagem/, 'leaf'], [/tecnologia|informatica/, 'gear'], [/internet|provedor/, 'wifi'],
  [/refrigeracao|ar condicionado/, 'snowflake'], [/eletric|academia/, 'bolt'], [/encanador|lavanderia|lava\s?jato|limpeza/, 'drop'],
  [/transporte|mudanca/, 'truck'], [/turismo|viage/, 'location'], [/marketing|agencia/, 'rocket'], [/energia solar/, 'sun'],
];
function iconFor(biz) {
  const b = norm(biz);
  for (const [re, icon] of BIZ_ICON) if (re.test(b)) return icon;
  return null;
}

const esc = (t) => String(t).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Monta a logo: símbolo (buffer PNG, opcional) em cima, nome embaixo. PNG 1080x1080 fundo branco.
// Composições de logo (antes era sempre símbolo redondo + nome embaixo, na mesma fonte):
//   stack      → símbolo em cima, nome embaixo
//   horizontal → símbolo à esquerda, nome à direita
//   emblem     → selo na cor da marca com símbolo e nome em branco
//   wordmark   → só o nome forte, com um traço e o símbolo pequeno
// A fonte segue o ramo (salão → Playfair, pizzaria → Anton, técnico → Montserrat).
// O cliente pode pedir: "logo horizontal", "em selo/emblema", "só o nome".
const LOGO_LAYOUTS = ['stack', 'horizontal', 'emblem', 'wordmark'];
function pickLogoLayout(message, name) {
  const m = norm(message);
  if (/horizontal|lado a lado|deitad/.test(m)) return 'horizontal';
  if (/selo|emblema|carimbo|badge|brasao/.test(m)) return 'emblem';
  if (/so (o )?nome|apenas (o )?nome|sem (simbolo|icone|desenho)|tipografic/.test(m)) return 'wordmark';
  if (/vertical|empilhad/.test(m)) return 'stack';
  let h = 2166136261;
  for (const ch of norm(name)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return LOGO_LAYOUTS[(h >>> 7) % LOGO_LAYOUTS.length];
}

async function composeLogo({ name, hex, symbol, icon, layout = 'stack', look = 'moderno' }) {
  const E = require('./motion/engine');
  const ST = require('./motion/styles');
  const { icon: drawIcon } = require('./motion/icons');
  const st = ST.get(look);
  const font = ST.fontStack(st);
  const heavy = st.flatWeight ? 400 : 800;
  const W = 1080;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const mark = (cx, cy, r, bg, fg) => (icon
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/>${drawIcon(icon, cx, cy, r * 1.1, fg, { strokeWidth: 5 })}`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/><text x="${cx}" y="${cy + r * 0.34}" font-family="${font}" font-weight="${heavy}" font-size="${r * 0.95}" fill="${fg}" text-anchor="middle">${esc(initials)}</text>`);
  const t = (x, y, l, size, fill, anchor = 'middle', w = heavy, sp = -1) => `<text x="${x}" y="${y.toFixed(0)}" font-family="${font}" font-weight="${w}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${sp}">${esc(l)}</text>`;
  const layers = [];
  let body = '';
  E.withWidth(st.widthK, () => {
    if (layout === 'horizontal') {
      const r = 150;
      const fit = E.fitText(name, { size: 130, minSize: 60, maxWidth: 540, maxLines: 2, weight: heavy });
      const lh = fit.size * 1.05;
      const cy = 540;
      body = (symbol ? '' : mark(80 + r, cy, r, hex, '#ffffff')) +
        fit.lines.map((l, i) => t(80 + 2 * r + 50, cy - ((fit.lines.length - 1) * lh) / 2 + fit.size * 0.35 + i * lh, l, fit.size, hex, 'start')).join('');
      if (symbol) layers.push({ symbol, box: [80, cy - r, 2 * r, 2 * r] });
    } else if (layout === 'emblem') {
      const fit = E.fitText(name.toUpperCase(), { size: 110, minSize: 50, maxWidth: 760, maxLines: 2, weight: heavy });
      const lh = fit.size * 1.08;
      const textH = fit.lines.length * lh;
      const symR = 120;
      const boxH = symR * 2 + 60 + textH + 120;
      const y0 = (W - boxH) / 2;
      body = `<rect x="110" y="${y0}" width="860" height="${boxH}" rx="70" fill="${hex}"/><rect x="135" y="${y0 + 25}" width="810" height="${boxH - 50}" rx="55" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="4"/>` +
        (symbol ? '' : mark(540, y0 + 60 + symR, symR, '#ffffff', hex)) +
        fit.lines.map((l, i) => t(540, y0 + 60 + 2 * symR + 50 + fit.size * 0.85 + i * lh, l, fit.size, '#ffffff', 'middle', heavy, 2)).join('');
      if (symbol) layers.push({ symbol, box: [540 - symR, y0 + 60, 2 * symR, 2 * symR], white: true });
    } else if (layout === 'wordmark') {
      const fit = E.fitText(name, { size: 170, minSize: 70, maxWidth: 920, maxLines: 2, weight: heavy });
      const lh = fit.size * 1.05;
      const textH = fit.lines.length * lh;
      const y0 = (W - textH - 90) / 2;
      body = fit.lines.map((l, i) => t(540, y0 + fit.size * 0.85 + i * lh, l, fit.size, '#16181d')).join('') +
        `<rect x="${540 - 260}" y="${y0 + textH + 40}" width="380" height="14" rx="7" fill="${hex}"/>` +
        (icon ? `<circle cx="${540 + 190}" cy="${y0 + textH + 47}" r="34" fill="${hex}"/>${drawIcon(icon, 540 + 190, y0 + textH + 47, 40, '#ffffff', { strokeWidth: 7 })}` : `<circle cx="${540 + 170}" cy="${y0 + textH + 47}" r="14" fill="${hex}"/>`);
    } else {
      const fit = E.fitText(name, { size: 150, minSize: 70, maxWidth: 900, maxLines: 2, weight: heavy });
      const lh = fit.size * 1.05;
      const textH = fit.lines.length * lh;
      const symH = 420;
      const top = Math.round((W - (symH + 50 + textH)) / 2);
      const cy = top + symH / 2;
      body = (symbol ? '' : mark(540, cy, symH / 2 - 10, hex, '#ffffff')) +
        fit.lines.map((l, i) => t(540, top + symH + 50 + fit.size * 0.9 + i * lh, l, fit.size, hex)).join('');
      if (symbol) layers.push({ symbol, box: [540 - symH / 2, top, symH, symH] });
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#ffffff"/>${body}</svg>`;
  const comps = [];
  for (const L of layers) {
    let s = await sharp(L.symbol).resize(Math.round(L.box[2]), Math.round(L.box[3]), { fit: 'inside' }).png().toBuffer();
    if (L.white) s = await sharp(s).tint({ r: 255, g: 255, b: 255 }).png().toBuffer();
    const sm = await sharp(s).metadata();
    comps.push({ input: s, left: Math.round(L.box[0] + (L.box[2] - sm.width) / 2), top: Math.round(L.box[1] + (L.box[3] - sm.height) / 2) });
  }
  return sharp(Buffer.from(svg)).composite(comps).png().toBuffer();
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Separa o ícone do fundo branco, pinta na cor da marca (mantendo luz e sombra) e recorta.
// Rejeita (null) ícone grudado nas bordas ou ocupando quase tudo (ex.: "app icon" com fundo).
async function processSymbol(buf, hex) {
  const { data, info } = await sharp(buf).resize(512, 512, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;
  const out = Buffer.alloc(N * 4);
  const [cr, cg, cb] = hexRgb(hex);
  let count = 0, edge = 0;
  for (let i = 0; i < N; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const a = Math.max(0, Math.min(1, (245 - Math.min(r, g, b)) / 60)); // distância do branco
    if (a > 0.5) { count++; const x = i % W, y = (i / W) | 0; if (x < 6 || y < 6 || x >= W - 6 || y >= H - 6) edge++; }
    const k = 0.55 + 0.45 * (lum / 255); // claro → tom mais claro da marca; escuro → cor cheia
    out[i * 4] = Math.round(cr * k + 255 * (1 - k) * (lum / 255) * 0.35);
    out[i * 4 + 1] = Math.round(cg * k + 255 * (1 - k) * (lum / 255) * 0.35);
    out[i * 4 + 2] = Math.round(cb * k + 255 * (1 - k) * (lum / 255) * 0.35);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  const coverage = count / N;
  if (coverage < 0.02 || coverage > 0.45 || edge > W * 0.5) return null;
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).trim({ threshold: 10 }).png().toBuffer();
}

// Símbolo sem texto pela IA de imagem, limpo e na cor da marca; null se falhar
async function drawSymbol({ name, colorName, hex, hint, generate, toBuffer }) {
  const prompt = [
    `A single simple flat icon (logo symbol) for a brand${hint ? ` in the field of ${hint}` : ''}, solid ${colorName || 'blue'} shapes.`,
    'Centered, small, on a PURE WHITE (#FFFFFF) background with lots of empty white space around it.',
    'NOT an app icon: no rounded square tile, no frame, no background shapes, no pattern, no gradient, no shadow, no mockup.',
    'ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO NUMBERS.',
  ].join(' ');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = await generate(prompt, { width: 1024, height: 1024 });
      if (!url) continue;
      const clean = await processSymbol(await toBuffer(url), hex || '#1d4ed8');
      if (clean) return clean;
      console.warn(`logoMaker: símbolo rejeitado (tentativa ${attempt})`);
    } catch (e) {
      console.error('logoMaker: símbolo falhou:', e.message);
    }
  }
  return null;
}

module.exports = { pickLogoLayout, iconFor, businessOf, isLogoRequest, extractName, extractColor, businessHint, composeLogo, drawSymbol, processSymbol, COLORS };
