// 🎬 ANÚNCIO EM VÍDEO COM VOZ — pipeline do Cérebro Visual
//
// Antes: o Cérebro mandava "faz um vídeo de anúncio com voz" direto para o gerador
// de IMAGEM (que desenhava a palavra "voz"). Agora o pedido passa por etapas, como
// um diretor de vídeo faria:
//
//   1) ROTEIRO  (LLM)   → texto da narração + 3 cenas (visual SEM texto) + legenda de cada cena
//   2) VOZ      (fal Kokoro PT-BR) → narração em MP3
//   3) CENAS    (gerador de imagem) → 1 imagem por cena, usando a foto do produto se houver
//   4) MOVIMENTO (Kling via fal, opcional) → cada cena vira um clipe com movimento real
//                 fallback/econômico: zoom lento (Ken Burns) no ffmpeg
//   5) MONTAGEM (ffmpeg) → cenas no tempo da narração + legendas bonitas + áudio → MP4
//   6) UPLOAD   (fal storage) → URL pública do vídeo final
//
// Variáveis de ambiente:
//   AD_SCENE_MODE = "kling" (padrão, movimento real, mais caro) | "kenburns" (zoom, barato)
//   AD_VOICE_FEMALE / AD_VOICE_MALE = vozes do Kokoro PT-BR (padrão pf_dora / pm_alex)

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { callLLM } = require('./llm');

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Detecção do pedido
// ---------------------------------------------------------------------------
const VIDEO_WORDS = /(v[íi]deo|reels?|comercial|propaganda|vt\b|tiktok|shorts)/i;
const AD_WORDS = /(an[úu]ncio|anunciar|comercial|propaganda|divulga|promo[çc][ãa]o|promover|vender|oferta|campanha|publicidade)/i;
const VOICE_WORDS = /(\bvoz\b|narra[çc][ãa]o|narrad[oa]|narrar|locu[çc][ãa]o|locutor|falad[oa]|falando|com [áa]udio|apresentador|apresentadora)/i;
const NO_VOICE = /(sem (voz|narra[çc][ãa]o|[áa]udio|locu[çc][ãa]o)|mudo)/i;

function isAdVideoRequest(message) {
  const m = String(message || '');
  if (!VIDEO_WORDS.test(m) && !VOICE_WORDS.test(m)) return false;
  // "vídeo com voz" OU "vídeo de anúncio/comercial" → pipeline completo
  if (VIDEO_WORDS.test(m) && require('./presenterAd').isPresenterRequest(m)) return true;
  return (VIDEO_WORDS.test(m) && (VOICE_WORDS.test(m) || AD_WORDS.test(m))) ||
    /(an[úu]ncio|comercial|propaganda)\s+(falad|narrad|com voz)/i.test(m);
}

function wantsVoice(message) {
  return !NO_VOICE.test(String(message || ''));
}

function pickVoice(message) {
  const m = String(message || '');
  if (/(voz|locutor|narrador)\s+(masculin|de homem)|voz de homem|locutor\b|narrador\b|apresentador\b/i.test(m) &&
      !/apresentadora|locutora|narradora|voz feminina|voz de mulher/i.test(m)) {
    return process.env.AD_VOICE_MALE || 'pm_alex';
  }
  return process.env.AD_VOICE_FEMALE || 'pf_dora';
}

function pickFormat(message) {
  const m = String(message || '');
  if (/(horizontal|16:9|youtube|tv\b|telão|widescreen|deitado)/i.test(m)) return { W: 1280, H: 720, gw: 1344, gh: 768, label: '16:9' };
  if (/(quadrad|1:1|feed)/i.test(m)) return { W: 1080, H: 1080, gw: 1024, gh: 1024, label: '1:1' };
  return { W: 1080, H: 1920, gw: 768, gh: 1344, label: '9:16' }; // padrão: Reels/Status/TikTok
}

// Pedido vago demais para um anúncio? (sem produto, sem marca, sem foto)
function needsAdBriefing(message, project, hasImage) {
  if (hasImage) return false;
  const p = project || {};
  if (p.brand || (p.facts && p.facts.length)) return false;
  const stripped = String(message || '')
    .toLowerCase()
    .replace(/(faz|faça|faca|cria|crie|criar|gera|gere|gerar|quero|preciso|me|um|uma|de|do|da|com|pra|para|o|a|em|meu|minha)\b/g, ' ')
    .replace(new RegExp(VIDEO_WORDS.source, 'gi'), ' ')
    .replace(new RegExp(AD_WORDS.source, 'gi'), ' ')
    .replace(new RegExp(VOICE_WORDS.source, 'gi'), ' ')
    .replace(/[^\wà-ú]+/g, ' ')
    .trim();
  return stripped.split(/\s+/).filter((w) => w.length > 2).length < 2;
}

// ---------------------------------------------------------------------------
// 1) Roteiro
// ---------------------------------------------------------------------------
function fallbackPlan(request, project) {
  const brand = (project && project.brand) || 'sua marca';
  return {
    narration: `Procurando qualidade de verdade? Conheça ${brand}. Atendimento de primeira e o melhor custo-benefício da região. Chame agora no WhatsApp e garanta o seu!`,
    scenes: [
      { visual: `eye-catching commercial hero shot related to: ${request}`, caption: `Conheça ${brand}` },
      { visual: `close-up detail shot showing quality, related to: ${request}`, caption: 'Qualidade de verdade' },
      { visual: `happy customer moment, warm lighting, related to: ${request}`, caption: 'Chame no WhatsApp' }
    ]
  };
}

async function planAd(request, project, refCaptions) {
  const p = project || {};
  const facts = (p.facts || []).map((f) => `${f.key}: ${f.value}`).join('; ');
  const sys = [
    'Você é diretor de criação de anúncios em vídeo curtos (Reels/Status) no Brasil.',
    'Crie um anúncio de ~15 segundos a partir do pedido do cliente.',
    'Responda SOMENTE um JSON válido neste formato:',
    '{"narration":"...","scenes":[{"visual":"...","caption":"..."}]}',
    'Regras:',
    '- narration: texto falado em português do Brasil, 30 a 42 palavras, tom animado e natural, gancho na 1ª frase, termina com chamada para ação. Sem emojis. Escreva números e preços por extenso quando ajudar a leitura (ex: "vinte e nove e noventa").',
    '- scenes: exatamente 3 cenas, na ordem da narração.',
    '- visual: descrição em INGLÊS de uma FOTO publicitária (assunto, enquadramento, luz, cenário). PROIBIDO pedir texto, letras, palavras, placas, logos escritos ou legendas na imagem.',
    '- caption: legenda curta em português que aparece na tela (máx. 6 palavras). A última cena traz a chamada para ação (ex: telefone, "Peça já").',
    '- Use SOMENTE fatos dados pelo cliente (preço, telefone, endereço). Não invente preço nem telefone.'
  ].join('\n');
  const user = [
    `Pedido: ${request}`,
    p.brand ? `Marca: ${p.brand}` : '',
    p.colors && p.colors.length ? `Cores da marca: ${p.colors.join(', ')}` : '',
    p.style ? `Estilo: ${p.style}` : '',
    facts ? `Fatos confirmados: ${facts}` : '',
    refCaptions && refCaptions.length ? `Foto(s) enviada(s) pelo cliente mostram: ${refCaptions.join(' | ')}` : ''
  ].filter(Boolean).join('\n');

  try {
    const text = await callLLM(sys, user, { temperature: 0.8, maxTokens: 900 });
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      const plan = JSON.parse(cleaned.slice(s, e + 1));
      if (plan && plan.narration && Array.isArray(plan.scenes) && plan.scenes.length) {
        plan.scenes = plan.scenes.slice(0, 4).map((sc) => ({
          visual: String(sc.visual || '').slice(0, 600),
          caption: String(sc.caption || '').slice(0, 60)
        }));
        plan.narration = String(plan.narration).replace(/\s+/g, ' ').trim().slice(0, 500);
        return plan;
      }
    }
  } catch (e) {
    console.error('adVideo: roteiro via LLM falhou, usando roteiro padrão:', e.message);
  }
  return fallbackPlan(request, p);
}

// ---------------------------------------------------------------------------
// fal.ai — fila (submit → status → response_url)
// ---------------------------------------------------------------------------
async function falQueue(endpoint, body, deadlineMs = 240000) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY não configurada');
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const sub = await axios.post(`https://queue.fal.run/${endpoint}`, body, { headers, timeout: 60000 });
  const { status_url: statusUrl, response_url: responseUrl } = sub.data || {};
  if (!statusUrl || !responseUrl) throw new Error(`fal ${endpoint}: fila não retornou URLs`);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await axios.get(statusUrl, { headers, timeout: 20000, validateStatus: (x) => x < 500 });
    const status = st.data && st.data.status;
    if (status === 'COMPLETED') {
      const rr = await axios.get(responseUrl, { headers, timeout: 30000 });
      return rr.data;
    }
    if (status === 'ERROR' || status === 'CANCELLED') throw new Error(`fal ${endpoint}: ${status}`);
  }
  throw new Error(`fal ${endpoint}: tempo esgotado`);
}

async function generateNarration(text, voice) {
  const out = await falQueue('fal-ai/kokoro/brazilian-portuguese', { prompt: text, voice }, 120000);
  const url = out && ((out.audio && out.audio.url) || (typeof out.audio === 'string' ? out.audio : null));
  if (!url) throw new Error('narração não retornou áudio');
  return url;
}

async function uploadToFal(buffer, mime, fileName) {
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: process.env.FAL_KEY || '' });
  return fal.storage.upload(new Blob([buffer], { type: mime }), { fileName });
}

// ---------------------------------------------------------------------------
// Arquivos / ffmpeg
// ---------------------------------------------------------------------------
async function saveMedia(src, dest) {
  if (typeof src === 'string' && src.startsWith('data:')) {
    fs.writeFileSync(dest, Buffer.from(src.split(',')[1] || '', 'base64'));
    return dest;
  }
  const r = await axios({ url: src, responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(dest, Buffer.from(r.data));
  return dest;
}

const { mediaDuration } = require('./mediaDuration');

function xmlEscape(s) {
  return String(s || '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function wrap(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// Legenda da cena: PNG transparente do tamanho do vídeo, faixa arredondada embaixo
// com a cor da marca (se houver). Texto real (nítido e correto) — nunca desenhado pela IA.
async function captionOverlay(caption, fmt, accent, outPath, isLast) {
  const { W, H } = fmt;
  const fontSize = Math.round(Math.min(W, H) * (isLast ? 0.075 : 0.065));
  const maxChars = Math.max(10, Math.floor((W * 0.8) / (fontSize * 0.58)));
  const lines = wrap(caption, maxChars);
  const lineH = Math.round(fontSize * 1.25);
  const padY = Math.round(fontSize * 0.55);
  const boxH = lines.length * lineH + padY * 2;
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const boxW = Math.min(W * 0.92, longest * fontSize * 0.6 + fontSize * 1.6);
  const boxX = (W - boxW) / 2;
  const boxY = H - boxH - Math.round(H * (fmt.label === '9:16' ? 0.16 : 0.08));
  const texts = lines.map((l, i) =>
    `<text x="${W / 2}" y="${boxY + padY + fontSize + i * lineH - Math.round(fontSize * 0.12)}" font-size="${fontSize}" font-weight="800" fill="#FFFFFF" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${xmlEscape(l)}</text>`
  ).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${Math.round(fontSize * 0.5)}" fill="${accent}" fill-opacity="0.88"/>
    ${texts}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// Converte nome de cor PT → hex (para a faixa da legenda). Padrão: roxo escuro.
function accentFromProject(project) {
  const map = {
    azul: '#1E4FD8', 'azul escuro': '#0F2A6B', vermelho: '#C62828', verde: '#1B8A3A', amarelo: '#C99A00',
    laranja: '#E8651A', roxo: '#6A2BD1', rosa: '#D6336C', preto: '#111111', cinza: '#4A4A4A', marrom: '#6B4226', dourado: '#B8860B'
  };
  const colors = (project && project.colors) || [];
  for (const c of colors) {
    const k = String(c).toLowerCase().trim();
    if (/^#[0-9a-f]{6}$/i.test(k)) return k;
    if (map[k]) return map[k];
    const hit = Object.keys(map).find((name) => k.includes(name));
    if (hit) return map[hit];
  }
  return '#3B1E8C';
}

// Clipe de uma cena, com a duração exata que a narração pede.
//  - se veio um vídeo (Kling): ajusta a velocidade para caber (sem cortar o movimento)
//  - se veio só imagem: zoom lento (Ken Burns)
async function sceneClip({ mediaPath, isVideo, overlayPath, duration, fmt, outPath, index, keepSpeed = false }) {
  const { W, H } = fmt;
  const fps = 30;
  const frames = Math.round(duration * fps);
  let base;
  const inputs = [];
  if (isVideo) {
    const srcDur = (await mediaDuration(mediaPath)) || 5;
    // keepSpeed: vídeo com fala sincronizada (lipsync) não pode mudar de velocidade
    const factor = keepSpeed ? 1 : Math.max(0.5, Math.min(2.5, duration / srcDur));
    inputs.push('-i', mediaPath);
    base = `[0:v]setpts=${factor.toFixed(4)}*PTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},tpad=stop_mode=clone:stop_duration=2,trim=duration=${duration.toFixed(3)},setsar=1[bg]`;
  } else {
    // alterna zoom-in / zoom-out para não ficar repetitivo
    const zoomExpr = index % 2 === 0 ? 'min(zoom+0.0009,1.12)' : 'if(eq(on,0),1.12,max(zoom-0.0009,1.0))';
    inputs.push('-loop', '1', '-i', mediaPath);
    base = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},trim=duration=${duration.toFixed(3)},setsar=1[bg]`;
  }
  inputs.push('-loop', '1', '-i', overlayPath);
  const filter = `${base};[1:v]format=rgba,fade=t=in:st=0.15:d=0.35:alpha=1[cap];[bg][cap]overlay=0:0:shortest=1,format=yuv420p[v]`;
  await run(FFMPEG, ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-t', duration.toFixed(3), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-an', outPath], { maxBuffer: 1024 * 1024 * 64 });
}

// Junta as cenas com transição suave (xfade) e coloca a narração.
async function assemble(clips, durations, audioPath, outPath, fade = 0.4) {
  const inputs = [];
  clips.forEach((c) => inputs.push('-i', c));
  let filter = '';
  let label = '0:v';
  let offset = 0;
  if (clips.length === 1) {
    filter = '[0:v]null[vout]';
  } else {
    for (let i = 1; i < clips.length; i++) {
      offset += durations[i - 1] - fade;
      const out = i === clips.length - 1 ? 'vout' : `x${i}`;
      filter += `${filter ? ';' : ''}[${label}][${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[${out}]`;
      label = out;
    }
  }
  const args = ['-y', ...inputs];
  if (audioPath) args.push('-i', audioPath);
  args.push('-filter_complex', filter, '-map', '[vout]');
  if (audioPath) {
    args.push('-map', `${clips.length}:a`, '-af', 'adelay=250|250,loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath);
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 128 });
}

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------
// deps: { generateImageFromProviders, generateVideoFromProviders, compressReferenceImage }
async function buildAdVideo({ request, project, productImage, refCaptions, deps, onStatus, pronunciations = {} }) {
  const status = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
  const fmt = pickFormat(request);
  const withVoice = wantsVoice(request);
  const voice = pickVoice(request);
  const sceneMode = (process.env.AD_SCENE_MODE || 'kling').toLowerCase();
  const accent = accentFromProject(project);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));

  try {
    // 1) Roteiro
    status('Escrevendo o roteiro do anúncio…');
    const plan = await planAd(request, project, refCaptions);
    const scenes = plan.scenes;

    // 2) Narração (em paralelo com as imagens)
    status('Gravando a narração e criando as cenas…');
    const narrationP = withVoice
      ? generateNarration(require('./speech').speakable(plan.narration, { pronunciations }), voice).then((u) => saveMedia(u, path.join(tmp, 'voz.mp3')))
      : Promise.resolve(null);

    // 3) Imagens das cenas — SEM texto (o texto entra depois, nítido, na montagem)
    let ref = null;
    if (productImage) {
      ref = (await deps.compressReferenceImage(productImage, 1024, 80)) || productImage;
    }
    const brandBits = [
      project && project.colors && project.colors.length ? `color palette: ${project.colors.join(', ')}` : '',
      project && project.style ? `style: ${project.style}` : ''
    ].filter(Boolean).join(', ');
    const NO_TEXT = 'Absolutely no text, no letters, no words, no captions, no signs, no watermark, no logo text.';
    const imagesP = scenes.map((sc, i) => {
      const prompt = [
        ref ? 'Professional advertising photo featuring the EXACT product from the attached image (same shape, colors, label and details).' : 'Professional advertising photo.',
        sc.visual,
        brandBits,
        `Vertical-friendly composition with the main subject centered and space at the bottom.`,
        'Photorealistic, premium commercial lighting, sharp focus, high detail.',
        NO_TEXT
      ].filter(Boolean).join(' ');
      return deps.generateImageFromProviders(prompt, {
        width: fmt.gw,
        height: fmt.gh,
        ...(ref ? { referenceImage: ref, strength: 0.55 } : {})
      }).catch((e) => { console.error(`adVideo: imagem da cena ${i + 1} falhou:`, e.message); return null; });
    });
    const images = await Promise.all(imagesP);
    if (images.every((u) => !u)) throw new Error('nenhuma cena foi gerada');
    // se uma cena falhou, reaproveita a anterior/seguinte em vez de derrubar tudo
    for (let i = 0; i < images.length; i++) {
      if (!images[i]) images[i] = images[i - 1] || images.find(Boolean);
    }

    // 4) Movimento (Kling) — em paralelo; cena que falhar vira Ken Burns
    let motion = images.map(() => null);
    if (sceneMode === 'kling') {
      status('Dando movimento às cenas (pode levar 2–3 minutos)…');
      motion = await Promise.all(images.map((img, i) =>
        deps.generateVideoFromProviders(
          img,
          `Smooth cinematic commercial camera movement (slow push-in or gentle parallax), natural subtle motion of the scene: ${scenes[i].visual}. Keep the product unchanged. No text.`,
          'custom',
          {}
        ).catch((e) => { console.error(`adVideo: movimento da cena ${i + 1} falhou (usando zoom):`, e.message); return null; })
      ));
    }

    const voicePath = await narrationP;

    // 5) Tempo: a narração manda. Sem voz → 5s por cena.
    status('Montando o vídeo final…');
    const fade = 0.4;
    const audioDur = voicePath ? await mediaDuration(voicePath) : 0;
    const total = Math.max(scenes.length * 3.5, audioDur ? audioDur + 0.8 : scenes.length * 5);
    const each = (total + fade * (scenes.length - 1)) / scenes.length;

    const clips = [];
    const durations = [];
    for (let i = 0; i < scenes.length; i++) {
      const isVideo = !!motion[i];
      const mediaPath = path.join(tmp, `cena${i}.${isVideo ? 'mp4' : 'png'}`);
      await saveMedia(isVideo ? motion[i] : images[i], mediaPath);
      const overlayPath = path.join(tmp, `leg${i}.png`);
      await captionOverlay(scenes[i].caption, fmt, accent, overlayPath, i === scenes.length - 1);
      const outPath = path.join(tmp, `clip${i}.mp4`);
      await sceneClip({ mediaPath, isVideo, overlayPath, duration: each, fmt, outPath, index: i });
      clips.push(outPath);
      durations.push(each);
    }

    const finalPath = path.join(tmp, 'anuncio.mp4');
    await assemble(clips, durations, voicePath, finalPath, fade);

    // 6) Upload → URL pública (fallback: dataURL, só para vídeos pequenos)
    const buf = fs.readFileSync(finalPath);
    let videoUrl = null;
    try {
      videoUrl = await uploadToFal(buf, 'video/mp4', `anuncio-${Date.now()}.mp4`);
    } catch (e) {
      console.error('adVideo: upload fal falhou, devolvendo dataURL:', e.message);
      videoUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }

    return {
      videoUrl,
      narration: withVoice ? plan.narration : null,
      scenes,
      format: fmt.label,
      animated: motion.filter(Boolean).length,
      voice: withVoice ? voice : null
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Escolha do estilo + dispatch
// ---------------------------------------------------------------------------
// Padrão: MOTION GRAPHICS (texto sempre certo, logo fiel, barato).
// "com fotos", "realista", "cenas reais" → pipeline de fotos por IA (acima).
function pickStyle(message) {
  if (require('./presenterAd').isPresenterRequest(message)) return 'presenter';
  return /(com fotos?|fotos? reais|realista|cenas? reais|cinematogr|filmad|imagens reais)/i.test(String(message || '')) ? 'photo' : 'motion';
}

// Das imagens anexadas, descobre qual é a LOGO e qual é o PRODUTO.
async function chooseAssets(images, message) {
  const imgs = (images || []).filter((u) => typeof u === 'string' && !/^data:video|\.mp4(\?|$)/i.test(u)).slice(0, 4);
  if (!imgs.length) return { logo: null, product: null };
  const saysLogo = /\blogo|logomarca|minha marca/i.test(String(message || ''));
  let logoIdx = -1;
  if (imgs.length >= 2) {
    try { logoIdx = await require('./logo').detectLogoRef(imgs); } catch (e) {}
    if (logoIdx < 0 && saysLogo) logoIdx = imgs.length - 1; // convenção do Cérebro: logo por último
  } else {
    let alpha = false;
    try {
      const buf = imgs[0].startsWith('data:') ? Buffer.from(imgs[0].split(',')[1] || '', 'base64') : null;
      if (buf) alpha = !!(await sharp(buf).metadata()).hasAlpha;
    } catch (e) {}
    if (saysLogo || alpha) logoIdx = 0;
  }
  const logo = logoIdx >= 0 ? imgs[logoIdx] : null;
  const product = imgs.find((_, i) => i !== logoIdx) || null;
  return { logo, product };
}

async function buildAd({ request, project, images, refCaptions, deps, onStatus }) {
  const style = pickStyle(request);
  const { speakable, parsePronunciations } = require('./speech');
  const pronunciations = { ...((project && project.pronunciations) || {}), ...parsePronunciations(request) };
  const tts = (text, voice) => generateNarration(speakable(text, { pronunciations }), voice);
  if (style === 'presenter') {
    const { buildPresenterAd, pickGender } = require('./presenterAd');
    const { logo, product } = await chooseAssets(images, request);
    const out = await buildPresenterAd({
      request, project, logo, product, refCaptions,
      // a voz acompanha o gênero do apresentador
      voice: pickGender(request) === 'man' ? (process.env.AD_VOICE_MALE || 'pm_alex') : (process.env.AD_VOICE_FEMALE || 'pf_dora'),
      deps: { ...deps, tts, upload: uploadToFal, falQueue, saveMedia, mediaDuration, sceneClip },
      onStatus
    });
    return {
      videoUrl: out.videoUrl,
      style: 'presenter',
      format: '9:16',
      narration: out.plan.scenes.map((s) => s.voice).join(' '),
      scenes: out.plan.scenes.map((s) => ({ caption: s.caption || s.voice }))
    };
  }
  if (style === 'photo') {
    const productImage = (images || []).find((u) => typeof u === 'string' && !/^data:video|\.mp4(\?|$)/i.test(u)) || null;
    const out = await buildAdVideo({ request, project, productImage, refCaptions, deps, onStatus, pronunciations });
    return { ...out, style: 'photo' };
  }
  const { buildMotionAd } = require('./motion/motionAd');
  const { logo, product } = await chooseAssets(images, request);
  const out = await buildMotionAd({
    request, project, logo, product, refCaptions,
    voice: pickVoice(request),
    withVoice: wantsVoice(request),
    deps: { tts, upload: uploadToFal },
    onStatus
  });
  const pl = out.plan;
  return {
    videoUrl: out.videoUrl,
    style: 'motion',
    format: '9:16',
    narration: wantsVoice(request) ? ['hook', 'brand', 'services', 'benefit', 'cta'].map((k) => pl[k].voice).join(' ') : null,
    scenes: [
      { caption: pl.hook.title },
      { caption: pl.brand.name },
      ...pl.services.items.map((it) => ({ caption: it.title })),
      { caption: pl.benefit.title },
      { caption: [pl.cta.phone ? `WhatsApp ${pl.cta.phone}` : pl.cta.slogan1].join('') }
    ]
  };
}

module.exports = {
  buildAd,
  pickStyle,
  chooseAssets,
  isAdVideoRequest,
  needsAdBriefing,
  wantsVoice,
  pickFormat,
  planAd,
  buildAdVideo,
  // expostos para teste da montagem sem gastar API
  _internals: { captionOverlay, sceneClip, assemble, accentFromProject, mediaDuration, falQueue, generateNarration, uploadToFal, saveMedia, pickVoice }
};
