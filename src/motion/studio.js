// 🎬 ESTÚDIO — anúncio animado montado SOB MEDIDA para cada pedido
//
// O modelo antigo ("Serviços") tinha sempre as mesmas 5 cenas. Aqui a IA trabalha
// como um diretor de criação:
//   1) ENTENDE o pedido (texto + o que está escrito nas imagens + marca) e escreve um
//      briefing: o que é, para quem, qual dor, o ângulo do anúncio e os riscos
//      (ex.: não reproduzir marca de terceiros);
//   2) MONTA O ROTEIRO escolhendo blocos de cena na ordem que conta melhor a história:
//        hook       → a dor/desejo do cliente final (ícone grande + frase forte)
//        product    → o produto em destaque (foto real recortada, logo ou ícone)
//        steps      → "como funciona" em 2 a 4 passos numerados
//        benefits   → 3 ou 4 benefícios em cartões
//        statement  → uma frase de impacto
//        cta        → logo/marca, oferta e WhatsApp
//   3) PRODUZ: uma fala por cena (a cena dura o que a fala dura) e renderiza em SVG →
//      sharp → ffmpeg, com texto sempre correto e a logo sempre fiel.

require('../fontSetup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { callLLM } = require('../llm');
const E = require('./engine');
const { icon, safeIcon, ICON_NAMES } = require('./icons');
const T = require('./templates/servicos');
const { prepareAssets, colorFromProject, colorFromLogo, mixVoices, toBuffer } = require('./motionAd');
const { mediaDuration } = require('../mediaDuration');

const W = 1080;
const H = 1920;
const CX = W / 2;
const XFADE = 0.35;
const TYPES = ['hook', 'product', 'steps', 'benefits', 'statement', 'cta'];

// ---------------------------------------------------------------------------
// 1+2) Diretor + roteirista (uma chamada)
// ---------------------------------------------------------------------------
function directorPrompt() {
  return [
    'Você é diretor de criação de anúncios em vídeo (Reels/Status, 9:16) para pequenos negócios no Brasil.',
    'Muitos clientes pedem pouco e de forma vaga. Use TUDO que foi dado (pedido, conversa, textos lidos nas imagens) para entender o produto/serviço, quem compra, a dor e o melhor ângulo — como um bom publicitário faria sem precisar perguntar.',
    'Depois monte o roteiro escolhendo BLOCOS de cena na ordem que conta a melhor história para ESTE caso.',
    'Responda SOMENTE um JSON válido:',
    '{"brief":{"what":"...","audience":"...","pain":"...","angle":"..."},"brand":"...","color":"#RRGGBB","style":"moderno|impacto|elegante|tecnologico","warnings":["..."],',
    ' "scenes":[',
    '  {"type":"hook","title":"...","subtitle":"...","icon":"...","mood":"quente|escuro|marca","voice":"..."},',
    '  {"type":"product","title":"...","subtitle":"...","icon":"...","voice":"..."},',
    '  {"type":"steps","title":"Como funciona","items":[{"icon":"...","title":"...","desc":"..."}],"voice":"..."},',
    '  {"type":"benefits","title":"...","items":[{"icon":"...","title":"..."}],"voice":"..."},',
    '  {"type":"statement","title":"...","subtitle":"...","icon":"...","voice":"..."},',
    '  {"type":"cta","slogan1":"...","slogan2":"...","phone":"...","label":"...","footer":"...","voice":"..."}',
    ' ]}',
    'Regras do roteiro:',
    '- 4 a 6 cenas. Comece com hook e termine com cta. Use cada tipo no máximo uma vez. O vídeo é para Reels/Status: RÁPIDO, 20 a 30 segundos no total.',
    '- product quando houver um produto/serviço para mostrar (se o cliente mandou foto de produto, SEMPRE inclua).',
    '- steps quando o cliente pedir para explicar como funciona, ou quando o produto precisa ser explicado (2 a 4 passos, na ordem real de uso).',
    '- benefits para vantagens concretas (3 ou 4 itens, title até 4 palavras).',
    '- statement para uma virada forte, específica deste negócio (nunca frases genéricas copiadas).',
    '- Textos na tela curtos: title até 7 palavras; subtitle até 12; desc até 9; slogans até 5.',
    '- voice: fala em português do Brasil, natural e animada, 6 a 16 palavras por cena (steps e benefits até 20). SOMA de todas as falas: no máximo 75 palavras. O nome da marca deve ser FALADO pelo menos uma vez e na cta.',
    '- Telefone e preço na voice: escreva com DÍGITOS, exatamente como o cliente escreveu (ex.: "(91) 98888-7777", "R$ 80,00"); o sistema converte para a fala. Nunca escreva números por extenso.',
    '- Fale SOMENTE do negócio deste pedido. Não misture produtos, imagens ou assuntos de outros pedidos da conversa.',
    '- style: o visual que combina com o negócio e o tom do pedido — impacto (varejo, promoção, comida rápida), elegante (beleza, moda, saúde, serviços finos), tecnologico (tecnologia, engenharia, indústria, serviços técnicos), moderno (o resto).',
    '- hook.mood: use "marca" (cores da marca), a não ser que o cliente peça outra coisa.',
    '- cta.footer: só endereço, cidade, site ou @ que o cliente informou; senão deixe vazio. Nada de "oferta por tempo limitado" ou promessas que o cliente não fez.',
    `- icon: SOMENTE destes nomes: ${ICON_NAMES.join(', ')}.`,
    '- brand: nome da empresa (do pedido, da conversa ou lido na logo). color: cor da marca (se o cliente disse ou se aparece na logo), senão uma que combine com o ramo.',
    '- NUNCA invente preço, telefone, endereço, prêmio ou estatística que não foram informados, nem detalhes específicos do produto (ex.: "forno a lenha", "peças importadas", "suporte 24h", "garantia de 1 ano"), nem ofertas ou promessas que o cliente não fez (ex.: "avaliação gratuita", "orçamento grátis", "frete grátis", "economia na conta de luz"). Sem a informação, use benefícios gerais e verdadeiros para qualquer negócio do ramo.',
    '- NUNCA escreva marcadores de modelo como [Nome da empresa], [Chame a atenção] ou (XX) XXXX-XXXX: o texto vai direto para a tela e para a voz. Se não souber o nome ou o contato, escreva a frase sem eles.',
    '- Imagem de MASCOTE/personagem com o nome da empresa é o mascote DA EMPRESA (ele apresenta a marca), não um brinquedo à venda. Nunca transforme o mascote em produto infantil.',
    '- Marcas de TERCEIROS (Google, Instagram, iFood...) podem ser citadas no texto, mas nunca como logo ou como se o anúncio fosse delas.',
    '- warnings: 0 a 2 avisos curtos, SÓ sobre informação que faltou e que o comprador vai perguntar (ex.: preço, horário, bairros atendidos, o que o preço inclui). Nada sobre direitos de imagem, logos, link do WhatsApp, DDD ou o que o cliente deveria ter feito. Lista vazia se nada importante faltou.'
  ].join('\n');
}

const str = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function fallbackStoryboard(request, project, hasProduct) {
  const brand = (project && project.brand) || '';
  const scenes = [
    { type: 'hook', title: 'Procurando quem faz direito?', subtitle: 'Qualidade e atendimento que você merece.', icon: 'sparkles', mood: 'marca', voice: 'Procurando quem faz direito, com qualidade e atendimento de verdade?' },
    { type: 'product', title: brand || 'Feito para você', subtitle: 'Cuidado do início ao fim.', icon: 'star', voice: brand ? `Conheça a ${brand}. Cuidado do início ao fim.` : 'Cuidado do início ao fim, do jeito que você procura.' },
    { type: 'benefits', title: 'Por que escolher', items: [{ icon: 'clock', title: 'Atendimento rápido' }, { icon: 'star', title: 'Qualidade de verdade' }, { icon: 'shield', title: 'Garantia' }], voice: 'Atendimento rápido, qualidade de verdade e a tranquilidade que você procura.' },
    { type: 'cta', slogan1: 'Fale com a gente', slogan2: 'Atendimento de verdade', phone: '', label: 'Atendimento via WhatsApp', footer: 'Chame agora!', voice: brand ? `Chame a ${brand} agora no WhatsApp!` : 'Chame agora no WhatsApp!' }
  ];
  if (!hasProduct && !brand) scenes.splice(1, 1);
  return { brief: {}, brand, color: null, warnings: [], scenes };
}

function sanitizeStoryboard(raw, project, hasProduct) {
  const r = require('../placeholders').cleanPlan(raw || {}, (project && project.brand) || (raw && raw.brand) || '');
  const seen = new Set();
  let scenes = (Array.isArray(r.scenes) ? r.scenes : []).filter((s) => s && TYPES.includes(s.type) && !seen.has(s.type) && seen.add(s.type));
  scenes = scenes.map((s) => {
    const base = { type: s.type, voice: str(s.voice, 420) };
    if (s.type === 'hook') return { ...base, title: str(s.title, 80), subtitle: str(s.subtitle, 140), icon: safeIcon(s.icon, 'sparkles'), mood: s.mood === 'escuro' ? 'escuro' : 'marca' };
    if (s.type === 'product' || s.type === 'statement') return { ...base, title: str(s.title, 80), subtitle: str(s.subtitle, 140), icon: safeIcon(s.icon, 'star') };
    if (s.type === 'steps') return { ...base, title: str(s.title || 'Como funciona', 30), items: (s.items || []).slice(0, 4).map((it) => ({ icon: safeIcon(it.icon, 'check'), title: str(it.title, 40), desc: str(it.desc, 90) })).filter((it) => it.title) };
    if (s.type === 'benefits') return { ...base, title: str(s.title || 'Vantagens', 40), items: (s.items || []).slice(0, 4).map((it) => ({ icon: safeIcon(it.icon, 'check'), title: str(it.title, 40) })).filter((it) => it.title) };
    // telefone na tela: só dígitos (a IA às vezes escreve por extenso, que é para a VOZ)
    const phone = /\d{4}/.test(String(s.phone || '')) ? str(s.phone, 24) : '';
    // "Visite nosso site" sem site nenhum é promessa vazia
    const f0 = String(s.footer || '');
    const footer = (/\b(site|instagram|@|endere[çc]o)\b/i.test(f0) && !/[\w-]+\.[a-z]{2,}|@\w+|\d/i.test(f0)) ||
      /(tempo limitado|[úu]ltimas unidades|s[óo] hoje|imperd[íi]vel|vagas limitadas|aproveite j[áa])/i.test(f0) ? '' : str(f0, 90);
    return { ...base, slogan1: str(s.slogan1, 50), slogan2: str(s.slogan2, 50), phone, label: str(s.label, 40), footer };
  }).filter((s) => {
    if (s.type === 'steps') return s.items.length >= 2;
    if (s.type === 'benefits') return s.items.length >= 3;
    if (s.type === 'cta') return true;
    return !!s.title;
  });
  const fb = fallbackStoryboard('', project, hasProduct);
  if (!scenes.length || scenes[0].type !== 'hook') {
    const hook = scenes.find((s) => s.type === 'hook') || fb.scenes[0];
    scenes = [hook, ...scenes.filter((s) => s !== hook)];
  }
  if (scenes[scenes.length - 1].type !== 'cta') {
    const cta = scenes.find((s) => s.type === 'cta') || fb.scenes[fb.scenes.length - 1];
    scenes = [...scenes.filter((s) => s !== cta), cta];
  }
  if (hasProduct && !scenes.some((s) => s.type === 'product')) scenes.splice(1, 0, fb.scenes[1]);
  if (scenes.length < 3) scenes.splice(scenes.length - 1, 0, fb.scenes[2]);
  for (const s of scenes) if (!s.voice) s.voice = (fb.scenes.find((f) => f.type === s.type) || {}).voice || '';
  return {
    brief: r.brief || {},
    brand: str(r.brand || (project && project.brand), 50),
    color: /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : null,
    style: str(r.style, 20),
    warnings: (r.warnings || []).map((w) => str(w, 160)).filter(Boolean).slice(0, 3),
    scenes: scenes.slice(0, 7)
  };
}

// a marca tem que ser dita (em alguma cena do meio/começo e na chamada)
function ensureBrand(sb, brand) {
  if (!brand) return sb;
  const { mentions } = require('../brandInfo');
  const sc = sb.scenes;
  const cta = sc[sc.length - 1];
  if (!sc.slice(0, -1).some((s) => mentions(s.voice, brand))) {
    const target = sc.find((s) => s.type === 'product') || sc[Math.min(1, sc.length - 2)];
    target.voice = `Conheça a ${brand}! ${target.voice}`;
  }
  if (!mentions(cta.voice, brand)) cta.voice = `${cta.voice} É com a ${brand}!`;
  return sb;
}

// "(91) 99987-9932" / "91 999879932" → "(91) 99987-9932"
function phoneFrom(text) {
  // aceita "91 99987-9932", "(91) 9 9987-9932", "91999879932" e o hífen especial que a IA usa
  const t = require('../placeholders').normalize(text);
  const m = t.match(/\(?\b(\d{2})\)?[\s-]*(9?\s?\d{4})[-\s.]?(\d{4})\b/);
  return m ? `(${m[1]}) ${m[2].replace(/\s/g, '')}-${m[3]}` : '';
}

async function planStudio(request, project, refCaptions, hasProduct) {
  const p = project || {};
  const facts = (p.facts || []).map((f) => `${f.key}: ${f.value}`).join('; ');
  const user = [
    `Pedido do cliente: ${request}`,
    p.brand ? `Marca: ${p.brand}` : '',
    p.colors && p.colors.length ? `Cores da marca: ${p.colors.join(', ')}` : '',
    facts ? `Fatos confirmados: ${facts}` : '',
    hasProduct ? 'O cliente enviou FOTO DO PRODUTO (ela aparece na cena product).' : '',
    refCaptions && refCaptions.length ? `O que está nas imagens enviadas (textos exatos): ${refCaptions.join(' | ')}` : ''
  ].filter(Boolean).join('\n');
  let sb;
  const errors = [];
  // 2 tentativas: o roteiro padrão é genérico demais para ser a primeira saída
  for (let attempt = 1; attempt <= 2 && !sb; attempt++) {
    try {
      const text = await callLLM(directorPrompt(), user, { temperature: attempt === 1 ? 0.6 : 0.4, maxTokens: 2200, json: true, timeout: 60000, errors });
      const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
      const s = cleaned.indexOf('{');
      const e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) sb = sanitizeStoryboard(JSON.parse(cleaned.slice(s, e + 1)), p, hasProduct);
      else { errors.push(`sem JSON: ${String(text || '(vazio)').slice(0, 80)}`); console.error(`studio: roteiro sem JSON (tentativa ${attempt}):`, String(text || '').slice(0, 120)); }
    } catch (err) {
      errors.push(`erro: ${err.message}`);
      console.error(`studio: roteiro via LLM falhou (tentativa ${attempt}):`, err.message);
    }
  }
  const source = sb ? 'ia' : 'padrão';
  if (!sb) sb = sanitizeStoryboard(fallbackStoryboard(request, p, hasProduct), p, hasProduct);
  sb.debug = { source, errors: errors.slice(0, 4) };
  // o telefone da tela final vem do que o CLIENTE escreveu (nunca inventado pela IA)
  const phoneTyped = phoneFrom(`${request} ${(p.facts || []).map((f) => f.value).join(' ')}`);
  const cta = sb.scenes[sb.scenes.length - 1];
  if (phoneTyped) cta.phone = phoneTyped;
  else if (cta.phone && !phoneFrom(cta.phone)) cta.phone = '';
  // promessas que o cliente não fez saem (garantia, 24h, grátis, tempo limitado...)
  const C = require('../claims');
  const src = C.sourceOf({ request, project: p, refCaptions });
  sb.scenes = C.cleanPlan(sb.scenes, src);
  for (const s of sb.scenes) {
    // fala removida por promessa → a cena fica só com a imagem (falar o título soava robótico)
    if (s.voice && !/[.!?]$/.test(s.voice.trim())) s.voice = `${s.voice.trim()}.`;
  }
  ensureFacts(sb, `${request} ${(p.facts || []).map((f) => f.value).join(' ')}`, phoneTyped);
  return ensureBrand(sb, p.brand || sb.brand);
}

// Preço e telefone que o CLIENTE deu têm que ser falados (o modelo reserva às vezes esquece)
function ensureFacts(sb, text, phone) {
  const digits = (x) => String(x || '').replace(/\D/g, '');
  const sc = sb.scenes;
  const allVoice = () => sc.map((s) => s.voice || '').join(' ');
  for (const m of String(text).match(/R\$\s*\d[\d.]*(?:,\d{2})?/gi) || []) {
    if (digits(allVoice()).includes(digits(m))) continue;
    const target = sc.find((s) => s.type === 'product') || sc.find((s) => s.type === 'hook') || sc[0];
    target.voice = `${String(target.voice || '').trim()} Por ${m.replace(/R\$\s*/i, 'R$ ')}.`.trim();
  }
  if (phone && !digits(allVoice()).includes(digits(phone).slice(-8))) {
    const cta = sc[sc.length - 1];
    cta.voice = `${String(cta.voice || '').trim()} WhatsApp ${phone}.`.trim();
  }
  return sb;
}

// ---------------------------------------------------------------------------
// Blocos novos
// ---------------------------------------------------------------------------
const scaleAround = T.scaleAround;

function header(t, text, pal, y = 300) {
  const hp = E.prog(t, 0, 0.5);
  const barW = 170 * E.prog(t, 0.2, 0.6);
  const f = E.fitText(String(text || '').toUpperCase(), { size: 60, minSize: 42, maxWidth: 900, maxLines: 1, weight: 800 });
  return `<text x="${CX}" y="${y + (1 - hp) * 30}" font-family="${E.FONT}" font-weight="800" font-size="${f.size}" fill="${pal.ink}" text-anchor="middle" opacity="${hp}" letter-spacing="2">${E.esc(f.lines[0] || '')}</text>
    <rect x="${CX - barW / 2}" y="${y + 40}" width="${barW}" height="10" rx="5" fill="${pal.primary}"/>`;
}

// Produto em destaque: foto recortada flutuando (ou em cartão), título e subtítulo
function sceneProduct(t, d, S, sc) {
  const pal = S.pal;
  const s = E.prog(t, 0.05, 0.8, E.ease.outBack);
  const zoom = 1 + 0.035 * E.clamp(t / Math.max(d, 1));
  const float = Math.sin(t * 1.6) * 10;
  let visual;
  const cy = 720;
  if (S.assets.productCut) {
    const size = 860;
    visual = `<g transform="translate(0 ${float.toFixed(1)}) ${scaleAround(CX, cy, Math.max(0.001, s * zoom))}">
      <ellipse cx="${CX}" cy="${cy + size / 2 - 20}" rx="${size * 0.36}" ry="34" fill="${pal.ink}" opacity="0.16"/>
      <image x="${CX - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" xlink:href="${S.assets.productCut}"/>
    </g>`;
  } else if (S.assets.product) {
    const size = 820;
    const x = CX - size / 2;
    const y = cy - size / 2;
    visual = `<g transform="${scaleAround(CX, cy, Math.max(0.001, s))}">
      <defs><clipPath id="spc"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="60"/></clipPath></defs>
      <rect x="${x + 12}" y="${y + 26}" width="${size}" height="${size}" rx="60" fill="${pal.ink}" opacity="0.16"/>
      <g clip-path="url(#spc)"><image x="${x - (zoom - 1) * size / 2}" y="${y - (zoom - 1) * size / 2}" width="${size * zoom}" height="${size * zoom}" preserveAspectRatio="xMidYMid slice" xlink:href="${S.assets.product}"/></g>
    </g>`;
  } else if (S.assets.logo) {
    visual = `<g transform="${scaleAround(CX, cy, Math.max(0.001, s))}"><image x="${CX - 360}" y="${cy - 260}" width="720" height="520" preserveAspectRatio="xMidYMid meet" xlink:href="${S.assets.logo}"/></g>`;
  } else {
    visual = T.heroIcon(sc.icon, t, cy, pal, { ringFill: pal.primary, ringOpacity: 0.12, color: pal.primary });
  }
  const glow = `<defs><radialGradient id="pglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${pal.soft}" stop-opacity="0.9"/><stop offset="1" stop-color="${pal.light}" stop-opacity="0"/></radialGradient></defs><circle cx="${CX}" cy="${cy}" r="${(520 + Math.sin(t * 1.2) * 12).toFixed(1)}" fill="url(#pglow)"/>`;
  const title = E.fitText(String(sc.title || '').toUpperCase(), { size: 88, minSize: 54, maxWidth: 940, maxLines: 2, weight: 800 });
  const tY = 1300;
  const sY = tY + title.lines.length * title.size * 1.12 + 26;
  const sub = E.fitText(sc.subtitle || '', { size: 46, minSize: 34, maxWidth: 880, maxLines: 3, weight: 500 });
  return `<rect width="${W}" height="${H}" fill="${pal.light}"/>${T.dotGrid(t, pal.primary)}${glow}
    ${visual}
    ${E.textBlock({ lines: title.lines, x: CX, y: tY, size: title.size, weight: 800, fill: pal.primary, t, start: 0.45 })}
    ${E.textBlock({ lines: sub.lines, x: CX, y: sY, size: sub.size, weight: 500, fill: pal.ink, t, start: 0.9, opacity: 0.85, rise: 20 })}`;
}

// Como funciona: passos numerados que entram um a um, ligados por uma linha
function sceneSteps(t, d, S, sc) {
  const pal = S.pal;
  const items = sc.items;
  const n = items.length;
  const rowH = n <= 2 ? 460 : n === 3 ? 400 : 330;
  // bloco centralizado entre o título (≈400) e o rodapé (≈1800)
  const top = Math.round((430 + 1780 - (n - 1) * rowH) / 2);
  const slot = Math.max(0.9, (d - 0.9) / n);
  const numX = 170;
  let rows = '';
  let line = '';
  items.forEach((it, i) => {
    const y = top + i * rowH;
    const p = E.prog(t, 0.5 + i * slot, 0.55, E.ease.outBack);
    const active = t >= 0.5 + i * slot && (i === n - 1 || t < 0.5 + (i + 1) * slot);
    if (i < n - 1) {
      const lp = E.prog(t, 0.5 + i * slot + 0.3, slot * 0.8);
      line += `<rect x="${numX - 4}" y="${y + 70}" width="8" height="${((rowH - 140) * lp).toFixed(1)}" rx="4" fill="${pal.soft}"/>`;
    }
    if (p <= 0) return;
    const title = E.fitText(it.title, { size: 60, minSize: 40, maxWidth: 560, maxLines: 2, weight: 800 });
    const desc = E.fitText(it.desc || '', { size: 40, minSize: 30, maxWidth: 560, maxLines: 3, weight: 500 });
    const tx = 290;
    const cardH = rowH - 40;
    const glow = active ? `<rect x="250" y="${y - cardH / 2}" width="770" height="${cardH}" rx="40" fill="#FFFFFF"/><rect x="250" y="${y - cardH / 2}" width="770" height="${cardH}" rx="40" fill="none" stroke="${pal.primary}" stroke-width="4" opacity="0.35"/>` : `<rect x="250" y="${y - cardH / 2}" width="770" height="${cardH}" rx="40" fill="#FFFFFF" opacity="0.6"/>`;
    const tY = y - ((title.lines.length - 1) * title.size * 1.05 + (desc.lines.length ? desc.lines.length * desc.size * 1.2 + 16 : 0)) / 2 + title.size * 0.35;
    const dY = tY + (title.lines.length - 1) * title.size * 1.05 + desc.size * 1.25 + 8;
    rows += `<g opacity="${Math.min(1, p).toFixed(3)}">
      ${glow}
      <g transform="${scaleAround(numX, y, Math.max(0.001, p))}">
        <circle cx="${numX}" cy="${y}" r="70" fill="${active ? pal.primary : pal.dark}"/>
        <text x="${numX}" y="${y + 24}" font-family="${E.FONT}" font-weight="800" font-size="68" fill="#FFFFFF" text-anchor="middle">${i + 1}</text>
      </g>
      <circle cx="935" cy="${y}" r="58" fill="${pal.light}"/>
      ${icon(it.icon, 935, y, 70, pal.primary, { strokeWidth: 7, opacity: 0.95 })}
      ${title.lines.map((l, k) => `<text x="${tx}" y="${(tY + k * title.size * 1.05).toFixed(1)}" font-family="${E.FONT}" font-weight="800" font-size="${title.size}" fill="${pal.ink}">${E.esc(l)}</text>`).join('')}
      ${desc.lines.map((l, k) => `<text x="${tx}" y="${(dY + k * desc.size * 1.2).toFixed(1)}" font-family="${E.FONT}" font-weight="500" font-size="${desc.size}" fill="${pal.ink}" opacity="0.75">${E.esc(l)}</text>`).join('')}
    </g>`;
  });
  return `${T.gradientBg('st', pal.light, '#FFFFFF')}${T.dotGrid(t * 0.6, pal.primary)}
    ${header(t, sc.title || 'Como funciona', pal)}
    ${line}${rows}`;
}

// Benefícios: cartões escuros que entram em sequência (2×2 ou 3 empilhados)
function sceneBenefits(t, d, S, sc) {
  const pal = S.pal;
  const items = sc.items;
  const n = items.length;
  const grid = n === 4;
  const cardW = grid ? 440 : 880;
  const cardH = grid ? 480 : 300;
  const gap = 40;
  const x0 = (W - (grid ? cardW * 2 + gap : cardW)) / 2;
  const rows = grid ? 2 : n;
  const y0 = Math.round((430 + 1780 - (rows * cardH + (rows - 1) * gap)) / 2);
  const stagger = Math.min(0.6, Math.max(0.3, (d - 1.2) / n));
  const cards = items.map((it, i) => {
    const col = grid ? i % 2 : 0;
    const row = grid ? Math.floor(i / 2) : i;
    const x = x0 + col * (cardW + gap);
    const y = y0 + row * (cardH + gap);
    const p = E.prog(t, 0.45 + i * stagger, 0.6, E.ease.outBack);
    if (p <= 0) return '';
    const cxC = x + cardW / 2;
    const cyC = y + cardH / 2;
    const title = E.fitText(it.title.toUpperCase(), { size: grid ? 50 : 56, minSize: 34, maxWidth: grid ? cardW - 70 : cardW - 330, maxLines: grid ? 3 : 2, weight: 800 });
    const iconCy = grid ? y + 150 : cyC;
    const iconCx = grid ? cxC : x + 150;
    const tx = grid ? cxC : x + 290;
    const anchor = grid ? 'middle' : 'start';
    const tY0 = grid ? y + 300 : cyC - ((title.lines.length - 1) * title.size * 1.05) / 2 + title.size * 0.35;
    return `<g transform="${scaleAround(cxC, cyC, Math.max(0.001, p))}">
      <rect x="${x + 10}" y="${y + 22}" width="${cardW}" height="${cardH}" rx="46" fill="${pal.ink}" opacity="0.18"/>
      <defs><linearGradient id="bg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.dark}"/><stop offset="1" stop-color="${pal.deep}"/></linearGradient>
      <radialGradient id="bi${i}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${pal.bright}"/><stop offset="1" stop-color="${pal.primary}"/></radialGradient></defs>
      <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="46" fill="url(#bg${i})"/>
      <circle cx="${iconCx}" cy="${iconCy}" r="${grid ? 100 : 95}" fill="url(#bi${i})"/>
      ${icon(it.icon, iconCx, iconCy, grid ? 110 : 105, '#FFFFFF', { strokeWidth: 7 })}
      ${title.lines.map((l, k) => `<text x="${tx}" y="${(tY0 + k * title.size * 1.05).toFixed(1)}" font-family="${E.FONT}" font-weight="800" font-size="${title.size}" fill="#FFFFFF" text-anchor="${anchor}">${E.esc(l)}</text>`).join('')}
    </g>`;
  }).join('');
  return `${T.gradientBg('bf', pal.light, '#FFFFFF')}${T.dotGrid(t * 0.6, pal.primary)}
    ${header(t, sc.title || 'Vantagens', pal)}
    ${cards}`;
}

// Blocos que reaproveitam as cenas do modelo "Serviços"
function sceneHookBlock(t, d, S, sc) {
  return T.sceneHook(t, d, { ...S, hook: { title: sc.title, subtitle: sc.subtitle, icon: sc.icon, mood: sc.mood } });
}
function sceneStatementBlock(t, d, S, sc) {
  return T.sceneBenefit(t, d, { ...S, benefit: { title: sc.title, subtitle: sc.subtitle, icon: sc.icon } });
}
function sceneCtaBlock(t, d, S, sc) {
  const brand = S.brandName || '';
  return T.sceneCta(t, d, {
    ...S,
    brand: { name: brand },
    benefit: { icon: 'star' },
    cta: {
      slogan1: brand && sc.slogan1 === brand ? '' : sc.slogan1,
      slogan2: sc.slogan2,
      phone: sc.phone,
      contact: sc.phone ? null : (sc.label || 'Fale com a gente'),
      label: sc.label || 'Atendimento via WhatsApp',
      footer: sc.footer || ''
    }
  });
}

const RENDER = { hook: sceneHookBlock, product: sceneProduct, steps: sceneSteps, benefits: sceneBenefits, statement: sceneStatementBlock, cta: sceneCtaBlock };
const MIN = { hook: 2.6, product: 3, statement: 2.6, cta: 4 }; // mínimos curtos: quem manda é a fala

function build(sb, S, durations) {
  const ST = require('./styles');
  const look = ST.get(S.look);
  const X = look.dur || XFADE;
  const timeline = [];
  let start = 0;
  sb.scenes.forEach((sc, i) => {
    let min = MIN[sc.type] || 3.5;
    if (sc.type === 'steps') min = 0.9 + sc.items.length * 1.4;
    if (sc.type === 'benefits') min = 1.0 + sc.items.length * 0.6;
    const dur = Math.max(min, Number(durations[i]) || 0);
    // transição de ENTRADA desta cena (a primeira não tem); varia ao longo do vídeo
    const kind = i === 0 ? null : look.transitions[(i - 1) % look.transitions.length];
    timeline.push({ sc, start, dur, kind });
    start += dur;
  });
  const duration = start + 0.3;
  function frameSvg(t) {
    return E.withWidth(look.widthK, () => {
      let body = '';
      for (let i = 0; i < timeline.length; i++) {
        const it = timeline[i];
        const lt = t - it.start;
        if (lt < 0) continue;
        if (i < timeline.length - 1 && lt > it.dur + X) continue;
        const scene = RENDER[it.sc.type](lt, it.dur, S, it.sc);
        const ctx = { Wd: W, Hd: H, id: `tr${i}`, pal: S.pal };
        // entrando
        const inT = i > 0 && lt < X ? ST.transition(it.kind, lt / X, ctx) : null;
        // saindo (a próxima cena está entrando)
        const next = timeline[i + 1];
        const outT = next && lt > it.dur ? ST.transition(next.kind, (lt - it.dur) / X, { ...ctx, id: `tr${i + 1}` }) : null;
        let g = scene;
        if (outT) g = `${outT.outOpen}${g}${outT.outClose}`;
        if (inT) g = `${inT.inOpen}${g}${inT.inClose}${inT.overlay}`;
        body += g;
      }
      return ST.applyFont(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`, look, E.FONT);
    });
  }
  return { duration, timeline, frameSvg, look };
}

// Corta o silêncio do começo e do fim da fala (a voz grátis deixa ~0,5–1 s no fim,
// o que fazia a cena ficar parada depois que a voz acabava).
async function trimSilence(file) {
  const { execFile } = require('child_process');
  const FF = process.env.FFMPEG_BIN || 'ffmpeg';
  const out = file.replace(/\.mp3$/, '-t.mp3');
  const filter = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse';
  await new Promise((resolve) => execFile(FF, ['-y', '-v', 'error', '-i', file, '-af', filter, out], (err) => {
    try { if (!err && fs.statSync(out).size > 1000) fs.renameSync(out, file); } catch (e) {}
    resolve();
  }));
}

// Foto do produto recortada (fundo removido), se possível; senão, a foto em cartão
async function productCutout(product, deps) {
  if (!product || !deps.removeBackground) return null;
  try {
    const cut = await deps.removeBackground(product);
    if (!cut) return null;
    const buf = await toBuffer(cut);
    const png = await sharp(buf).trim({ threshold: 10 }).resize(900, 900, { fit: 'inside' }).png().toBuffer();
    // recorte que sobrou quase vazio = falhou (ex.: foto sem objeto claro)
    const { info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.width < 200 || info.height < 200) return null;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (e) {
    console.error('studio: recorte do produto falhou (usando a foto em cartão):', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
// deps: { tts(text, voice) → URL, upload(buffer, mime, name) → URL, removeBackground?(src) → URL }
async function buildStudioAd({ request, project, logo, product, refCaptions, voice, withVoice = true, deps, onStatus }) {
  const status = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    status('Entendendo o seu negócio e montando o roteiro…');
    const [sb, assets, productCut] = await Promise.all([
      planStudio(request, project, refCaptions, !!product),
      prepareAssets({ logo, product: null }).then(async (a) => {
        if (!product) return a;
        // foto em alta (a cena de produto mostra a foto grande)
        const jpg = await sharp(await toBuffer(product)).rotate().resize(1000, 1000, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
        return { ...a, product: `data:image/jpeg;base64,${jpg.toString('base64')}` };
      }),
      productCutout(product, deps)
    ]);
    const brandName = (project && project.brand) || sb.brand || '';
    const color = colorFromProject(project) || (assets.logoBuf && await colorFromLogo(assets.logoBuf)) || sb.color || '#1565D8';
    if (sb.warnings.length) console.log('studio: avisos do diretor:', sb.warnings.join(' | '));

    const durations = [];
    const voiceClips = [];
    let lastVoiceError = '';
    if (withVoice) {
      status('Gravando a narração…');
      const files = await Promise.all(sb.scenes.map(async (sc, i) => {
        if (!sc.voice) return null;
        try {
          const url = await deps.tts(sc.voice, voice);
          const f = path.join(tmp, `voz${i}.mp3`);
          fs.writeFileSync(f, await toBuffer(url));
          return f;
        } catch (e) {
          console.error(`studio: voz da cena ${i + 1} falhou:`, e.message);
          lastVoiceError = e.message;
          return null;
        }
      }));
      for (let i = 0; i < files.length; i++) {
        if (files[i]) {
          await trimSilence(files[i]);
          durations[i] = (await mediaDuration(files[i])) + 0.35; // fala + respiro curto
          voiceClips.push({ i, file: files[i] });
        }
      }
      if (!voiceClips.length) throw new Error(`nenhuma narração foi gerada (voz: ${lastVoiceError || 'sem detalhe'})`);
    }

    // estilo visual (fonte + transições) de acordo com o pedido
    const look = require('./styles').pickStyle(request, project, sb.style);
    const S = { pal: E.palette(color), assets: { ...assets, productCut }, brandName, look: look.key };
    const video = build(sb, S, durations);

    let audioPath = null;
    if (voiceClips.length) {
      audioPath = path.join(tmp, 'voz.mp3');
      await mixVoices(voiceClips.map((c) => ({ file: c.file, at: video.timeline[c.i].start + 0.15 })), audioPath);
    }

    status('Animando as cenas…');
    const out = path.join(tmp, 'anuncio.mp4');
    await E.renderVideo({ frameSvg: video.frameSvg, duration: video.duration, outPath: out, audioPath, W, H,
      onProgress: (p) => status(`Animando as cenas… ${Math.round(p * 100)}%`) });

    status('Finalizando…');
    const buf = fs.readFileSync(out);
    let videoUrl;
    try {
      videoUrl = await deps.upload(buf, 'video/mp4', `anuncio-${Date.now()}.mp4`);
    } catch (e) {
      console.error('studio: upload falhou, devolvendo dataURL:', e.message);
      videoUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }
    // avisos antes de publicar: os do diretor + checagens que não dependem da IA
    const notes = [...sb.warnings];
    const cta = sb.scenes[sb.scenes.length - 1];
    if (!cta.phone && !/[\w-]+\.(com|net|org|app|ai|br|io)\b|@\w+/i.test(`${request} ${cta.footer || ''}`)) {
      notes.unshift('O final ficou sem WhatsApp ou telefone. Anúncio sem contato perde quem se interessou: me mande o número que eu refaço o vídeo.');
    }
    return { videoUrl, storyboard: sb, color, look: look.key, duration: video.duration, notes: notes.slice(0, 4) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { buildStudioAd, planStudio, sanitizeStoryboard, _internals: { build, fallbackStoryboard, ensureBrand, ensureFacts, RENDER, phoneFrom } };
