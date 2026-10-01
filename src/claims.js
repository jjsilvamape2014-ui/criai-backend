// 🚫 PROMESSAS QUE A IA NÃO PODE INVENTAR
//
// A IA de texto "enfeita" anúncios com promessas que o cliente nunca fez
// ("oferta por tempo limitado", "garantia", "suporte 24h", "frete grátis"...).
// Aqui, em código: uma promessa só fica se o CLIENTE a mencionou (pedido, conversa
// ou fatos do projeto). Senão:
//   - na fala (voice/narração): a frase inteira sai
//   - em textos de tela: só o trecho da promessa sai
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// [nome, regex da promessa (sem acento), palavras que, se o cliente usou, liberam a promessa]
const CLAIMS = [
  ['tempo limitado', /\b(por )?tempo limitado\b|\bso (hoje|ate hoje|essa semana|este mes)\b|\bsomente hoje\b|\bultimas? (unidades|vagas|horas|dias)\b|\bcorra\b|\bnao perca\b|\bimperdivel\b|\bvagas limitadas\b|\b(promocao|oferta) relampago\b|\bate o fim (da|do|desta|deste) (semana|mes)\b/, ['limitad', 'ultima', 'so hoje', 'somente hoje', 'corra', 'imperdivel']],
  ['garantia', /\b(com )?garantia( de \d+ \w+| total)?\b|\bgarantid[oa]s?\b|\bgarant(e|em|imos|ir|indo)\b|\bsatisfacao garantida\b|\bdinheiro de volta\b/, ['garant']],
  ['24 horas', /\b((suporte|atendimento|plantao) )?24 ?h(oras)?\b|\b24\/7\b|\bplantao\b/, ['24']],
  ['gratis', /\b((com )?(frete|entrega|instalacao|avaliacao|orcamento|visita|consulta|brinde) )?(gratis|gratuit[oa]s?)\b|\bfree\b|\bsem custo\b|\bde graca\b/, ['grat', 'sem custo', 'de graca', 'free']],
  ['desconto', /\bdesconto\b|\b\d{1,2} ?% ?(off|de desconto)?\b|\boff\b/, ['desconto', '%', 'off']],
  ['prazo', /\bno prazo( certo)?\b|\bem (ate )?\d+ ?(h|hs|horas|dias|minutos|min)\b|\bpontualidade\b|\bpontua(l|is)\b|\bentrega (rapida|no mesmo dia|expressa|imediata)\b|\bno mesmo dia\b|\bna hora\b|\bimediatamente\b/, ['prazo', 'pontual', 'mesmo dia', 'rapid', 'express', 'imediat', 'na hora']],
  ['melhor/menor preco', /\b(melhor|menor) (preco|custo|valor)\b|\bmais barat[oa]\b|\bpreco imbativel\b|\bmelhor custo[- ]beneficio\b/, ['melhor preco', 'menor preco', 'barat', 'imbativel', 'custo-beneficio', 'custo beneficio']],
  ['lider / numero 1', /\b(o|a) unic[oa]\b|\bunic[oa] (da|na|do|no|em) (regiao|cidade|bairro|mercado)\b|\bexclusividade\b|\blider(es)?\b|\bnumero 1\b|\bn[ºo°]\.? ?1\b|\bo melhor da (regiao|cidade|bairro)\b|\breferencia (na|em)\b/, ['lider', 'numero 1', 'n 1', 'melhor da', 'referencia', 'unic', 'exclusiv']],
  ['experiencia', /\b\d+ anos (de|no) (experiencia|mercado)\b|\bmais de \d+ (anos|clientes|mil)\b|\b\d+ mil clientes\b/, ['anos', 'clientes', 'mil']],
  ['certificado', /\bcertificad[oa]s?\b|\bcertificacao\b|\bnbr\b|\biso ?\d+\b|\baprovad[oa] pel[oa]\b/, ['certific', 'nbr', 'iso', 'aprovad']],
  ['economia', /\b(economi\w*|reduz\w*|diminu\w*|poup\w*) (de |na |a |sua |seu |o |com )?(energia|conta de luz|conta|luz)\b|\bmenor conta\b/, ['econom', 'conta de luz', 'energia']],
  ['detalhe inventado', /\bprodutos? (importad\w*|de primeira( linha)?|profissionais|de luxo)\b|\bpremium\b|\baditivos?( especia\w*)?\b|\bequipe (qualificada|especializada|experiente|altamente \w+)\b|\bespecialistas?\b|\bprofissionais (qualificad\w*|experientes|certificad\w*|especializad\w*)\b|\b(de )?alta qualidade\b|\bqualidade (superior|premium|garantida)\b|\btecnologia de ponta\b|\bequipamentos? (modernos?|de ultima geracao)\b/, ['premium', 'importad', 'de primeira', 'aditiv', 'qualificad', 'especializ', 'especialist', 'experient', 'certificad', 'alta qualidade', 'superior', 'de ponta', 'ultima geracao', 'moderno', 'luxo']],
  ['avaliacao/orcamento gratis', /\b(avaliacao|orcamento|visita|diagnostico) (tecnic[oa] )?(gratis|gratuit[oa]|sem compromisso)\b/, ['grat', 'sem compromisso']],
];

// Promessas presentes no texto que o cliente NÃO liberou
function disallowed(text, source) {
  const t = norm(text);
  const src = norm(source);
  return CLAIMS.filter(([, re, allow]) => re.test(t) && !allow.some((a) => src.includes(a))).map(([name]) => name);
}

// fala: remove as frases com promessa não liberada
function cleanVoice(text, source) {
  const s = String(text || '');
  if (!disallowed(s, source).length) return s;
  // frase com promessa sai INTEIRA (cortar só o trecho deixava frases quebradas:
  // "com peças.", "Qualidade, rapidez e que protegem..."). Se nada sobrar, corta o trecho.
  const out = (s.match(/[^.!?]+[.!?]*/g) || []).map((y) => y.trim()).filter((x) => x && !disallowed(x, source).length);
  // tudo tinha promessa → vazio (quem chama usa o título/legenda da cena no lugar)
  return out.join(' ');
}

// texto de tela: remove só o trecho da promessa
function cleanText(text, source) {
  let s = String(text || '');
  const bad = disallowed(s, source);
  if (!bad.length) return s;
  for (const [name, re] of CLAIMS) {
    if (!bad.includes(name)) continue;
    // aplica a regex (sem acento) na versão sem acento e corta nas mesmas posições
    const n = norm(s);
    const g = new RegExp(re.source, 'g');
    let m; const cuts = [];
    while ((m = g.exec(n))) { cuts.push([m.index, m.index + m[0].length]); if (!m[0].length) g.lastIndex++; }
    for (const [a, b] of cuts.reverse()) s = s.slice(0, a) + s.slice(b);
  }
  // conectores que ficaram soltos ("com e", "e ." ...)
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\b(com|de|por|para|em|e|ou)\s+(?=(e|ou)\b)/gi, '')
      .replace(/\s+\b(com|de|por|para|em|e|ou|a|o)\s*(?=[,.!?]|$)/gi, '');
  }
  s = s.replace(/^\s*(e|ou|com|de)\s+/i, '');
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '').replace(/\s+([,.!?])/g, '$1').trim();
}

// objeto de roteiro inteiro (chaves voice/narration → fala; resto → tela)
function cleanPlan(v, source, key = '') {
  if (Array.isArray(v)) return v.map((x) => cleanPlan(x, source, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = /^(brief|warnings|debug)$/.test(k) ? v[k] : cleanPlan(v[k], source, k);
    return o;
  }
  if (typeof v !== 'string') return v;
  return /voice|narration|fala|corpo/i.test(key) ? cleanVoice(v, source) : cleanText(v, source);
}

// tudo que o CLIENTE disse (pedido, fatos do projeto, texto das imagens dele)
function sourceOf({ request = '', project = {}, refCaptions = [] } = {}) {
  const p = project || {};
  return [request, p.brand, (p.facts || []).map((f) => `${f.key} ${f.value}`).join(' '), (refCaptions || []).join(' ')].filter(Boolean).join(' ');
}

module.exports = { sourceOf, disallowed, cleanVoice, cleanText, cleanPlan, CLAIMS };
