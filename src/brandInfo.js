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
  const n = norm(String(s || '').replace(/[[\]{}()"“”'`*]/g, ''));
  return !n || /^(a |o |da |do )?(sua|seu|minha|meu|nossa|nosso|a|o)? ?(empresa|marca|loja|negocio|companhia|comercio|nome( da (empresa|marca|loja))?)( aqui)?$/.test(n) ||
    /^(nome da|seu negocio|your (company|brand)|company name|brand name)/.test(n);
}

function cleanName(s) {
  const n = String(s || '').replace(/["“”'`*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 50 || /^(nenhum|nenhuma|n[ãa]o (sei|informado)|desconhecid)/i.test(n) || isGenericBrand(n)) return null;
  return n;
}

async function resolveBrand({ project, request, refCaptions }) {
  if (project && project.brand && !isGenericBrand(project.brand)) return project.brand;
  const caps = (refCaptions || []).filter(Boolean);
  const sys = [
    'Você extrai o NOME DA EMPRESA/MARCA para um anúncio.',
    'Use o pedido do cliente e o texto que aparece nas imagens enviadas (normalmente a logo).',
    'Responda SOMENTE o nome, exatamente como está escrito (ex.: JN Refrigeração). Sem aspas, sem explicação.',
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

module.exports = { resolveBrand, mentions, norm, isGenericBrand };
