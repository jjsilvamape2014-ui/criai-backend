// 🚫 Nada de "[Nome da empresa]" ou "(XX) XXXX-XXXX" no vídeo.
//
// Quando a IA não sabe um dado, às vezes escreve um marcador de modelo em vez de
// contornar. Isso ia para a tela e para a voz. Aqui:
//   - marcadores de nome viram a marca (se conhecida)
//   - frase falada com marcador restante é removida
//   - texto de tela com marcador fica vazio (quem chama usa o texto padrão)
// Também troca hífens/espaços especiais que a fonte não tem ("custo‑benefício").

const BRAND_SLOT = /\[\s*(nome\s+da\s+(empresa|marca|loja)|sua\s+(empresa|marca|loja)|empresa|marca|loja)\s*\]/gi;
const PLACEHOLDER = /\[[^\]]{1,60}\]|\{[^}]{1,60}\}|\(\s*XX\s*\)|X{3,}|\bXX\b|lorem ipsum/i;

function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/[‐‑‒−]/g, '-')
    .replace(/[   ]/g, ' ');
}

function hasPlaceholder(s) {
  return PLACEHOLDER.test(String(s || ''));
}

function fillBrand(s, brand) {
  return brand ? normalize(s).replace(BRAND_SLOT, brand) : normalize(s);
}

// texto de tela: devolve '' se sobrar marcador
function cleanText(s, brand) {
  const t = fillBrand(s, brand).replace(/\s+/g, ' ').trim();
  return hasPlaceholder(t) ? '' : t;
}

// fala: tira só as frases com marcador
function cleanVoice(s, brand) {
  const t = fillBrand(s, brand).replace(/\s+/g, ' ').trim();
  if (!hasPlaceholder(t)) return t;
  return (t.match(/[^.!?]+[.!?]*/g) || []).map((x) => x.trim()).filter((x) => x && !hasPlaceholder(x)).join(' ');
}

// limpa um roteiro inteiro (objeto/array vindo da IA): "voice" como fala, o resto como tela
function cleanPlan(v, brand, key = '') {
  if (Array.isArray(v)) return v.map((x) => cleanPlan(x, brand, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cleanPlan(v[k], brand, k);
    return o;
  }
  if (typeof v !== 'string') return v;
  return /voice|narration/i.test(key) ? cleanVoice(v, brand) : cleanText(v, brand);
}

module.exports = { normalize, hasPlaceholder, cleanText, cleanVoice, cleanPlan };
