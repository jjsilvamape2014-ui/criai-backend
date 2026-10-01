// 🏷️ Nome da marca para os vídeos, sem o cliente precisar repetir.
//  1) resolveBrand: usa o que já se sabe (projeto); senão, pede à IA para achar o nome
//     no pedido e no TEXTO DA LOGO (a visão do Cérebro já transcreve os textos das imagens).
//  2) mentions/ensure*: confere se a fala cita a marca e, se não citar, inclui —
//     garantia que não depende de a IA "lembrar".
const { callLLM } = require('./llm');

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function mentions(text, brand) {
  if (!brand) return true;
  const t = norm(text);
  const b = norm(brand);
  if (t.includes(b)) return true;
  // "JN Refrigeração" conta como citado se a primeira palavra forte aparece ("JN")
  const first = b.split(' ')[0];
  return first.length >= 2 && new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t);
}

// "Sua Empresa", "[Nome da empresa]", "Minha loja"… não são nomes: é a IA sem saber
function isGenericBrand(s) {
  if (isThirdPartyBrand(s)) return true;
  const n = norm(String(s || '').replace(/[[\]{}()"“”'`*]/g, ''));
  return !n || /^(a |o |da |do )?(sua|seu|minha|meu|nossa|nosso|a|o)? ?(empresa|marca|loja|negocio|companhia|comercio|nome( da (empresa|marca|loja))?)( aqui)?$/.test(n) ||
    /^(nome da|seu negocio|your (company|brand)|company name|brand name)/.test(n);
}

// marcas de plataformas/terceiros que aparecem em produtos e prints — nunca são o cliente
const THIRD_PARTY = /^(google( meu neg[óo]cio| maps| business)?|instagram|facebook|meta|whatsapp( business)?|ifood|mercado ?(livre|pago)|shopee|amazon|magalu|youtube|tiktok|kwai|apple|iphone|samsung|motorola|xiaomi|coca[- ]?cola|visa|mastercard|pix|nfc|qr ?code|uber|99)$/i;
function isThirdPartyBrand(s) {
  return THIRD_PARTY.test(norm(String(s || '').replace(/[®™]/g, '')));
}

function cleanName(s) {
  const n = String(s || '').replace(/["“”'`*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 50 || /^(nenhum|nenhuma|n[ãa]o (sei|informado)|desconhecid)/i.test(n) || isGenericBrand(n) || isThirdPartyBrand(n)) return null;
  return n;
}

async function resolveBrand({ project, request, refCaptions }) {
  if (project && project.brand && !isGenericBrand(project.brand)) return project.brand;
  const caps = (refCaptions || []).filter(Boolean);
  const sys = [
    'Você extrai o NOME DA EMPRESA/MARCA para um anúncio.',
    'Use o pedido do cliente e o texto que aparece nas imagens enviadas (normalmente a logo).',
    'Responda SOMENTE o nome, exatamente como está escrito (ex.: JN Refrigeração). Sem aspas, sem explicação.',
    'Na logo, a sigla e a palavra do ramo logo abaixo formam o nome completo: "JN" + "REFRIGERAÇÃO" = JN Refrigeração; "SOL" + "PROVEDOR DE INTERNET" = SOL Provedor de Internet. Slogans (ex.: "Climatização com qualidade") NÃO fazem parte do nome.',
    'Escreva em maiúsculas/minúsculas normais, mantendo siglas em maiúsculas (JN, XYZ).',
    'Se não houver nome de empresa, responda NENHUM.'
  ].join('\n');
  const user = [`Pedido: ${request}`, caps.length ? `Imagens enviadas: ${caps.join(' | ')}` : ''].filter(Boolean).join('\n');
  try {
    return cleanName(await callLLM(sys, user, { temperature: 0, maxTokens: 30 }));
  } catch (e) {
    console.error('brandInfo: não consegui descobrir a marca:', e.message);
    return null;
  }
}

// A IA às vezes corta o nome: "XYZ Tecnologia" quando o cliente escreveu
// "XYZ Tecnologia em Concreto". Se no texto do cliente o nome continua com
// conector + palavra com maiúscula, usa o nome inteiro como ele escreveu.
function extendBrand(message, brand) {
  const b = String(brand || '').trim();
  if (!b) return b;
  const m = String(message || '');
  const i = m.toLowerCase().indexOf(b.toLowerCase());
  if (i < 0) return b;
  const rest = m.slice(i + b.length);
  // com conector ("em Concreto", "e Filhos") só se a palavra for de ramo/sociedade:
  // "JN Refrigeração em Belém" é a cidade, não o nome
  const SEG = /^(concreto|constru\w*|tecnologia|refrigera\w*|climatiza\w*|engenharia|inform[aá]tica|servi[cç]os|transportes?|log[ií]stica|alimentos|beleza|est[eé]tica|sa[uú]de|m[oó]veis|materiais|equipamentos|im[oó]veis|seguros|eventos|turismo|viagens|moda|cal[cç]ados|filhos|irm[aã]os|cia|companhia|associados|advogados|contabilidade|com[eé]rcio|ind[uú]stria|energia|solar|pe[cç]as|ve[ií]culos|automa[cç][aã]o|seguran[cç]a)$/i;
  const STOP = /^(em|de|do|da|e|whats[^\s]*|zap|instagram|insta|facebook|tiktok|telefone|tel|fone|contato|endere[^\s]*|rua|av|avenida|site|email|pre[çc]o|promo[^\s]*|hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|cidade|bairro|centro|n[ãa]o|sem|com|para|pra|quero|fa[çz]a?|cria|v[íi]deo|an[úu]ncio|post|logo)$/i;
  let out = m.slice(i, i + b.length);
  let r = rest;
  for (let k = 0; k < 3; k++) {
    const plain = r.match(/^\s+([A-ZÀ-Ú][\wÀ-ú'-]*)/);
    const conn = r.match(/^\s+(em|de|do|da|dos|das|e|&)\s+([A-ZÀ-Ú][\wÀ-ú'-]*)/);
    if (conn && SEG.test(conn[2])) { out += conn[0]; r = r.slice(conn[0].length); continue; }
    if (plain && !STOP.test(plain[1])) { out += plain[0]; r = r.slice(plain[0].length); continue; }
    break;
  }
  return out.trim();
}

module.exports = { extendBrand, resolveBrand, mentions, norm, isGenericBrand, isThirdPartyBrand };
