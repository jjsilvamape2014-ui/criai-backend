// 🔎 CONFERÊNCIA DO TEXTO NA IMAGEM (antes de entregar)
//
// A IA de imagem erra letras ("Linha Fãcil") e troca palavras. Aqui:
//   1) a visão TRANSCREVE o texto da imagem pronta
//   2) o CÓDIGO compara com o texto que o cliente pediu (não é a IA se autoavaliando)
//   3) quem chama decide: refazer, ou escrever o texto por código (overlayText)
require('./fontSetup');
const sharp = require('sharp');

const squash = (s) => String(s || '').toLowerCase().replace(/[\s"“”'’.,:;!?*_-]+/g, '');

// Só textos que precisam aparecer: entre aspas, preço, %, idade, nomes próprios.
// Números soltos (ex.: tamanho 1080x1350) não contam.
function requiredTexts(tokens) {
  return [...new Set((tokens || []).map((t) => String(t).trim()).filter((t) =>
    t.length >= 2 && (/\p{L}/u.test(t) || /%|R\$/.test(t)) && !/^\d+\s*x\s*\d+$/i.test(t)))].slice(0, 4);
}

async function transcribe(imageUrl) {
  const vision = require('./vision');
  const small = await toDataUrl(imageUrl, 1024);
  const prompt = 'Transcribe ALL text visible in this image exactly as written, keeping accents, spelling and capitalization. One line per text block. If there is no text at all, reply NONE. Reply with the transcription only.';
  const out = await vision.askVision(small, prompt, 300);
  if (out == null) return null;
  return /^\s*none\s*$/i.test(out) ? '' : String(out);
}

// { ok, missing: [...], seen } ou null (sem visão: não bloqueia)
async function verify(imageUrl, texts) {
  const req = requiredTexts(texts);
  if (!req.length) return { ok: true, missing: [], seen: '' };
  let seen;
  try { seen = await transcribe(imageUrl); } catch (e) { return null; }
  if (seen == null) return null;
  const s = squash(seen);
  const missing = req.filter((t) => !s.includes(squash(t)));
  return { ok: !missing.length, missing, seen: seen.slice(0, 300) };
}

async function toBuffer(src) {
  if (String(src).startsWith('data:')) return Buffer.from(String(src).split(',')[1] || '', 'base64');
  const axios = require('axios');
  return Buffer.from((await axios.get(src, { responseType: 'arraybuffer', timeout: 60000 })).data);
}
async function toDataUrl(src, max = 1024) {
  const b = await sharp(await toBuffer(src)).resize(max, max, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${b.toString('base64')}`;
}

// Escreve os textos por código numa faixa embaixo da imagem (sempre certo, com acentos).
// Retorna PNG (buffer).
async function overlayText(imageUrl, texts, { hex = '#1d4ed8' } = {}) {
  const E = require('./motion/engine');
  const img = sharp(await toBuffer(imageUrl));
  const { width: W, height: H } = await img.metadata();
  const [head, ...rest] = requiredTexts(texts).length ? requiredTexts(texts) : texts;
  const hs = Math.round(W * 0.085);
  const fit = E.fitText(String(head || ''), { size: hs, minSize: Math.round(hs * 0.55), maxWidth: W * 0.88, maxLines: 2, weight: 800 });
  const sub = rest.join('  ·  ');
  const subSize = Math.round(W * 0.045);
  const bandH = Math.round(fit.lines.length * fit.size * 1.15 + (sub ? subSize * 1.8 : 0) + W * 0.09);
  const y0 = H - bandH;
  const lines = fit.lines.map((l, i) => `<text x="${W / 2}" y="${(y0 + W * 0.045 + fit.size * (0.95 + i * 1.12)).toFixed(0)}" font-family="${E.FONT}" font-weight="800" font-size="${fit.size}" fill="#ffffff" text-anchor="middle">${E.esc(l)}</text>`).join('');
  const subY = y0 + W * 0.045 + fit.size * (0.95 + (fit.lines.length - 1) * 1.12) + subSize * 1.6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.35" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient></defs>
    <rect x="0" y="${y0 - bandH * 0.4}" width="${W}" height="${bandH * 1.4}" fill="url(#g)"/>
    <rect x="${W / 2 - W * 0.08}" y="${y0 + W * 0.02}" width="${W * 0.16}" height="${Math.max(4, W * 0.008)}" rx="3" fill="${hex}"/>
    ${lines}
    ${sub ? `<text x="${W / 2}" y="${subY.toFixed(0)}" font-family="${E.FONT}" font-weight="700" font-size="${subSize}" fill="#ffffff" text-anchor="middle">${E.esc(sub)}</text>` : ''}
  </svg>`;
  return img.composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
}

module.exports = { requiredTexts, transcribe, verify, overlayText };
