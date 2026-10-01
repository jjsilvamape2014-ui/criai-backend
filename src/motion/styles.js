// 🎨 ESTILOS VISUAIS do vídeo animado (tipografia + transições)
//
// Cada pedido ganha o estilo que combina com ele, escolhido em CÓDIGO (previsível e
// testável), nesta ordem:
//   1) o cliente pediu ("estilo elegante", "mais sofisticado", "bem chamativo"...)
//   2) tom do pedido (promoção/oferta → Impacto)
//   3) ramo do negócio (salão → Elegante, ar-condicionado → Tecnológico, pizzaria → Impacto)
//   4) sugestão do diretor (IA), se veio uma válida
//   5) Moderno
// Fontes: todas SIL Open Font License (uso comercial livre), em assets/fonts.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const STYLES = {
  moderno: {
    name: 'Moderno',
    font: 'Poppins',
    widthK: 1,
    transitions: ['slideUp', 'fade', 'slideLeft', 'fade'],
    dur: 0.45
  },
  impacto: {
    name: 'Impacto',
    font: 'Anton',
    widthK: 0.74,
    flatWeight: true, // Anton só tem um peso: negrito sintético borra as letras
    transitions: ['zoomPunch', 'flash', 'slideLeft', 'zoomPunch', 'flash'],
    dur: 0.32
  },
  elegante: {
    name: 'Elegante',
    font: 'Playfair Display',
    widthK: 1.04,
    transitions: ['iris', 'fade', 'iris', 'fade'],
    dur: 0.75
  },
  tecnologico: {
    name: 'Tecnológico',
    font: 'Montserrat',
    widthK: 1.13,
    transitions: ['wipe', 'push', 'wipe', 'push'],
    dur: 0.42
  }
};
const KEYS = Object.keys(STYLES);

const has = (t, re) => re.test(t);
// (^|\W) em vez de \b: o texto já está sem acento, mas mantém o padrão do projeto
const W = (words) => new RegExp(`(^|[^a-z])(${words})`);

const EXPLICIT = [
  ['elegante', W('estilo (elegante|sofisticado|luxo|premium|classico|chique)|elegante|sofisticad|luxuos|requintad|chique|delicad|premium')],
  ['impacto', W('estilo (impacto|varejo|chamativo|promocional)|chamativ|impactante|bem forte|agressiv|estilo varejo')],
  ['tecnologico', W('estilo (tecnologico|tech|futurista|digital)|futurist|tecnologic|estilo tech|high tech')],
  ['moderno', W('estilo (moderno|clean|simples|minimalista)|minimalista|clean')]
];
const PROMO = W('promo|oferta|liquida|queima|desconto|black friday|imperdivel|saldao|\\d+ ?% ?off|precos? baix|so hoje|mes do cliente');
const BUSINESS = [
  ['elegante', W('salao de beleza|cabeleire|barbearia|estetica|spa|manicure|sobrancelha|cilios|maquiagem|joia|joalheria|perfum|boutique|moda feminina|advoca|advogad|clinica|odonto|dentist|psicolog|nutricion|noiva|casamento|buffet|decoracao|arquitet|cafeteria|vinho|confeitaria|doceria|bolos|floricultura|imobiliaria|hotel|pousada')],
  ['impacto', W('supermercado|mercado|mercadinho|atacad|loja|pizzaria|pizza|lanchonete|hamburgu|lanche|acai|acougue|hortifruti|feira|pastel|delivery|autopecas|auto pecas|material de construcao|depositos?|calcados|roupas|bar |churrasc|sorveteria|padaria')],
  ['tecnologico', W('tecnolog|informatica|software|aplicativo|sistema|internet|provedor|energia solar|solar|seguranca eletronica|cameras?|cftv|alarme|automacao|engenharia|concreto|industria|ar[- ]?condicionado|refrigeracao|climatiza|eletric|eletronic|celular|assistencia tecnica|computador|games?|robotic|drone|startup|saas')]
];

function pickStyle(request, project, llmStyle) {
  const t = norm(request);
  // o pedido mais recente manda ("...Ajuste pedido pelo cliente no vídeo anterior: estilo elegante")
  const parts = t.split(/ajuste pedido pelo cliente no video anterior:/).reverse();
  for (const part of parts) for (const [k, re] of EXPLICIT) if (has(part, re)) return { key: k, why: 'pedido' };
  if (has(t, PROMO)) return { key: 'impacto', why: 'promoção' };
  const ctx = norm([request, project && project.brand, ((project && project.facts) || []).map((f) => f.value).join(' ')].join(' '));
  for (const [k, re] of BUSINESS) if (has(ctx, re)) return { key: k, why: 'ramo' };
  const l = norm(llmStyle).replace(/[^a-z]/g, '');
  if (KEYS.includes(l)) return { key: l, why: 'diretor' };
  return { key: 'moderno', why: 'padrão' };
}

// "estilo elegante", "deixa mais chamativo", "quero mais sofisticado" (troca de estilo de um vídeo pronto)
function isStyleChange(message) {
  const t = norm(message);
  return /(^|[^a-z])estilo (moderno|clean|minimalista|impacto|varejo|chamativo|promocional|elegante|sofisticado|luxo|premium|classico|chique|tecnologico|tech|futurista|digital)/.test(t) ||
    /(mais|bem) (elegante|sofisticad|chique|chamativ|impactante|tecnologic|futurist|moderno|clean)/.test(t);
}

const get = (key) => STYLES[key] || STYLES.moderno;
const fontStack = (st) => `${st.font}, Poppins, DejaVu Sans, sans-serif`;

// Troca fonte (e peso, quando a fonte só tem um) no SVG já montado da cena
function applyFont(svg, st, baseFont) {
  if (st.font === 'Poppins') return svg;
  let out = svg.split(`font-family="${baseFont}"`).join(`font-family="${fontStack(st)}"`);
  if (st.flatWeight) out = out.replace(/font-weight="[5-9]00"/g, 'font-weight="400"');
  return out;
}

// Transição da cena que ENTRA (p: 0→1) e da que SAI, no mesmo instante.
// Devolve { inOpen, inClose, outOpen, outClose, overlay } com SVG para envolver as cenas.
function transition(kind, p, { Wd, Hd, id, pal }) {
  const e = (x) => 1 - Math.pow(1 - x, 3);
  const q = e(Math.max(0, Math.min(1, p)));
  const none = { inOpen: '<g>', inClose: '</g>', outOpen: '<g>', outClose: '</g>', overlay: '' };
  switch (kind) {
    case 'slideUp':
      return { ...none, inOpen: `<g transform="translate(0 ${((1 - q) * Hd).toFixed(1)})">`, outOpen: `<g transform="translate(0 ${(-q * Hd * 0.25).toFixed(1)})">` };
    case 'slideLeft':
      return { ...none, inOpen: `<g transform="translate(${((1 - q) * Wd).toFixed(1)} 0)">` };
    case 'push':
      return { ...none, inOpen: `<g transform="translate(${((1 - q) * Wd).toFixed(1)} 0)">`, outOpen: `<g transform="translate(${(-q * Wd).toFixed(1)} 0)">` };
    case 'zoomPunch': {
      const s = 1 + 0.22 * (1 - q);
      const cx = Wd / 2, cy = Hd / 2;
      return { ...none, inOpen: `<g opacity="${Math.min(1, p * 2.5).toFixed(3)}" transform="translate(${cx} ${cy}) scale(${s.toFixed(4)}) translate(${-cx} ${-cy})">`,
        overlay: `<rect width="${Wd}" height="${Hd}" fill="#FFFFFF" opacity="${(Math.max(0, 1 - p * 2.2) * 0.55).toFixed(3)}"/>` };
    }
    case 'flash': {
      const show = p >= 0.5;
      return { ...none, inOpen: `<g opacity="${show ? 1 : 0}">`, outOpen: `<g opacity="${show ? 0 : 1}">`,
        overlay: `<rect width="${Wd}" height="${Hd}" fill="#FFFFFF" opacity="${(1 - Math.abs(2 * p - 1)).toFixed(3)}"/>` };
    }
    case 'wipe': {
      // faixa diagonal que varre da esquerda para a direita, com uma linha na cor da marca
      const k = Hd * 0.32;
      const x = -k + q * (Wd + 2 * k);
      const poly = (dx) => `${-k},0 ${(x + dx + k).toFixed(1)},0 ${(x + dx - k).toFixed(1)},${Hd} ${-k},${Hd}`;
      const line = p < 1 ? `<polygon points="${(x + k).toFixed(1)},0 ${(x + k + 26).toFixed(1)},0 ${(x - k + 26).toFixed(1)},${Hd} ${(x - k).toFixed(1)},${Hd}" fill="${pal.primary}"/>` : '';
      return { ...none, inOpen: `<defs><clipPath id="${id}"><polygon points="${poly(0)}"/></clipPath></defs><g clip-path="url(#${id})">`, overlay: line };
    }
    case 'iris': {
      const r = Math.hypot(Wd, Hd) / 2 * q;
      const ring = p < 1 ? `<circle cx="${Wd / 2}" cy="${Hd / 2}" r="${r.toFixed(1)}" fill="none" stroke="${pal.soft}" stroke-width="3" opacity="${(1 - q).toFixed(3)}"/>` : '';
      return { ...none, inOpen: `<defs><clipPath id="${id}"><circle cx="${Wd / 2}" cy="${Hd / 2}" r="${r.toFixed(1)}"/></clipPath></defs><g clip-path="url(#${id})">`, overlay: ring };
    }
    default: // fade
      return { ...none, inOpen: `<g opacity="${q.toFixed(3)}">` };
  }
}

module.exports = { STYLES, KEYS, pickStyle, isStyleChange, get, applyFont, transition, fontStack };
