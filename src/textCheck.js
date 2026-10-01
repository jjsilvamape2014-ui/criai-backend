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
  return [...new Set((tokens || []).map((t) => String(t).trim().replace(/[\s.,;:!?]+$/, '')).filter((t) =>
    t.length >= 2 && (/\p{L}/u.test(t) || /%|R\$/.test(t) || /^\(\d{2}\) \d{4,5}-\d{4}$/.test(t)) && !/^\d+\s*x\s*\d+$/i.test(t)))].slice(0, 4);
}

// Textos que precisam sair EXATOS: preço e telefone. A IA de imagem erra dígitos com
// frequência (R$ 499,90; "RBS 49.90") e a visão às vezes "corrige" ao ler, então nesses
// casos o texto é sempre escrito por código.
function exactTexts(message) {
  const s = String(message || '');
  const out = [];
  const phone = s.match(/\(?\b(\d{2})\)?[\s-]*(9?\s?\d{4})[-\s.]?(\d{4})\b/);
  if (phone) out.push(`(${phone[1]}) ${phone[2].replace(/\s/g, '')}-${phone[3]}`);
  for (const m of s.match(/R\$\s*\d[\d.]*(?:,\d{2})?/gi) || []) out.push(m.replace(/R\$\s*/i, 'R$ '));
  return [...new Set(out)];
}

// Textos da peça: os pedidos (aspas, nomes) + preço e telefone, sem repetir o que já
// está dentro de outro ("Pizza grande R$ 49,90" já contém "R$ 49,90")
function pieceTexts(tokens, message, brand = '') {
  const base = requiredTexts(tokens);
  const extra = exactTexts(message).filter((e) => !base.some((b) => squash(b).includes(squash(e))));
  // preço solto ganha o produto que vem antes dele ("pão francês R$ 12,90")
  const withProduct = (e) => {
    if (!/^R\$/.test(e)) return e;
    const before = String(message).split(/R\$/)[0].split(/[:,.;!\n]/).pop().trim().split(/\s+/).slice(-4).join(' ');
    const prod = before.replace(/^(por|a|o|de|com|só|apenas|custa|custando|valor|preço)\s+/i, '').replace(/\s+(por|a|de|é|custa|só)$/i, '').trim();
    return prod && prod.length >= 3 && !/\d/.test(prod) ? `${prod.charAt(0).toUpperCase()}${prod.slice(1)} ${e.replace(/R\$\s*/, 'R$ ')}` : e;
  };
  let items = [...base, ...extra].map(withProduct);
  // o nome da empresa citado no pedido também precisa sair certo ("Ática Visão Clara")
  const b = String(brand || '').trim();
  if (b && squash(message).includes(squash(b)) && !items.some((t) => squash(t).includes(squash(b)))) items = [b, ...items];
  // data/tema do post ("Bom dia!", "Feliz dia das mães!") vira o título, antes do nome
  const occ = String(message).match(/\b(bom dia|boa tarde|boa noite|feliz natal|feliz ano novo|feliz p[áa]scoa|feliz dia d[aoe]s? [\p{L}]+|dia das (m[ãa]es|crian[çc]as|pais|mulheres|namorados)|black friday)\b/iu);
  if (occ && !items.some((t) => squash(t).includes(squash(occ[1])))) {
    const o = occ[1].toLowerCase();
    items = [`${o.charAt(0).toUpperCase()}${o.slice(1)}${/^(bom|boa|feliz)/.test(o) ? '!' : ''}`, ...items];
  }
  // ordem: título → produto e preço → telefone por último
  const all = [...new Set(items)];
  return [...all.filter((t) => !PHONE.test(t)), ...all.filter((t) => PHONE.test(t))].slice(0, 4);
}

async function transcribe(imageUrl) {
  const vision = require('./vision');
  const small = await toDataUrl(imageUrl, 1024);
  const prompt = 'Transcribe ALL text visible in this image character by character, EXACTLY as printed — do NOT fix spelling, digits, currency symbols or punctuation, even if they look wrong (e.g. write "RBS 499.90" if that is what is printed). Keep accents and capitalization. One line per text block. If there is no text at all, reply NONE. Reply with the transcription only.';
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

// Escreve os textos por código sobre a imagem (sempre certo, com acentos), numa das
// composições de textLayouts (a fonte e o layout variam com o pedido). Retorna PNG.
async function overlayText(imageUrl, texts, { hex = '#1d4ed8', message = '', project = null, look = null, layout = null } = {}) {
  const L = require('./textLayouts');
  const img = sharp(await toBuffer(imageUrl));
  const { width: W, height: H } = await img.metadata();
  const list = requiredTexts(texts).length ? requiredTexts(texts) : texts;
  const pick = L.chooseLayout({ texts: list, message, project, look, layout });
  const body = L.layoutSvg({ W, H, texts: list, hex, look: pick.look, layout: pick.layout });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`;
  return img.composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
}

// Tira do prompt tudo que manda escrever texto (senão "sem texto" + "texto em negrito" se contradizem)
function textFreePrompt(prompt) {
  const parts = String(prompt || '').split(/(?<=[.;,])\s+|\n+/);
  const kept = parts.filter((p) => !/\b(text|texts|font|typograph\w*|headline|title|caption|lettering|letters?|words?|wordmark|price|slogan|label|written|printed|reads?|saying)\b|R\$|\*\*|["“”]|%/i.test(p));
  return `${kept.join(' ').trim()}\nABSOLUTELY NO TEXT, NO LETTERS, NO NUMBERS, NO PRICE TAGS, NO SIGNS anywhere in the image. Keep the lower quarter calm (no important subject) for a caption.`;
}

// Recorta/ajusta a imagem para o formato pedido (o gerador às vezes devolve 4:3 num post quadrado)
async function fitAspect(src, width, height) {
  const b = await sharp(await toBuffer(src)).resize(width, height, { fit: 'cover', position: 'attention' }).png().toBuffer();
  return `data:image/png;base64,${b.toString('base64')}`;
}

// Correção de uma peça ("o preço está errado, é R$ 39,90"): mantém os textos da peça
// anterior e troca só o que mudou (preço novo no lugar do antigo, telefone idem).
const PRICE = /R\$\s*\d[\d.]*(?:,\d{2})?/i;
const PHONE = /^\(\d{2}\) \d{4,5}-\d{4}$/;
function mergePieceTexts(prev, cur) {
  const p = (prev || []).slice();
  const c = (cur || []).slice();
  if (!p.length) return c;
  const newPrice = c.find((t) => PRICE.test(t));
  const newPhone = c.find((t) => PHONE.test(t));
  // texto novo entre aspas (sem preço/telefone) substitui o título antigo
  const newHead = c.find((t) => !PRICE.test(t) && !PHONE.test(t));
  // o texto novo substitui a linha do produto/preço (o nome da empresa fica); sem preço, a 1ª linha
  const priceIdx = p.findIndex((t) => PRICE.test(t));
  const headIdx = priceIdx >= 0 ? priceIdx : p.findIndex((t) => !PHONE.test(t));
  let out = p.map((t, i) => {
    if (newPhone && PHONE.test(t)) return newPhone;
    if (newHead && i === headIdx) {
      const oldPrice = t.match(PRICE);
      return oldPrice && !PRICE.test(newHead) ? `${newHead} ${newPrice ? newPrice.match(PRICE)[0] : oldPrice[0]}` : newHead;
    }
    if (newPrice && PRICE.test(t)) return t.replace(PRICE, newPrice.match(PRICE)[0]);
    return t;
  });
  for (const t of c) if (!out.some((o) => squash(o).includes(squash(t)))) out.push(t);
  return [...new Set(out)].slice(0, 4);
}

// "o preço está errado, é R$ 39,90", "troca o telefone para (11) 95555-0000",
// "o texto é \"Pizza gigante\"": só texto muda → a mesma imagem, texto reescrito
function isTextOnlyFix(message) {
  const m = String(message || '');
  if (m.length > 160) return false;
  const hasNewText = exactTexts(m).length > 0 || /["“”][^"“”]{2,40}["“”]/.test(m);
  if (!hasNewText) return false;
  if (/\b(faz|fa[çc]a|cria|crie|gera|gere|nov[oa]|outr[oa])\b/i.test(m)) return false;
  // palavra inteira: "Corte masculino" não é pedido de troca de "cor"
  const outside = m.replace(/["“”][^"“”]*["“”]/g, ' '); // o que está entre aspas é o texto novo, não pedido de mudança
  return !/(^|[^\p{L}])(fundo|cor|cores|foto|fotos|layout|fonte|estilo|tamanho|formato|logo|pessoa|produto|v[íi]deo|anima\p{L}*)(?![\p{L}])/iu.test(outside);
}

module.exports = { toBuffer, isTextOnlyFix, mergePieceTexts, fitAspect, exactTexts, pieceTexts, textFreePrompt, requiredTexts, transcribe, verify, overlayText };
