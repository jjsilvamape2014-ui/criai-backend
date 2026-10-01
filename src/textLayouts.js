// 🧩 LAYOUTS DE TEXTO SOBRE A IMAGEM (preço, telefone e título escritos por código)
//
// Antes era sempre a mesma faixa escura embaixo, com a mesma fonte: todo post parecia
// o mesmo modelo. Agora há 5 composições e a fonte segue o estilo do negócio
// (salão → Playfair, pizzaria/promoção → Anton, técnico → Montserrat, resto → Poppins).
// A escolha é por código: o estilo do pedido define as composições possíveis e o
// próprio pedido sorteia uma delas (pedidos diferentes → peças diferentes; o mesmo
// pedido refeito → a mesma composição, para a correção de texto não "pular").
const E = require('./motion/engine');
const ST = require('./motion/styles');

const PRICE = /R\$\s*\d[\d.]*(?:,\d{2})?/i;
const PHONE = /^\(\d{2}\) \d{4,5}-\d{4}$/;

const BY_LOOK = {
  moderno: ['band', 'top', 'tag', 'panel'],
  impacto: ['tag', 'panel', 'band'],
  elegante: ['frame', 'band', 'top'],
  tecnologico: ['panel', 'top', 'tag']
};

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

function chooseLayout({ texts, message = '', project = null, look = null, layout = null }) {
  const key = look || ST.pickStyle(message, project).key;
  const opts = BY_LOOK[key] || BY_LOOK.moderno;
  if (layout && opts.concat(['band', 'top', 'tag', 'panel', 'frame']).includes(layout)) return { look: key, layout };
  const hasPrice = (texts || []).some((t) => PRICE.test(t));
  const list = hasPrice ? opts : opts.filter((o) => o !== 'tag');
  return { look: key, layout: list[hash(`${message}|${(texts || []).join('|')}`.replace(/R\$\s*[\d.,]+/g, '')) % list.length] };
}

const txt = (x, y, s, { size, weight = 800, fill = '#fff', anchor = 'middle', font, spacing = 0 }) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" font-family="${font}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}">${E.esc(s)}</text>`;

// Monta o SVG da composição. texts: [título, ...extras] (extras = telefone/preço/linhas curtas)
function layoutSvg({ W, H, texts, hex = '#1d4ed8', look = 'moderno', layout = 'band' }) {
  const st = ST.get(look);
  const font = ST.fontStack(st);
  const heavy = st.flatWeight ? 400 : 800;
  const mid = st.flatWeight ? 400 : 700;
  const pal = E.palette(hex);
  return E.withWidth(st.widthK, () => {
    let [head, ...rest] = texts;
    head = String(head || '');
    const sub = rest.join('  ·  ');
    // linha de baixo nunca passa da borda: diminui a fonte até caber
    let subSize = Math.round(W * 0.042);
    while (sub && subSize > W * 0.024 && E.textWidth(sub, subSize, 700) > W * 0.84) subSize -= 2;

    if (layout === 'tag') {
      // selo de preço no canto + título alinhado à esquerda embaixo
      const all = [head, ...rest];
      const price = (all.find((t) => PRICE.test(t)) || '').match(PRICE);
      const priceTxt = price ? price[0].replace(/R\$\s*/i, 'R$ ') : '';
      const title = head.replace(PRICE, '').replace(/\s{2,}/g, ' ').trim();
      const extras = rest.filter((t) => !PRICE.test(t) || t.replace(PRICE, '').trim()).map((t) => t.replace(PRICE, '').trim()).filter(Boolean);
      const r = W * 0.17;
      const cx = W - r - W * 0.05, cy = r + W * 0.05;
      const pf = E.fitText(priceTxt, { size: Math.round(r * 0.62), minSize: Math.round(r * 0.3), maxWidth: r * 1.7, maxLines: 1, weight: heavy });
      const tf = E.fitText(title, { size: Math.round(W * 0.085), minSize: Math.round(W * 0.05), maxWidth: W * 0.86, maxLines: 2, weight: heavy });
      const bandH = (title ? tf.lines.length * tf.size * 1.12 : 0) + (extras.length ? subSize * 2.4 : 0) + W * 0.1;
      const y0 = H - bandH;
      return `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.4" stop-color="#000" stop-opacity="0.6"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient></defs>
        ${title || extras.length ? `<rect x="0" y="${y0 - bandH * 0.35}" width="${W}" height="${bandH * 1.35}" fill="url(#g)"/>` : ''}
        ${priceTxt ? `<g transform="rotate(-8 ${cx} ${cy})"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${pal.primary}" stroke="#fff" stroke-width="${W * 0.008}"/>${txt(cx, cy + pf.size * 0.36, pf.lines[0] || '', { size: pf.size, weight: heavy, font })}</g>` : ''}
        ${tf.lines.map((l, i) => txt(W * 0.07, y0 + W * 0.05 + tf.size * (0.9 + i * 1.1), l, { size: tf.size, weight: heavy, anchor: 'start', font })).join('')}
        ${extras.length ? `<rect x="${W * 0.07}" y="${H - W * 0.05 - subSize * 1.9}" width="${Math.min(W * 0.86, E.textWidth(extras.join('  ·  '), subSize, 700) + subSize * 1.6)}" height="${subSize * 1.9}" rx="${subSize * 0.95}" fill="${pal.primary}"/>${txt(W * 0.07 + subSize * 0.8, H - W * 0.05 - subSize * 0.6, extras.join('  ·  '), { size: subSize, weight: mid, anchor: 'start', font })}` : ''}`;
    }

    if (layout === 'top') {
      // título no topo, alinhado à esquerda, com barra da marca; extras numa pílula embaixo
      const tf = E.fitText(head, { size: Math.round(W * 0.085), minSize: Math.round(W * 0.05), maxWidth: W * 0.82, maxLines: 3, weight: heavy });
      const h = tf.lines.length * tf.size * 1.12 + W * 0.12;
      return `<defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.45" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient></defs>
        <rect x="0" y="0" width="${W}" height="${h * 1.4}" fill="url(#g)"/>
        <rect x="${W * 0.06}" y="${W * 0.06}" width="${W * 0.012}" height="${tf.lines.length * tf.size * 1.12}" fill="${pal.primary}"/>
        ${tf.lines.map((l, i) => txt(W * 0.095, W * 0.06 + tf.size * (0.88 + i * 1.12), l, { size: tf.size, weight: heavy, anchor: 'start', font })).join('')}
        ${sub ? `<rect x="${(W - Math.min(W * 0.9, E.textWidth(sub, subSize, 700) + subSize * 2)) / 2}" y="${H - W * 0.06 - subSize * 2}" width="${Math.min(W * 0.9, E.textWidth(sub, subSize, 700) + subSize * 2)}" height="${subSize * 2}" rx="${subSize}" fill="#000" opacity="0.72"/>${txt(W / 2, H - W * 0.06 - subSize * 0.62, sub, { size: subSize, weight: mid, font })}` : ''}`;
    }

    if (layout === 'panel') {
      // painel sólido na cor da marca, com o topo inclinado
      const tf = E.fitText(head, { size: Math.round(W * 0.08), minSize: Math.round(W * 0.048), maxWidth: W * 0.86, maxLines: 2, weight: heavy });
      const ph = tf.lines.length * tf.size * 1.12 + (sub ? subSize * 1.9 : 0) + W * 0.12;
      const y0 = H - ph;
      return `<polygon points="0,${y0 - W * 0.06} ${W},${y0 + W * 0.02} ${W},${H} 0,${H}" fill="${pal.dark}" opacity="0.94"/>
        <polygon points="0,${y0 - W * 0.06} ${W},${y0 + W * 0.02} ${W},${y0 + W * 0.035} 0,${y0 - W * 0.045}" fill="${pal.bright}"/>
        ${tf.lines.map((l, i) => txt(W * 0.07, y0 + W * 0.06 + tf.size * (0.85 + i * 1.1), l, { size: tf.size, weight: heavy, anchor: 'start', font })).join('')}
        ${sub ? txt(W * 0.07, H - W * 0.055, sub, { size: subSize, weight: mid, anchor: 'start', fill: pal.soft, font }) : ''}`;
    }

    if (layout === 'frame') {
      // elegante: moldura fina e título centralizado numa caixa translúcida
      const tf = E.fitText(head, { size: Math.round(W * 0.075), minSize: Math.round(W * 0.045), maxWidth: W * 0.72, maxLines: 2, weight: mid });
      const bh = tf.lines.length * tf.size * 1.15 + (sub ? subSize * 2 : 0) + W * 0.08;
      const by = H * 0.62 - bh / 2;
      const m = W * 0.035;
      return `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#fff" stroke-width="${Math.max(2, W * 0.003)}" opacity="0.85"/>
        <rect x="${W * 0.11}" y="${by}" width="${W * 0.78}" height="${bh}" fill="#000" opacity="0.66"/>
        <rect x="${W / 2 - W * 0.05}" y="${by + W * 0.03}" width="${W * 0.1}" height="${Math.max(2, W * 0.003)}" fill="${pal.soft}"/>
        ${tf.lines.map((l, i) => txt(W / 2, by + W * 0.045 + tf.size * (0.95 + i * 1.15), l, { size: tf.size, weight: mid, font })).join('')}
        ${sub ? txt(W / 2, by + bh - W * 0.035, sub, { size: Math.round(subSize * 0.9), weight: 500, font, spacing: 1 }) : ''}`;
    }

    // band (padrão): faixa escura embaixo, centralizada
    const fit = E.fitText(head, { size: Math.round(W * 0.085), minSize: Math.round(W * 0.047), maxWidth: W * 0.88, maxLines: 2, weight: heavy });
    const bandH = Math.round(fit.lines.length * fit.size * 1.15 + (sub ? subSize * 1.8 : 0) + W * 0.09);
    const y0 = H - bandH;
    const subY = y0 + W * 0.045 + fit.size * (0.95 + (fit.lines.length - 1) * 1.12) + subSize * 1.6;
    return `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.35" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient></defs>
      <rect x="0" y="${y0 - bandH * 0.4}" width="${W}" height="${bandH * 1.4}" fill="url(#g)"/>
      <rect x="${W / 2 - W * 0.08}" y="${y0 + W * 0.02}" width="${W * 0.16}" height="${Math.max(4, W * 0.008)}" rx="3" fill="${pal.primary}"/>
      ${fit.lines.map((l, i) => txt(W / 2, y0 + W * 0.045 + fit.size * (0.95 + i * 1.12), l, { size: fit.size, weight: heavy, font })).join('')}
      ${sub ? txt(W / 2, subY, sub, { size: subSize, weight: mid, font }) : ''}`;
  });
}

module.exports = { chooseLayout, layoutSvg, BY_LOOK };
