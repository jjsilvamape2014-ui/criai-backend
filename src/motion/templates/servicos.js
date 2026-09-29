// Modelo "Serviços" (9:16) — estrutura de anúncio que vende para negócio local:
//   1. GANCHO    — a dor do cliente (ícone grande + frase forte)
//   2. MARCA     — quem resolve (nome, frase, 3 selos)
//   3. SERVIÇOS  — carrossel de cards (ícone, título, descrição)
//   4. BENEFÍCIO — a transformação (fundo da marca com partículas)
//   5. CHAMADA   — logo + slogan + WhatsApp
//
// Cada cena é uma função (t local em segundos, duração) → SVG. O tempo de cada
// cena vem da narração (a cena dura o que a voz leva para falar dela).

const E = require('../engine');
const { icon } = require('../icons');

const W = 1080;
const H = 1920;
const CX = W / 2;
const XFADE = 0.35;

function scaleAround(cx, cy, s) {
  return `translate(${cx} ${cy}) scale(${s.toFixed(4)}) translate(${-cx} ${-cy})`;
}

// ---------------------------------------------------------------------------
// Fundos
// ---------------------------------------------------------------------------
function gradientBg(id, top, bottom) {
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#${id})"/>`;
}

function waves(t, color, opacity) {
  let out = '';
  for (let i = 0; i < 7; i++) {
    const y0 = 220 + i * 250;
    let d = `M -20 ${y0}`;
    for (let x = 0; x <= W + 40; x += 40) {
      const y = y0 + Math.sin(x / 140 + t * 1.2 + i) * 14;
      d += ` L ${x} ${y.toFixed(1)}`;
    }
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" opacity="${opacity}"/>`;
  }
  return out;
}

function dotGrid(t, color) {
  // <pattern> = o librsvg desenha 1 pontinho e repete (≈10× mais rápido que 500 círculos)
  const off = Math.round((t * 18) % 64); // inteiro: deslocamento fracionado deixa o librsvg 10× mais lento
  return `<defs><pattern id="dots" width="64" height="64" patternUnits="userSpaceOnUse" patternTransform="translate(0 ${-off})"><circle cx="32" cy="32" r="3.2" fill="${color}" opacity="0.10"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#dots)"/>`;
}

function particles(t, seed, color) {
  const r = E.rng(seed);
  let out = '';
  for (let i = 0; i < 46; i++) {
    const x = r() * W;
    const y0 = r() * H;
    const sp = 20 + r() * 50;
    const size = 2 + r() * 6;
    const tw = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * (1 + r() * 2) + i));
    const y = ((y0 - t * sp) % H + H) % H;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(1)}" fill="${color}" opacity="${tw.toFixed(3)}"/>`;
  }
  return out;
}

// Ícone grande dentro de anel (entra com "pulo", depois flutua)
function heroIcon(name, t, cy, pal, { start = 0.1, ringFill = '#FFFFFF', ringOpacity = 0.14, color = '#FFFFFF' } = {}) {
  const s = E.prog(t, start, 0.7, E.ease.outBack);
  if (s <= 0) return '';
  const fy = Math.sin(t * 2.2) * 10;
  const pulse = 1 + 0.06 * Math.max(0, Math.sin(t * 3));
  return `<g transform="translate(0 ${fy.toFixed(1)}) ${scaleAround(CX, cy, s)}">
    <circle cx="${CX}" cy="${cy}" r="${(270 * pulse).toFixed(1)}" fill="${ringFill}" opacity="${(ringOpacity * 0.6).toFixed(3)}"/>
    <circle cx="${CX}" cy="${cy}" r="225" fill="${ringFill}" opacity="${ringOpacity}"/>
    ${icon(name, CX, cy, 300, color, { strokeWidth: 6 })}
  </g>`;
}

// ---------------------------------------------------------------------------
// Cenas
// ---------------------------------------------------------------------------
function sceneHook(t, d, S) {
  const pal = S.pal;
  const h = S.hook;
  const bg = h.mood === 'quente' ? gradientBg('hk', pal.warmA, pal.warmB)
    : h.mood === 'escuro' ? gradientBg('hk', pal.ink, pal.deep)
      : gradientBg('hk', pal.primary, pal.deep);
  const title = E.fitText(String(h.title || '').toUpperCase(), { size: 100, minSize: 60, maxWidth: 930, maxLines: 3, weight: 800 });
  const titleY = 1060;
  const subY = titleY + title.lines.length * title.size * 1.15 + 50;
  const sub = E.fitText(h.subtitle || '', { size: 46, minSize: 34, maxWidth: 880, maxLines: 3, weight: 500 });
  return `${bg}${waves(t, '#FFFFFF', 0.10)}
    ${heroIcon(h.icon, t, 620, pal)}
    ${E.textBlock({ lines: title.lines, x: CX, y: titleY, size: title.size, weight: 800, fill: '#FFFFFF', t, start: 0.45 })}
    ${E.textBlock({ lines: sub.lines, x: CX, y: subY, size: sub.size, weight: 500, fill: '#FFFFFF', t, start: 1.1, opacity: 0.92, rise: 24 })}`;
}

function sceneBrand(t, d, S) {
  const pal = S.pal;
  const b = S.brand;
  let top = '';
  const s = E.prog(t, 0.05, 0.7, E.ease.outBack);
  if (S.assets.product) {
    const size = 620;
    const x = CX - size / 2;
    const y = 250;
    top = `<g transform="${scaleAround(CX, y + size / 2, Math.max(0.001, s))}">
      <defs><clipPath id="pc"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="56"/></clipPath></defs>
      <rect x="${x + 10}" y="${y + 18}" width="${size}" height="${size}" rx="56" fill="${pal.ink}" opacity="0.12"/>
      <image x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pc)" xlink:href="${S.assets.product}"/>
    </g>`;
  } else if (S.assets.logo) {
    top = `<g transform="${scaleAround(CX, 560, Math.max(0.001, s))}"><image x="${CX - 300}" y="330" width="600" height="460" preserveAspectRatio="xMidYMid meet" xlink:href="${S.assets.logo}"/></g>`;
  } else {
    top = heroIcon(S.hook.brandIcon || S.services.items[0].icon, t, 560, pal, { ringFill: pal.primary, ringOpacity: 0.12, color: pal.primary });
  }
  const name = E.fitText(String(b.name || '').toUpperCase(), { size: 96, minSize: 56, maxWidth: 940, maxLines: 2, weight: 800 });
  const nameY = 1040;
  const tagY = nameY + name.lines.length * name.size * 1.12 + 20;
  const tag = E.fitText(b.tagline || '', { size: 44, minSize: 32, maxWidth: 880, maxLines: 2, weight: 500 });
  const badgeY0 = tagY + tag.lines.length * tag.size * 1.2 + 70;
  const badges = (b.badges || []).slice(0, 3).map((txt, i) => {
    const label = String(txt).toUpperCase();
    const fs = 34;
    const w = E.textWidth(label, fs, 700) + 90;
    const y = badgeY0 + i * 104;
    const p = E.prog(t, 1.3 + i * 0.25, 0.5, E.ease.outBack);
    if (p <= 0) return '';
    return `<g transform="${scaleAround(CX, y, p)}"><rect x="${CX - w / 2}" y="${y - 40}" width="${w}" height="80" rx="40" fill="${pal.primary}"/><text x="${CX}" y="${y + 12}" font-family="${E.FONT}" font-weight="700" font-size="${fs}" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">${E.esc(label)}</text></g>`;
  }).join('');
  return `<rect width="${W}" height="${H}" fill="${pal.light}"/>${dotGrid(t, pal.primary)}
    ${top}
    ${E.textBlock({ lines: name.lines, x: CX, y: nameY, size: name.size, weight: 800, fill: pal.primary, t, start: 0.35 })}
    ${E.textBlock({ lines: tag.lines, x: CX, y: tagY, size: tag.size, weight: 500, fill: pal.ink, t, start: 0.8, opacity: 0.8, rise: 20 })}
    ${badges}`;
}

function sceneServices(t, d, S) {
  const pal = S.pal;
  const items = S.services.items;
  const n = items.length;
  const head = String(S.services.title || 'NOSSOS SERVIÇOS').toUpperCase();
  const hp = E.prog(t, 0, 0.5);
  const barW = 170 * E.prog(t, 0.2, 0.6);
  const slot = (d - 0.5) / n;
  let cards = '';
  let active = 0;
  items.forEach((it, i) => {
    const lt = t - 0.5 - i * slot;
    if (lt < 0 || lt > slot + 0.45) return;
    if (lt >= 0) active = i;
    const enter = E.prog(lt, 0, 0.55);
    const exit = i < n - 1 ? E.prog(lt, slot - 0.1, 0.5, E.ease.inCubic) : 0;
    const x = W * (1 - enter) - W * exit;
    const cardW = 880;
    const title = E.fitText(String(it.title || '').toUpperCase(), { size: 68, minSize: 44, maxWidth: 780, maxLines: 2, weight: 800 });
    const desc = E.fitText(it.desc || '', { size: 46, minSize: 34, maxWidth: 760, maxLines: 4, weight: 500 });
    const cardH = 470 + title.lines.length * title.size * 1.1 + 40 + desc.lines.length * desc.size * 1.3 + 50;
    const cx0 = (W - cardW) / 2;
    const cy0 = 470 + (1000 - cardH) / 2;
    const tY = cy0 + 470;
    const dY = tY + title.lines.length * title.size * 1.1 + 40;
    const ip = E.prog(lt, 0.25, 0.6, E.ease.outBack);
    cards += `<g transform="translate(${x.toFixed(1)} 0)">
      <rect x="${cx0 + 12}" y="${cy0 + 24}" width="${cardW}" height="${cardH}" rx="52" fill="${pal.ink}" opacity="0.18"/>
      <defs><linearGradient id="cg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.dark}"/><stop offset="1" stop-color="${pal.deep}"/></linearGradient>
      <radialGradient id="ic${i}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${pal.bright}"/><stop offset="1" stop-color="${pal.primary}"/></radialGradient></defs>
      <rect x="${cx0}" y="${cy0}" width="${cardW}" height="${cardH}" rx="52" fill="url(#cg${i})"/>
      <g transform="${scaleAround(CX, cy0 + 230, Math.max(0.001, ip))}">
        <circle cx="${CX}" cy="${cy0 + 230}" r="140" fill="url(#ic${i})"/>
        ${icon(it.icon, CX, cy0 + 230, 150, '#FFFFFF', { strokeWidth: 7 })}
      </g>
      ${title.lines.map((l, k) => `<text x="${CX}" y="${tY + k * title.size * 1.1}" font-family="${E.FONT}" font-weight="800" font-size="${title.size}" fill="${pal.soft}" text-anchor="middle">${E.esc(l)}</text>`).join('')}
      ${desc.lines.map((l, k) => `<text x="${CX}" y="${dY + k * desc.size * 1.3}" font-family="${E.FONT}" font-weight="500" font-size="${desc.size}" fill="#FFFFFF" opacity="0.92" text-anchor="middle">${E.esc(l)}</text>`).join('')}
    </g>`;
  });
  const dots = items.map((_, i) => {
    const on = i === active;
    const w = on ? 56 : 18;
    const x = CX - ((n - 1) * 34 + 38) / 2 + i * 34 + (i > active ? 38 : 0);
    return `<rect x="${x.toFixed(1)}" y="1560" width="${w}" height="18" rx="9" fill="${on ? pal.primary : pal.soft}"/>`;
  }).join('');
  return `${gradientBg('sv', pal.light, '#FFFFFF')}${dotGrid(t * 0.6, pal.primary)}
    <text x="${CX}" y="${330 + (1 - hp) * 30}" font-family="${E.FONT}" font-weight="800" font-size="56" fill="${pal.ink}" text-anchor="middle" opacity="${hp}" letter-spacing="2">${E.esc(head)}</text>
    <rect x="${CX - barW / 2}" y="370" width="${barW}" height="10" rx="5" fill="${pal.primary}"/>
    ${cards}${dots}`;
}

function sceneBenefit(t, d, S) {
  const pal = S.pal;
  const b = S.benefit;
  const title = E.fitText(String(b.title || '').toUpperCase(), { size: 100, minSize: 60, maxWidth: 930, maxLines: 3, weight: 800 });
  const titleY = 1060;
  const subY = titleY + title.lines.length * title.size * 1.15 + 50;
  const sub = E.fitText(b.subtitle || '', { size: 46, minSize: 34, maxWidth: 860, maxLines: 3, weight: 500 });
  // última linha do título na cor clara da marca (destaque)
  const tl = title.lines.map((l, i) => E.textBlock({ lines: [l], x: CX, y: titleY + i * title.size * 1.15, size: title.size, weight: 800, fill: i === title.lines.length - 1 && title.lines.length > 1 ? pal.soft : '#FFFFFF', t, start: 0.45 + i * 0.12 })).join('');
  return `${gradientBg('bn', pal.primary, pal.deep)}${particles(t, 7, '#FFFFFF')}
    ${heroIcon(b.icon, t, 620, pal)}
    ${tl}
    ${E.textBlock({ lines: sub.lines, x: CX, y: subY, size: sub.size, weight: 500, fill: '#FFFFFF', t, start: 1.1, opacity: 0.9, rise: 24 })}`;
}

function sceneCta(t, d, S) {
  const pal = S.pal;
  const c = S.cta;
  const s = E.prog(t, 0.05, 0.75, E.ease.outBack);
  let top;
  if (S.assets.logo) {
    top = `<g transform="${scaleAround(CX, 520, Math.max(0.001, s))}"><image x="${CX - 360}" y="280" width="720" height="480" preserveAspectRatio="xMidYMid meet" xlink:href="${S.assets.logo}"/></g>`;
  } else {
    const nm = E.fitText(String(S.brand.name || '').toUpperCase(), { size: 110, minSize: 64, maxWidth: 940, maxLines: 2, weight: 800 });
    top = `<g transform="${scaleAround(CX, 560, Math.max(0.001, s))}">
      <circle cx="${CX}" cy="390" r="110" fill="${pal.primary}"/>${icon(S.benefit.icon || 'star', CX, 390, 130, '#FFFFFF')}
      ${nm.lines.map((l, i) => `<text x="${CX}" y="${640 + i * nm.size * 1.05}" font-family="${E.FONT}" font-weight="800" font-size="${nm.size}" fill="${pal.primary}" text-anchor="middle">${E.esc(l)}</text>`).join('')}
    </g>`;
  }
  const s1 = E.fitText(String(c.slogan1 || '').toUpperCase(), { size: 44, minSize: 32, maxWidth: 900, maxLines: 2, weight: 700 });
  const s2 = E.fitText(String(c.slogan2 || '').toUpperCase(), { size: 54, minSize: 36, maxWidth: 900, maxLines: 2, weight: 800 });
  const y1 = 900;
  const y2 = y1 + s1.lines.length * s1.size * 1.2 + 16;
  const pillY = Math.max(1130, y2 + s2.lines.length * s2.size * 1.15 + 60);
  const pp = E.prog(t, 1.1, 0.6, E.ease.outBack);
  const pulse = 1 + 0.025 * Math.max(0, Math.sin((t - 1.8) * 4));
  const hasPhone = !!(c.phone && String(c.phone).trim());
  const main = hasPhone ? c.phone : (c.contact || 'Fale com a gente');
  // sem telefone: sem ícone de WhatsApp (não prometer um canal que não existe) e sem repetir o texto
  const rawLabel = String(c.label || (hasPhone ? 'Atendimento via WhatsApp' : 'Acesse agora'));
  const pillLabel = !hasPhone && rawLabel.toLowerCase() === String(main).toLowerCase() ? 'Acesse agora' : rawLabel;
  const mainSize = E.fitText(main, { size: 66, minSize: 40, maxWidth: 560, maxLines: 1, weight: 800 }).size;
  const pill = pp <= 0 ? '' : `<g transform="${scaleAround(CX, pillY + 85, pp * pulse)}">
      <rect x="${CX - 440 + 8}" y="${pillY + 14}" width="880" height="170" rx="40" fill="${pal.ink}" opacity="0.18"/>
      <rect x="${CX - 440}" y="${pillY}" width="880" height="170" rx="40" fill="${pal.deep}"/>
      <circle cx="${CX - 440 + 105}" cy="${pillY + 85}" r="62" fill="${hasPhone ? pal.whatsapp : pal.primary}"/>
      ${hasPhone ? icon('whatsapp', CX - 440 + 105, pillY + 85, 84, '#FFFFFF', { strokeWidth: 7 }) : icon('hand', CX - 440 + 105, pillY + 85, 78, '#FFFFFF', { strokeWidth: 7 })}
      <text x="${CX - 440 + 200}" y="${pillY + 62}" font-family="${E.FONT}" font-weight="600" font-size="24" fill="#FFFFFF" opacity="0.75" letter-spacing="1.5">${E.esc(pillLabel.toUpperCase())}</text>
      <text x="${CX - 440 + 200}" y="${pillY + 130}" font-family="${E.FONT}" font-weight="800" font-size="${mainSize}" fill="#FFFFFF">${E.esc(main)}</text>
    </g>`;
  const foot = E.fitText(c.footer || '', { size: 38, minSize: 30, maxWidth: 860, maxLines: 2, weight: 600 });
  return `<rect width="${W}" height="${H}" fill="${pal.light}"/>
    <circle cx="${CX}" cy="540" r="${(420 + Math.sin(t) * 10).toFixed(1)}" fill="#FFFFFF" opacity="0.8"/>
    ${top}
    ${E.textBlock({ lines: s1.lines, x: CX, y: y1, size: s1.size, weight: 700, fill: pal.ink, t, start: 0.5 })}
    ${E.textBlock({ lines: s2.lines, x: CX, y: y2, size: s2.size, weight: 800, fill: pal.primary, t, start: 0.75 })}
    ${pill}
    ${E.textBlock({ lines: foot.lines, x: CX, y: pillY + 290, size: foot.size, weight: 600, fill: pal.ink, t, start: 1.8, opacity: 0.8, rise: 16 })}`;
}

const SCENES = [
  { key: 'hook', fn: sceneHook, min: 3.5 },
  { key: 'brand', fn: sceneBrand, min: 4 },
  { key: 'services', fn: sceneServices, min: 0 }, // mínimo depende do nº de cards
  { key: 'benefit', fn: sceneBenefit, min: 3.5 },
  { key: 'cta', fn: sceneCta, min: 5 }
];

// spec.durations: { hook, brand, services, benefit, cta } em segundos (vêm da narração)
function build(spec) {
  const n = spec.services.items.length;
  const timeline = [];
  let start = 0;
  for (const sc of SCENES) {
    const min = sc.key === 'services' ? 0.5 + n * 2.6 : sc.min;
    const dur = Math.max(min, Number(spec.durations && spec.durations[sc.key]) || 0);
    timeline.push({ ...sc, start, dur });
    start += dur;
  }
  const duration = start + 0.3;

  function frameSvg(t) {
    let body = '';
    for (let i = 0; i < timeline.length; i++) {
      const sc = timeline[i];
      const next = timeline[i + 1];
      const lt = t - sc.start;
      if (lt < 0) continue;
      const visibleUntil = next ? sc.dur + XFADE : Infinity;
      if (lt > visibleUntil) continue;
      // cena seguinte entra por cima com fade (cruzamento suave)
      const op = i === 0 ? 1 : E.clamp(lt / XFADE);
      body += `<g opacity="${op.toFixed(3)}">${sc.fn(lt, sc.dur, spec)}</g>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  }

  return { W, H, duration, timeline, frameSvg };
}

module.exports = { build, sceneCta, sceneHook, sceneBenefit, gradientBg, waves, dotGrid, particles, heroIcon, scaleAround, W, H };
