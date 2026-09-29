// 🎞️ Anúncio em MOTION GRAPHICS (estilo "JN Refrigeração")
//
//   roteiro (LLM, JSON por cena) → narração POR CENA (fal Kokoro PT-BR, em paralelo)
//   → cada cena dura o tempo da sua fala → quadros SVG → MP4 → upload
//
// A voz fica sincronizada com a tela porque cada cena tem a própria fala.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');

const E = require('./engine');
const { ICON_NAMES, safeIcon } = require('./icons');
const servicos = require('./templates/servicos');
const { callLLM } = require('../llm');

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

// ---------------------------------------------------------------------------
// Roteiro
// ---------------------------------------------------------------------------
function planPrompt() {
  return [
    'Você é diretor de criação de anúncios em vídeo (Reels/Status) para negócios locais no Brasil.',
    'Monte um anúncio em 5 cenas. Responda SOMENTE um JSON válido, exatamente neste formato:',
    '{"primaryColor":"#RRGGBB",',
    ' "hook":{"title":"...","subtitle":"...","icon":"...","mood":"quente|escuro|marca","voice":"..."},',
    ' "brand":{"name":"...","tagline":"...","badges":["...","...","..."],"voice":"..."},',
    ' "services":{"title":"Nossos serviços","items":[{"icon":"...","title":"...","desc":"..."}],"voice":"..."},',
    ' "benefit":{"title":"...","subtitle":"...","icon":"...","voice":"..."},',
    ' "cta":{"slogan1":"...","slogan2":"...","phone":"...","contact":"...","footer":"...","voice":"..."}}',
    'Regras:',
    '- hook: a DOR ou desejo do cliente final (ex.: "Quando o calor do Pará aperta..."). title até 7 palavras; subtitle até 14 palavras. mood "quente" para calor/urgência/fome/promoção; "escuro" para problema/segurança; "marca" para o resto.',
    '- brand: name = nome do negócio exatamente como o cliente escreveu (ou como está na logo, se ele não escreveu). tagline até 9 palavras. badges = 3 valores de 1 palavra cada.',
    '- O NOME DA MARCA precisa ser FALADO: obrigatório no voice da cena brand e no voice do cta.',
    '- services.items: 2 a 4 serviços/produtos REAIS do cliente. title até 3 palavras; desc até 9 palavras. Se o cliente não listou, deduza os mais óbvios do ramo.',
    '- benefit: a transformação (title até 5 palavras, subtitle até 10).',
    '- cta: slogan1 e slogan2 curtos (até 5 palavras cada). phone SOMENTE se o cliente informou (senão ""). contact = endereço/@instagram se informado (senão ""). footer = convite final até 10 palavras.',
    `- icon: escolha SOMENTE destes nomes: ${ICON_NAMES.join(', ')}.`,
    '- voice: o texto FALADO naquela cena, em português do Brasil natural e animado. hook 10-16 palavras; brand 10-16; services 18-30 (cite os serviços); benefit 8-14; cta 12-22. No cta, fale o telefone em grupos por extenso (ex.: "noventa e um, nove oito cinco, um um, três um quatro dois"). Sem emojis.',
    '- primaryColor: cor da marca em hex se o cliente disse a cor; senão uma cor que combine com o ramo.',
    '- NUNCA invente preço, telefone, endereço ou prêmio que o cliente não informou.'
  ].join('\n');
}

function fallbackPlan(request, project) {
  const brand = (project && project.brand) || 'Sua Empresa';
  return {
    hook: { title: 'Procurando quem faz direito?', subtitle: 'Qualidade e atendimento que você merece.', icon: 'sparkles', mood: 'marca', voice: 'Procurando quem faz direito, com qualidade e atendimento de verdade?' },
    brand: { name: brand, tagline: 'feito com cuidado do início ao fim', badges: ['Qualidade', 'Agilidade', 'Confiança'], voice: `Conheça a ${brand}. Cuidado do início ao fim.` },
    services: { title: 'Nossos serviços', items: [
      { icon: 'check', title: 'Atendimento', desc: 'Rápido e sem complicação.' },
      { icon: 'star', title: 'Qualidade', desc: 'Resultado que você vê.' },
      { icon: 'shield', title: 'Garantia', desc: 'Tranquilidade para você.' }
    ], voice: 'Atendimento rápido, qualidade de verdade e a tranquilidade que você procura.' },
    benefit: { title: 'Mais tranquilidade', subtitle: 'para o seu dia a dia.', icon: 'heart', voice: 'Mais tranquilidade para o seu dia a dia.' },
    cta: { slogan1: 'Fale com a gente', slogan2: 'Atendimento de verdade', phone: '', contact: '', footer: 'Chame agora e peça seu orçamento!', voice: 'Chame agora no WhatsApp e peça o seu orçamento!' }
  };
}

function sanitizePlan(plan, project) {
  const p = plan || {};
  const str = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const out = {
    primaryColor: /^#[0-9a-f]{6}$/i.test(p.primaryColor || '') ? p.primaryColor : null,
    hook: { title: str(p.hook && p.hook.title, 80), subtitle: str(p.hook && p.hook.subtitle, 140), icon: safeIcon(p.hook && p.hook.icon, 'sparkles'), mood: ['quente', 'escuro', 'marca'].includes(p.hook && p.hook.mood) ? p.hook.mood : 'marca', voice: str(p.hook && p.hook.voice, 260) },
    brand: { name: str((p.brand && p.brand.name) || (project && project.brand), 50), tagline: str(p.brand && p.brand.tagline, 90), badges: ((p.brand && p.brand.badges) || []).slice(0, 3).map((b) => str(b, 16)).filter(Boolean), voice: str(p.brand && p.brand.voice, 260) },
    services: {
      title: str((p.services && p.services.title) || 'Nossos serviços', 30),
      items: ((p.services && p.services.items) || []).slice(0, 4).map((it) => ({ icon: safeIcon(it.icon, 'check'), title: str(it.title, 30), desc: str(it.desc, 90) })).filter((it) => it.title),
      voice: str(p.services && p.services.voice, 400)
    },
    benefit: { title: str(p.benefit && p.benefit.title, 60), subtitle: str(p.benefit && p.benefit.subtitle, 110), icon: safeIcon(p.benefit && p.benefit.icon, 'heart'), voice: str(p.benefit && p.benefit.voice, 240) },
    cta: { slogan1: str(p.cta && p.cta.slogan1, 50), slogan2: str(p.cta && p.cta.slogan2, 50), phone: str(p.cta && p.cta.phone, 24), contact: str(p.cta && p.cta.contact, 40), footer: str(p.cta && p.cta.footer, 90), voice: str(p.cta && p.cta.voice, 320) }
  };
  const fb = fallbackPlan('', project);
  for (const k of ['hook', 'brand', 'benefit', 'cta']) {
    for (const f of Object.keys(fb[k])) if (!out[k][f] || (Array.isArray(out[k][f]) && !out[k][f].length)) out[k][f] = fb[k][f];
  }
  if (out.services.items.length < 2) out.services.items = fb.services.items;
  if (!out.services.voice) out.services.voice = fb.services.voice;
  // a marca tem que ser dita (na apresentação e na chamada), mesmo se a IA esquecer
  const brand = (project && project.brand) || '';
  if (brand) {
    const { mentions } = require('../brandInfo');
    if (!out.brand.name || out.brand.name === 'Sua Empresa') out.brand.name = brand.slice(0, 50);
    if (!mentions(out.brand.voice, brand)) out.brand.voice = `Conheça a ${brand}! ${out.brand.voice}`;
    if (!mentions(out.cta.voice, brand)) out.cta.voice = `${out.cta.voice} ${brand}: chama que a gente resolve!`;
  }
  return out;
}

async function planMotionAd(request, project, refCaptions) {
  const p = project || {};
  const facts = (p.facts || []).map((f) => `${f.key}: ${f.value}`).join('; ');
  const user = [
    `Pedido do cliente: ${request}`,
    p.brand ? `Marca: ${p.brand}` : '',
    p.colors && p.colors.length ? `Cores da marca: ${p.colors.join(', ')}` : '',
    facts ? `Fatos confirmados: ${facts}` : '',
    refCaptions && refCaptions.length ? `Imagens enviadas mostram: ${refCaptions.join(' | ')}` : ''
  ].filter(Boolean).join('\n');
  try {
    const text = await callLLM(planPrompt(), user, { temperature: 0.7, maxTokens: 1400 });
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) return sanitizePlan(JSON.parse(cleaned.slice(s, e + 1)), p);
  } catch (e) {
    console.error('motionAd: roteiro via LLM falhou, usando padrão:', e.message);
  }
  return sanitizePlan(fallbackPlan(request, p), p);
}

// ---------------------------------------------------------------------------
// Cor da marca
// ---------------------------------------------------------------------------
const COLOR_NAMES = {
  azul: '#1565D8', 'azul escuro': '#0F2A6B', 'azul claro': '#2F8FEF', vermelho: '#D32F2F', verde: '#1B8A3A', amarelo: '#E0A800',
  laranja: '#EF6C00', roxo: '#6A2BD1', lilás: '#8E5BD6', rosa: '#D6336C', preto: '#1A1A1A', cinza: '#4A4A4A', marrom: '#6B4226', dourado: '#B8860B', vinho: '#7B1E3A', turquesa: '#0FA3A3'
};
function colorFromProject(project) {
  for (const c of (project && project.colors) || []) {
    const k = String(c).toLowerCase().trim();
    if (/^#[0-9a-f]{6}$/i.test(k)) return k;
    const hit = Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length).find((n) => k.includes(n));
    if (hit) return COLOR_NAMES[hit];
  }
  return null;
}
// cor dominante "viva" da logo (ignora branco, preto e cinza)
async function colorFromLogo(buf) {
  try {
    const { data, info } = await sharp(buf).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 128) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 40 || max < 40 || min > 225) continue; // cinza/preto/branco
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (!best || best.n < (info.width * info.height) * 0.02) return null;
    const h = (v) => Math.round(v / best.n).toString(16).padStart(2, '0');
    return `#${h(best.r)}${h(best.g)}${h(best.b)}`;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mídia
// ---------------------------------------------------------------------------
async function toBuffer(src) {
  if (!src) return null;
  if (Buffer.isBuffer(src)) return src;
  if (String(src).startsWith('data:')) return Buffer.from(String(src).split(',')[1] || '', 'base64');
  const axios = require('axios');
  const r = await axios({ url: src, responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

async function prepareAssets({ logo, product }) {
  const out = { logo: null, product: null, logoBuf: null };
  if (logo) {
    const buf = await toBuffer(logo);
    const png = await sharp(buf).trim({ threshold: 12 }).resize(720, 480, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
    out.logo = `data:image/png;base64,${png.toString('base64')}`;
    out.logoBuf = png;
  }
  if (product) {
    const buf = await toBuffer(product);
    const jpg = await sharp(buf).rotate().resize(700, 700, { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer();
    out.product = `data:image/jpeg;base64,${jpg.toString('base64')}`;
  }
  return out;
}

const { mediaDuration: duration } = require('../mediaDuration');

// Coloca cada fala no início da sua cena e mistura numa trilha só
async function mixVoices(clips, outPath) {
  const inputs = [];
  const filters = [];
  clips.forEach((c, i) => {
    inputs.push('-i', c.file);
    const ms = Math.round(c.at * 1000);
    filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
  });
  filters.push(`${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,loudnorm=I=-15:TP=-1.5:LRA=9[out]`);
  await run(FFMPEG, ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '160k', outPath], { maxBuffer: 1024 * 1024 * 32 });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
// deps: { tts(text, voice) → URL/dataURL do áudio, upload(buffer, mime, name) → URL }
async function buildMotionAd({ request, project, logo, product, refCaptions, voice, withVoice = true, deps, onStatus }) {
  const status = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  try {
    status('Escrevendo o roteiro do anúncio…');
    const [plan, assets] = await Promise.all([
      planMotionAd(request, project, refCaptions),
      prepareAssets({ logo, product })
    ]);

    // cor: 1) cor que o cliente disse  2) cor da logo  3) sugestão do roteiro  4) azul
    const color = colorFromProject(project) || (assets.logoBuf && await colorFromLogo(assets.logoBuf)) || plan.primaryColor || '#1565D8';

    // narração por cena, em paralelo
    const keys = ['hook', 'brand', 'services', 'benefit', 'cta'];
    const durations = {};
    const voiceClips = [];
    if (withVoice) {
      status('Gravando a narração…');
      const files = await Promise.all(keys.map(async (k) => {
        const text = plan[k].voice;
        if (!text) return null;
        try {
          const url = await deps.tts(text, voice);
          const f = path.join(tmp, `voz-${k}.mp3`);
          fs.writeFileSync(f, await toBuffer(url));
          return f;
        } catch (e) {
          console.error(`motionAd: voz da cena ${k} falhou:`, e.message);
          return null;
        }
      }));
      for (let i = 0; i < keys.length; i++) {
        if (files[i]) {
          const d = await duration(files[i]);
          durations[keys[i]] = d + 0.7; // respiro entre falas
          voiceClips.push({ key: keys[i], file: files[i] });
        }
      }
      if (!voiceClips.length) throw new Error('nenhuma narração foi gerada');
    }

    const spec = { pal: E.palette(color), ...plan, assets, durations };
    const video = servicos.build(spec);

    let audioPath = null;
    if (voiceClips.length) {
      audioPath = path.join(tmp, 'voz.mp3');
      await mixVoices(voiceClips.map((c) => ({ file: c.file, at: video.timeline.find((s) => s.key === c.key).start + 0.3 })), audioPath);
    }

    status('Animando as cenas…');
    const out = path.join(tmp, 'anuncio.mp4');
    await E.renderVideo({ frameSvg: video.frameSvg, duration: video.duration, outPath: out, audioPath, W: servicos.W, H: servicos.H,
      onProgress: (p) => status(`Animando as cenas… ${Math.round(p * 100)}%`) });

    status('Finalizando…');
    const buf = fs.readFileSync(out);
    let videoUrl;
    try {
      videoUrl = await deps.upload(buf, 'video/mp4', `anuncio-${Date.now()}.mp4`);
    } catch (e) {
      console.error('motionAd: upload falhou, devolvendo dataURL:', e.message);
      videoUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }
    return { videoUrl, plan, color, duration: video.duration };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { buildMotionAd, planMotionAd, sanitizePlan, colorFromLogo, colorFromProject, prepareAssets, mixVoices, toBuffer };
