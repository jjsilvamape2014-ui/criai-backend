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
  return /\b(cri\w*|faz\w*|faca|fazer|gera\w*|desenh\w*|quero|queria|preciso|monta\w*)\b[^.]{0,30}\b(logo|logotipo|logomarca)\b/.test(m) &&
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
async function composeLogo({ name, hex, symbol, icon }) {
  const E = require('./motion/engine');
  const W = 1080;
  const fit = E.fitText(name, { size: 150, minSize: 70, maxWidth: 900, maxLines: 2, weight: 800 });
  const lh = fit.size * 1.05;
  const textH = fit.lines.length * lh;
  const symH = 420;
  const gap = 50;
  const top = Math.round((W - (symH + gap + textH)) / 2);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const cy = top + symH / 2;
  const mono = icon
    ? `<circle cx="540" cy="${cy}" r="${symH / 2 - 10}" fill="${hex}"/>${require('./motion/icons').icon(icon, 540, cy, 230, '#ffffff', { strokeWidth: 5 })}`
    : `<circle cx="540" cy="${cy}" r="${symH / 2 - 10}" fill="${hex}"/>
    <text x="540" y="${cy + 70}" font-family="${E.FONT}" font-weight="800" font-size="200" fill="#ffffff" text-anchor="middle">${esc(initials)}</text>`;
  const text = fit.lines.map((l, i) => `<text x="540" y="${(top + symH + gap + fit.size * 0.9 + i * lh).toFixed(0)}" font-family="${E.FONT}" font-weight="800" font-size="${fit.size}" fill="${hex}" text-anchor="middle" letter-spacing="-1">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#ffffff"/>${symbol ? '' : mono}${text}</svg>`;
  const layers = [];
  if (symbol) {
    const s = await sharp(symbol).resize(symH, symH, { fit: 'inside' }).png().toBuffer();
    const sm = await sharp(s).metadata();
    layers.push({ input: s, left: Math.round((W - sm.width) / 2), top: top + Math.round((symH - sm.height) / 2) });
  }
  return sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
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

module.exports = { iconFor, businessOf, isLogoRequest, extractName, extractColor, businessHint, composeLogo, drawSymbol, processSymbol, COLORS };
