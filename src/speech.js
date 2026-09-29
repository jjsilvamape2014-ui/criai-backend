// 🗣️ Texto → texto FALÁVEL para a voz (Kokoro PT-BR)
//
// A voz lê o que recebe. Siglas em maiúsculas ("XYZ", "JN") saem estranhas, e o
// nome da empresa às vezes tem uma pronúncia própria. Antes de cada fala:
//   1) aplica as pronúncias que o cliente ensinou ("XYZ, pronuncia xis ípsilon zê")
//   2) soletra siglas sem vogal ou de 2 letras ("XYZ" → "xis ípsilon zê")
//   3) palavras inteiras em maiúsculas viram minúsculas ("PROMOÇÃO" → "promoção")

const LETTERS = {
  A: 'á', B: 'bê', C: 'cê', D: 'dê', E: 'é', F: 'éfe', G: 'gê', H: 'agá', I: 'i', J: 'jota',
  K: 'cá', L: 'éle', M: 'ême', N: 'ene', O: 'ó', P: 'pê', Q: 'quê', R: 'érre', S: 'ésse',
  T: 'tê', U: 'u', V: 'vê', W: 'dáblio', X: 'xis', Y: 'ípsilon', Z: 'zê'
};

function spell(word) {
  return word.split('').map((c) => LETTERS[c] || c).join(' ');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lê do pedido do cliente como um nome deve ser falado. Aceita, por exemplo:
//   "XYZ (pronuncia xis ípsilon zê)", "XYZ, fala-se xiz", "pronúncia de XYZ: xiz",
//   "XYZ se pronuncia xiz", "XYZ lê-se xiz"
function parsePronunciations(text) {
  const t = String(text || '');
  const out = {};
  // "pronúncia de XYZ: xiz"
  const re2 = /pron[uú]ncia\s+(?:de|do|da)\s+["“']?([^"”':]{1,40}?)["”']?\s*[:=]\s*["“']?([^"”'),.;\n]{1,60})/giu;
  let m;
  while ((m = re2.exec(t))) out[m[1].trim()] = m[2].trim();
  // "<nome> (pronuncia xiz)", "<nome>, fala-se xiz", "<nome> se pronuncia xiz"
  const re1 = /(?:\(|,|-|:)?\s*(?:pronuncia(?:-se)?|se pronuncia|fala-se|se fala|l[eê]-se|se l[eê])\s*(?:é|como|:)?\s*["“']?([^"”'),.;\n]{1,60})/giu;
  while ((m = re1.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 60), m.index).replace(/pron[uú]ncia\s+(?:de|do|da)[^\n]*$/i, '');
    const tokens = before.split(/[^\p{L}\d&'.-]+/u).filter(Boolean);
    // o nome é o último token com letra maiúscula (sigla ou nome próprio); senão, o último
    const name = [...tokens].reverse().find((w) => /^\p{Lu}/u.test(w)) || tokens[tokens.length - 1];
    if (name && !/^(de|da|do|o|a|e)$/i.test(name)) out[name.replace(/[.'-]+$/, '')] = m[1].trim();
  }
  return out;
}

// ---------- números por extenso (para a voz não ler "noventa e nove mil...") ----------
const UN = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEN = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
function extenso(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > 999999) return String(n);
  if (n < 20) return UN[n];
  if (n < 100) return DEZ[Math.floor(n / 10)] + (n % 10 ? ' e ' + UN[n % 10] : '');
  if (n === 100) return 'cem';
  if (n < 1000) return CEN[Math.floor(n / 100)] + (n % 100 ? ' e ' + extenso(n % 100) : '');
  const mil = Math.floor(n / 1000);
  const resto = n % 1000;
  const head = mil === 1 ? 'mil' : extenso(mil) + ' mil';
  if (!resto) return head;
  return head + (resto < 100 || resto % 100 === 0 ? ' e ' : ' ') + extenso(resto);
}
const DIG = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const digitos = (d) => d.split('').map((c) => DIG[+c]).join(' ');

// "(91) 99987-9932" → "noventa e um, nove nove nove oito sete, nove nove três dois"
function falarTelefone(s) {
  return s.replace(/(\(?\b(\d{2})\)?\s*)?\b(9?\d{4})[-\s.]?(\d{4})\b/g, (m, _p, ddd, a, b) => {
    if (!ddd && !/[-\s.]/.test(m)) return m; // número solto sem cara de telefone
    return `${ddd ? extenso(+ddd) + ', ' : ''}${digitos(a)}, ${digitos(b)}`;
  }).replace(/\b(\d{2})(9?\d{4})(\d{4})\b/g, (m, ddd, a, b) => `${extenso(+ddd)}, ${digitos(a)}, ${digitos(b)}`); // tudo junto: 91999879932
}

// "R$ 49,90" → "quarenta e nove reais e noventa centavos"; "R$ 80,00" → "oitenta reais"
function falarDinheiro(s) {
  return s.replace(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g, (m, inteiro, cent) => {
    const r = parseInt(inteiro.replace(/\./g, ''), 10);
    const c = cent ? parseInt(cent, 10) : 0;
    const reais = r ? `${extenso(r)} ${r === 1 ? 'real' : 'reais'}` : '';
    const cents = c ? `${extenso(c)} ${c === 1 ? 'centavo' : 'centavos'}` : '';
    return [reais, cents].filter(Boolean).join(' e ') || 'zero reais';
  });
}

function speakable(text, { pronunciations = {} } = {}) {
  let s = falarTelefone(falarDinheiro(require('./placeholders').normalize(text || '')));
  // 1) pronúncias ensinadas (maior primeiro, para "XYZ Concreto" ganhar de "XYZ")
  for (const word of Object.keys(pronunciations).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(^|[^\\p{L}\\d])${escapeRe(word)}(?=$|[^\\p{L}\\d])`, 'giu'), (_, pre) => pre + pronunciations[word]);
  }
  // 2) e 3) palavras em maiúsculas (ignora o que já foi trocado, que vem em minúsculas)
  s = s.replace(/(^|[^\p{L}\d])([A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]{2,})(?=$|[^\p{L}\d])/gu, (_, pre, w) => {
    const plain = w.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hasVowel = /[AEIOU]/.test(plain);
    if (!hasVowel || (plain.length === 2 && plain === w)) return pre + spell(plain);
    return pre + w.toLowerCase();
  });
  return s;
}

module.exports = { speakable, parsePronunciations, spell, extenso };
