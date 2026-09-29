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
function extractName(message) {
  const s = String(message || '');
  const q = s.match(/["“']([^"”']{2,40})["”']/);
  if (q) return q[1].trim();
  const m = s.match(/(?:com o nome|com nome|chamad[ao]|de nome|nome(?: da (?:empresa|marca|loja))?(?: [ée])?)\s*[:\-]?\s*(.+?)(?=\s+(?:na|no|nas|nos|em|com|de cor|cor|nas cores|para|pra|que|e\s+(?:na|no|em|com|cor))\b|[,.;!?]|$)/i);
  if (m) {
    const name = m[1].trim().replace(/[.,;:!?]+$/, '');
    if (name.length >= 2 && name.length <= 40 && !/^(minha|meu|a|o|uma|um)\b/i.test(name)) return name;
  }
  // "logo da Linha Fácil" / "logo para Padaria São João" (nome com maiúsculas)
  const cap = s.match(/\blogo\w*\s+(?:da|do|de|para|pra)\s+((?:[A-ZÀ-Ú][\wÀ-ú'&.-]*\s?){1,4})/);
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

const esc = (t) => String(t).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Monta a logo: símbolo (buffer PNG, opcional) em cima, nome embaixo. PNG 1080x1080 fundo branco.
async function composeLogo({ name, hex, symbol }) {
  const E = require('./motion/engine');
  const W = 1080;
  const fit = E.fitText(name, { size: 150, minSize: 70, maxWidth: 900, maxLines: 2, weight: 800 });
  const lh = fit.size * 1.05;
  const textH = fit.lines.length * lh;
  const symH = 420;
  const gap = 50;
  const top = Math.round((W - (symH + gap + textH)) / 2);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const mono = `<circle cx="540" cy="${top + symH / 2}" r="${symH / 2 - 10}" fill="${hex}"/>
    <text x="540" y="${top + symH / 2 + 70}" font-family="${E.FONT}" font-weight="800" font-size="200" fill="#ffffff" text-anchor="middle">${esc(initials)}</text>`;
  const text = fit.lines.map((l, i) => `<text x="540" y="${(top + symH + gap + fit.size * 0.9 + i * lh).toFixed(0)}" font-family="${E.FONT}" font-weight="800" font-size="${fit.size}" fill="${hex}" text-anchor="middle" letter-spacing="-1">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#ffffff"/>${symbol ? '' : mono}${text}</svg>`;
  const layers = [];
  if (symbol) {
    const s = await sharp(symbol).resize(symH, symH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).flatten({ background: '#ffffff' }).png().toBuffer();
    layers.push({ input: s, left: Math.round((W - symH) / 2), top });
  }
  return sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
}

// Símbolo sem texto pela IA de imagem; null se falhar
async function drawSymbol({ name, colorName, hint, generate, toBuffer }) {
  const prompt = [
    `Minimal flat vector logo SYMBOL (icon only) for a brand${hint ? ` in the field of ${hint}` : ''}.`,
    `Main color: ${colorName || 'blue'}. Simple geometric shapes, bold and clean, centered on a pure white background, generous margin.`,
    'ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO NUMBERS anywhere in the image. Icon only. No mockup, no shadow, no gradient background.',
  ].join(' ');
  try {
    const url = await generate(prompt, { width: 1024, height: 1024 });
    return url ? await toBuffer(url) : null;
  } catch (e) {
    console.error('logoMaker: símbolo falhou (usando monograma):', e.message);
    return null;
  }
}

module.exports = { isLogoRequest, extractName, extractColor, businessHint, composeLogo, drawSymbol, COLORS };
