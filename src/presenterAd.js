// 🎤 ANÚNCIO COM APRESENTADOR — vídeo estilo comercial de TV/Reels com uma pessoa
//
// Diferente do "anúncio falado" antigo (1 foto que mexe a boca), aqui o vídeo tem
// cortes, como um comercial de verdade:
//
//   1) ROTEIRO   (LLM)  → 4 cenas: gancho falado, produto em ação, benefício falado,
//                          chamada; cada cena com a SUA fala e a legenda de destaque
//   2) VOZ       (fal Kokoro PT-BR) → 1 áudio por cena (a cena dura o que a fala dura)
//   3) PESSOA    (gerador de imagem) → cria o apresentador na cena 1 e gera as outras
//                 A PARTIR DELA (mesmo rosto, roupa e cenário); com a foto do produto,
//                 ele aparece na mão da pessoa
//   4) MOVIMENTO → cenas faladas: lipsync (boca sincronizada com a voz)
//                  cenas de apoio: Kling (gestos + câmera); falhou → zoom lento
//   5) MONTAGEM  (ffmpeg) → cortes secos entre as cenas + legenda grande + tela final
//                 da marca (logo, slogan, WhatsApp) do motor de motion graphics
//
// Pessoas são sempre criadas pela IA: nunca usar o rosto de alguém real/famoso.

require('./fontSetup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { callLLM } = require('./llm');
const E = require('./motion/engine');
const servicos = require('./motion/templates/servicos');
const { prepareAssets, colorFromProject, colorFromLogo } = require('./motion/motionAd');
const icons = require('./motion/icons');

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const W = 1080;
const H = 1920;
const FPS = 30;
const LIPSYNC_ENDPOINT = process.env.FAL_LIPSYNC_ENDPOINT || 'fal-ai/sync-lipsync/v3/image-to-video';

// cena falada (lipsync) ou de apoio (movimento + voz por cima), nesta ordem
const SHOT_TYPES = ['talk', 'broll', 'talk', 'broll'];

const PRESENTER_WORDS = /(apresentador|apresentadora|apresentando|apresente|pessoa (real )?(falando|mostrando|apresentando)|avatar|influencer|garot[oa][- ]propaganda|\bugc\b|algu[ée]m falando)/i;

function isPresenterRequest(message) {
  return PRESENTER_WORDS.test(String(message || ''));
}

function pickGender(message) {
  const m = String(message || '');
  if (/(apresentador\b|homem|rapaz|garoto[- ]propaganda|masculin)/i.test(m) && !/(apresentadora|mulher|mo[çc]a|garota|feminin)/i.test(m)) return 'man';
  return 'woman';
}

// ---------------------------------------------------------------------------
// 1) Roteiro
// ---------------------------------------------------------------------------
function fallbackPlan(request, project) {
  const brand = (project && project.brand) || '';
  return {
    look: 'mid-20s, friendly confident smile, casual smart outfit',
    setting: 'bright modern store interior, softly blurred background',
    scenes: [
      { voice: brand ? `Olha só o que eu descobri na ${brand}!` : 'Olha só o que eu descobri!', caption: 'Olha isso!', shot: 'close-up, talking to the camera with excitement' },
      { voice: 'Qualidade de verdade, do jeito que você procura.', caption: 'Qualidade de verdade', shot: 'medium shot, showing the product to the camera with both hands' },
      { voice: 'E o melhor: atendimento rápido e preço justo.', caption: 'Preço justo', shot: 'medium close-up, smiling and nodding while talking to the camera' },
      { voice: 'Chama agora no WhatsApp e garanta o seu!', caption: 'Chama no WhatsApp', shot: 'medium shot, pointing at the camera with a big smile' }
    ],
    cta: { slogan1: brand || 'Fale com a gente', slogan2: 'Chame agora', label: 'Atendimento via WhatsApp', footer: '' }
  };
}

async function planPresenter(request, project, refCaptions) {
  const p = project || {};
  const facts = (p.facts || []).map((f) => `${f.key}: ${f.value}`).join('; ');
  const sys = [
    'Você é diretor de comerciais curtos (Reels/TikTok) no Brasil, no estilo de propaganda de TV com um apresentador carismático.',
    'Crie um comercial RÁPIDO de 12 a 18 segundos, com 4 cenas, a partir do pedido do cliente (ritmo de propaganda de marketplace: cortes rápidos, energia alta).',
    'Responda SOMENTE um JSON válido neste formato:',
    '{"look":"...","setting":"...","scenes":[{"voice":"...","caption":"...","shot":"..."}],"cta":{"slogan1":"...","slogan2":"...","label":"...","footer":"..."}}',
    'Regras:',
    '- look: em INGLÊS, a aparência do apresentador (idade aproximada, cabelo). A ROUPA é da COR PRINCIPAL da marca (ex.: "bold red suit over a white shirt"). Pessoa fictícia; nunca uma celebridade nem parecida com uma.',
    '- setting: em INGLÊS, cenário de estúdio de comercial DOMINADO pela cor principal da marca (paredes, luz e objetos nessa cor), com um toque do ramo do negócio. Ex.: "glossy red commercial studio with red shelves and warm rim light".',
    '- scenes: exatamente 4, nesta ordem:',
    '  1. gancho: o apresentador fala olhando para a câmera (close). Primeira frase forte.',
    '  2. apoio: mostra o produto/serviço em ação (a voz continua por cima).',
    '  3. benefício: o apresentador fala olhando para a câmera (plano médio).',
    '  4. chamada: o apresentador aponta para a câmera ou mostra o celular; termina com a chamada para ação.',
    '- voice: fala em português do Brasil, 5 a 12 palavras, curta, animada e direta, como gente falando. Sem emojis. Preços e números por extenso quando ajudar a leitura.',
    '- caption: 2 a 4 palavras de destaque que aparecem grandes na tela (ex.: "FRETE GRÁTIS", "R$ 49,90").',
    '- shot: em INGLÊS, o enquadramento e a ação da cena (ex.: "close-up, talking to the camera, raised eyebrows").',
    '- cta: tela final. slogan1 = nome da marca ou frase curta; slogan2 = oferta ou chamada curta; label = texto acima do contato (ex.: "Peça pelo WhatsApp"); footer = endereço ou site, se houver.',
    '- O NOME DA MARCA precisa ser FALADO pelo apresentador: obrigatório na cena 1 ou 3 e na cena 4. Se o cliente não escreveu o nome, use o que está na logo.',
    '- Use SOMENTE fatos dados pelo cliente (preço, telefone, endereço). Não invente preço, telefone nem promoção.',
    '- NUNCA escreva marcadores de modelo como [Nome da empresa], [Chame a atenção] ou (XX) XXXX-XXXX: o texto vai direto para a tela e para a voz. Se não souber o nome ou o contato, escreva a frase sem eles.'
  ].join('\n');
  const user = [
    `Pedido: ${request}`,
    p.brand ? `Marca: ${p.brand}` : '',
    p.colors && p.colors.length ? `Cores da marca: ${p.colors.join(', ')}` : '',
    p.mainColor ? `Cor principal (use na roupa do apresentador e no cenário, descrevendo o nome da cor em inglês): ${p.mainColor}` : '',
    facts ? `Fatos confirmados: ${facts}` : '',
    refCaptions && refCaptions.length ? `Foto(s) enviada(s) pelo cliente mostram: ${refCaptions.join(' | ')}` : ''
  ].filter(Boolean).join('\n');

  try {
    const text = await callLLM(sys, user, { temperature: 0.8, maxTokens: 1100 });
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      const C = require('./claims');
      const plan = C.cleanPlan(require('./placeholders').cleanPlan(JSON.parse(cleaned.slice(s, e + 1)), p.brand || ''), C.sourceOf({ request, project: p, refCaptions }));
      if (plan && Array.isArray(plan.scenes) && plan.scenes.length >= 4) {
        const fb = fallbackPlan(request, p);
        return {
          look: String(plan.look || fb.look).slice(0, 300),
          setting: String(plan.setting || fb.setting).slice(0, 300),
          scenes: plan.scenes.slice(0, 4).map((sc, i) => ({
            voice: String(sc.voice || sc.caption || fb.scenes[i].voice).replace(/\s+/g, ' ').trim().slice(0, 160),
            caption: String(sc.caption || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            shot: String(sc.shot || fb.scenes[i].shot).slice(0, 300)
          })),
          cta: { ...fb.cta, ...(plan.cta || {}) }
        };
      }
    }
  } catch (e) {
    console.error('presenterAd: roteiro via LLM falhou, usando roteiro padrão:', e.message);
  }
  return fallbackPlan(request, p);
}

// a marca tem que ser dita pelo apresentador, mesmo se a IA esquecer
function ensureBrandSpoken(plan, brand) {
  if (!brand) return plan;
  const { mentions } = require('./brandInfo');
  const sc = plan.scenes;
  if (!sc.slice(0, 3).some((s) => mentions(s.voice, brand))) sc[0].voice = `${sc[0].voice} Aqui na ${brand}!`;
  if (!mentions(sc[3].voice, brand)) sc[3].voice = `${sc[3].voice} É na ${brand}!`;
  return plan;
}

// telefone só se o cliente deu (fatos do projeto ou o próprio pedido)
function findPhone(request, project) {
  const facts = ((project && project.facts) || []).map((f) => String(f.value || '')).join(' ');
  const m = `${request} ${facts}`.match(/(\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4})/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Legenda de destaque (estilo comercial: grande, amarela, contorno escuro)
// ---------------------------------------------------------------------------
async function highlightOverlay(caption, outPath) {
  const txt = String(caption || '').toUpperCase();
  if (!txt) {
    await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(outPath);
    return;
  }
  const fit = E.fitText(txt, { size: 104, minSize: 64, maxWidth: 920, maxLines: 2, weight: 800 });
  const lineH = fit.size * 1.08;
  const baseY = H * 0.70;
  const lines = fit.lines.map((l, i) => {
    const y = (baseY + i * lineH).toFixed(1);
    const attrs = `x="${W / 2}" y="${y}" font-family="${E.FONT}" font-weight="800" font-size="${fit.size}" text-anchor="middle" letter-spacing="1"`;
    return `<text ${attrs} fill="none" stroke="#141014" stroke-width="${Math.round(fit.size * 0.16)}" stroke-linejoin="round" opacity="0.9">${E.esc(l)}</text>` +
      `<text ${attrs} fill="#FFD23F">${E.esc(l)}</text>`;
  }).join('');
  // leve escurecimento embaixo para a legenda ler em qualquer fundo
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs>
    <rect x="0" y="${H * 0.55}" width="${W}" height="${H * 0.45}" fill="url(#g)"/>
    ${lines}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ---------------------------------------------------------------------------
// Tela final da marca (reaproveita a cena de chamada do modelo "Serviços")
// ---------------------------------------------------------------------------
async function renderEndCard({ plan, project, assets, color, phone, outPath, duration = 3.2, presenterImg = null }) {
  if (presenterImg) return renderSplitEndCard({ plan, project, assets, color, phone, outPath, duration, presenterImg });
  const brandName = (project && project.brand) || plan.cta.slogan1 || '';
  const S = {
    pal: E.palette(color),
    assets,
    brand: { name: brandName },
    benefit: { icon: 'star' },
    cta: {
      slogan1: brandName && plan.cta.slogan1 === brandName ? '' : plan.cta.slogan1,
      slogan2: plan.cta.slogan2,
      phone,
      contact: phone ? null : (plan.cta.label || 'Fale com a gente'),
      label: plan.cta.label || 'Atendimento via WhatsApp',
      footer: plan.cta.footer || ''
    }
  };
  const frameSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${servicos.sceneCta(t, duration, S)}</svg>`;
  await E.renderVideo({ frameSvg, duration, outPath, W, H, fps: FPS });
  return outPath;
}

// Tela final estilo marketplace: metade de cima na cor da marca (nome, oferta, contato),
// metade de baixo o apresentador com um zoom lento.
async function renderSplitEndCard({ plan, project, assets, color, phone, outPath, duration, presenterImg }) {
  const pal = E.palette(color);
  const CX = W / 2;
  const brandName = String((project && project.brand) || plan.cta.slogan1 || '').trim();
  const offer = String(plan.cta.slogan2 || '').trim();
  const label = String(plan.cta.label || (phone ? 'Chame no WhatsApp' : 'Fale com a gente'));
  const main = phone || label;
  const nm = E.fitText(brandName.toUpperCase(), { size: 120, minSize: 64, maxWidth: 940, maxLines: 2, weight: 800 });
  const of = E.fitText(offer.toUpperCase(), { size: 56, minSize: 34, maxWidth: 920, maxLines: 2, weight: 800 });
  const mainSize = E.fitText(main, { size: 60, minSize: 36, maxWidth: 600, maxLines: 1, weight: 800 }).size;
  // a faixa de cima tem a altura do conteúdo; o resto é do apresentador
  const hasLogo = !!(assets && assets.logo);
  const nameBottom = hasLogo ? 400 : 200 + (nm.lines.length - 1) * nm.size * 1.02 + 30;
  const offerY = nameBottom + of.size + 10;
  const pillY = offerY + (offer ? (of.lines.length - 1) * of.size * 1.1 + 50 : -of.size + 20);
  const topH = Math.round(pillY + 140 + 70);
  const photoH = H - topH + 40;
  const frameSvg = (t) => {
    const s = E.prog(t, 0.05, 0.6, E.ease.outBack);
    const pp = E.prog(t, 0.6, 0.5, E.ease.outBack);
    const z = 1 + 0.05 * (t / duration);
    const logoOrName = hasLogo
      ? `<image x="${CX - 300}" y="90" width="600" height="300" preserveAspectRatio="xMidYMid meet" xlink:href="${assets.logo}"/>`
      : nm.lines.map((l, i) => `<text x="${CX}" y="${200 + i * nm.size * 1.02}" font-family="${E.FONT}" font-weight="800" font-size="${nm.size}" fill="#FFFFFF" text-anchor="middle">${E.esc(l)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.primary}"/><stop offset="1" stop-color="${pal.deep}"/></linearGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.deep}" stop-opacity="1"/><stop offset="1" stop-color="${pal.deep}" stop-opacity="0"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="${pal.deep}"/>
      <g transform="translate(${CX} ${topH + photoH / 2}) scale(${z.toFixed(4)}) translate(${-CX} ${-(topH + photoH / 2)})">
        <image x="0" y="${topH - 40}" width="${W}" height="${photoH}" preserveAspectRatio="xMidYMin slice" xlink:href="${presenterImg}"/>
      </g>
      <rect x="0" y="${topH - 40}" width="${W}" height="140" fill="url(#fade)"/>
      <rect width="${W}" height="${topH}" fill="url(#bg)"/>
      <g transform="${servicos.scaleAround(CX, 260, Math.max(0.001, s))}">${logoOrName}
        ${of.lines.map((l, i) => `<text x="${CX}" y="${offerY + i * of.size * 1.1}" font-family="${E.FONT}" font-weight="800" font-size="${of.size}" fill="#FFD23F" text-anchor="middle">${E.esc(l)}</text>`).join('')}
      </g>
      ${pp <= 0 ? '' : `<g transform="${servicos.scaleAround(CX, pillY + 70, pp)}">
        <rect x="${CX - 400}" y="${pillY}" width="800" height="140" rx="70" fill="#FFFFFF"/>
        ${phone ? `<circle cx="${CX - 400 + 75}" cy="${pillY + 70}" r="50" fill="${pal.whatsapp}"/>${icons.icon('whatsapp', CX - 400 + 75, pillY + 70, 66, '#FFFFFF', { strokeWidth: 7 })}` : ''}
        <text x="${phone ? CX - 400 + 150 : CX}" y="${pillY + 52}" font-family="${E.FONT}" font-weight="600" font-size="22" fill="${pal.deep}" opacity="0.75" letter-spacing="1.5" ${phone ? '' : 'text-anchor="middle"'}>${E.esc(phone ? label.toUpperCase() : '')}</text>
        <text x="${phone ? CX - 400 + 150 : CX}" y="${pillY + (phone ? 108 : 88)}" font-family="${E.FONT}" font-weight="800" font-size="${mainSize}" fill="${pal.deep}" ${phone ? '' : 'text-anchor="middle"'}>${E.esc(main)}</text>
      </g>`}
    </svg>`;
  };
  await E.renderVideo({ frameSvg, duration, outPath, W, H, fps: FPS });
  return outPath;
}

// ---------------------------------------------------------------------------
// Montagem: cortes secos + áudio de cada cena no início dela
// ---------------------------------------------------------------------------
async function concatWithVoices(clips, durations, voices, outPath) {
  const args = ['-y'];
  clips.forEach((c) => args.push('-i', c));
  const voiceIdx = [];
  voices.forEach((v) => { if (v) { voiceIdx.push(clips.length + voiceIdx.length); args.push('-i', v); } else voiceIdx.push(null); });

  const f = [];
  clips.forEach((_, i) => f.push(`[${i}:v]fps=${FPS},scale=${W}:${H},setsar=1,trim=duration=${durations[i].toFixed(3)},setpts=PTS-STARTPTS[v${i}]`));
  clips.forEach((_, i) => {
    const d = durations[i].toFixed(3);
    if (voiceIdx[i] !== null && voiceIdx[i] !== undefined) {
      f.push(`[${voiceIdx[i]}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      f.push(`anullsrc=r=44100:cl=stereo,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  f.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);
  f.push(`${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1,loudnorm=I=-15:TP=-1.5:LRA=9[aout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', process.env.MOTION_PRESET || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath);
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 128 });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
// deps: {
//   generateImageFromProviders, generateVideoFromProviders, compressReferenceImage,
//   tts(text, voice) → URL, upload(buffer, mime, name) → URL,
//   falQueue(endpoint, body, ms) → resposta, saveMedia(src, dest), mediaDuration(file),
//   sceneClip({...})
// }
async function buildPresenterAd({ request, project, logo, product, refCaptions, voice, deps, onStatus }) {
  const status = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const gender = pickGender(request);
  const person = gender === 'man'
    ? 'a charismatic Brazilian man, natural and trustworthy look'
    : 'a charismatic Brazilian woman, natural and trustworthy look';
  const toUrl = async (src, name) => {
    if (!src || !String(src).startsWith('data:')) return src;
    const buf = Buffer.from(String(src).split(',')[1] || '', 'base64');
    return deps.upload(buf, String(src).slice(5, String(src).indexOf(';')) || 'image/png', name);
  };

  try {
    // 1) Roteiro + logo/cor (em paralelo)
    status('Escrevendo o roteiro do comercial…');
    // a cor vem primeiro: roupa, cenário e tela final saem todos nela (estilo marketplace)
    const assets = await prepareAssets({ logo, product: null });
    const color = colorFromProject(project) || (assets.logoBuf && await colorFromLogo(assets.logoBuf)) || '#E8651A';
    const plan = ensureBrandSpoken(await planPresenter(request, { ...(project || {}), mainColor: color }, refCaptions), project && project.brand);
    const phone = findPhone(request, project);

    // 2) Vozes (em paralelo com as imagens)
    status('Gravando as falas e criando o apresentador…');
    const voicesP = Promise.all(plan.scenes.map(async (sc, i) => {
      try {
        const url = await deps.tts(sc.voice, voice);
        const file = path.join(tmp, `voz${i}.mp3`);
        await deps.saveMedia(url, file);
        return { url: await toUrl(url, `voz${i}.mp3`), file, dur: await deps.mediaDuration(file) };
      } catch (e) {
        console.error(`presenterAd: voz da cena ${i + 1} falhou:`, e.message);
        return null;
      }
    }));

    // 3) Pessoa: cena 1 cria o apresentador; as outras partem dela
    const productRef = product ? ((await deps.compressReferenceImage(product, 1024, 82).catch(() => null)) || product) : null;
    const productLine = productRef ? 'The person holds the EXACT product from the attached image (same shape, colors, label), clearly visible.' : '';
    const NO_TEXT = 'No text, no letters, no captions, no watermark, no logos written.';
    const heroPrompt = [
      'Photorealistic vertical 9:16 frame from a premium Brazilian TV commercial.',
      `${person}, ${plan.look}.`,
      `${plan.scenes[0].shot}. Face fully visible, looking straight into the camera, mouth gently closed.`,
      productLine,
      `Setting: ${plan.setting}.`,
      'Professional soft key light, shallow depth of field, natural skin texture, sharp focus.',
      NO_TEXT
    ].filter(Boolean).join(' ');
    let hero = await deps.generateImageFromProviders(heroPrompt, {
      width: 768, height: 1344,
      ...(productRef ? { referenceImage: [productRef], strength: 0.6 } : {})
    });
    if (!hero) throw new Error('não consegui criar o apresentador');
    hero = await toUrl(hero, 'apresentador.png');

    status('Gravando as outras cenas com a mesma pessoa…');
    const refs = productRef ? [hero, productRef] : [hero];
    const others = await Promise.all(plan.scenes.slice(1).map((sc, k) => {
      const i = k + 1;
      const prompt = [
        'Photorealistic vertical 9:16 frame from the same TV commercial.',
        'The SAME person as in the first image: identical face, hair, skin tone and outfit, same setting and lighting.',
        `New camera shot: ${sc.shot}.`,
        SHOT_TYPES[i] === 'talk' ? 'Face fully visible, looking straight into the camera, mouth gently closed.' : 'Natural, expressive body language.',
        productRef ? 'If the product appears, it must be the EXACT product from the second image, unchanged.' : '',
        NO_TEXT
      ].filter(Boolean).join(' ');
      return deps.generateImageFromProviders(prompt, { width: 768, height: 1344, referenceImage: refs, strength: 0.5 })
        .then((u) => (u ? toUrl(u, `cena${i}.png`) : null))
        .catch((e) => { console.error(`presenterAd: imagem da cena ${i + 1} falhou:`, e.message); return null; });
    }));
    const images = [hero, ...others].map((u) => u || hero);

    const voices = await voicesP;
    if (voices.every((v) => !v)) throw new Error('nenhuma fala foi gerada');

    // 4) Movimento: fala → lipsync; apoio → Kling. Tudo em paralelo; o que falhar vira zoom.
    status('Animando o apresentador (2 a 4 minutos)…');
    const motion = await Promise.all(images.map(async (img, i) => {
      const sc = plan.scenes[i];
      if (SHOT_TYPES[i] === 'talk' && voices[i]) {
        try {
          const out = await deps.falQueue(LIPSYNC_ENDPOINT, { image_url: img, audio_url: voices[i].url }, 360000);
          const url = (out && out.video && out.video.url) || (out && typeof out.video === 'string' ? out.video : null);
          if (url) return { url, lipsync: true };
          throw new Error('lipsync sem vídeo no retorno');
        } catch (e) {
          console.error(`presenterAd: lipsync da cena ${i + 1} falhou (usando movimento):`, e.message);
        }
      }
      try {
        const url = await deps.generateVideoFromProviders(
          img,
          `Cinematic TV commercial shot: ${sc.shot}. Natural confident gestures, subtle camera push-in. Keep the person's face, outfit and the product unchanged. No text.`,
          'custom',
          {}
        );
        return url ? { url, lipsync: false } : null;
      } catch (e) {
        console.error(`presenterAd: movimento da cena ${i + 1} falhou (usando zoom):`, e.message);
        return null;
      }
    }));

    // 5) Montagem
    status('Montando o comercial…');
    const clips = [];
    const durations = [];
    for (let i = 0; i < images.length; i++) {
      const v = voices[i];
      const dur = Math.max(2.4, (v ? v.dur : 3) + 0.35);
      const m = motion[i];
      const mediaPath = path.join(tmp, `cena${i}.${m ? 'mp4' : 'png'}`);
      await deps.saveMedia(m ? m.url : images[i], mediaPath);
      const overlayPath = path.join(tmp, `leg${i}.png`);
      await highlightOverlay(plan.scenes[i].caption, overlayPath);
      const outPath = path.join(tmp, `clip${i}.mp4`);
      await deps.sceneClip({ mediaPath, isVideo: !!m, overlayPath, duration: dur, fmt: { W, H, label: '9:16' }, outPath, index: i, keepSpeed: !!(m && m.lipsync) });
      clips.push(outPath);
      durations.push(dur);
    }

    status('Criando a tela final da marca…');
    const endPath = path.join(tmp, 'final.mp4');
    const endDur = 3.2;
    let presenterImg = null;
    try {
      const heroFile = path.join(tmp, 'hero-final.img');
      await deps.saveMedia(images[images.length - 1] || hero, heroFile);
      const jpg = await sharp(heroFile).resize(W, Math.round(H * 0.7), { fit: 'cover', position: 'top' }).jpeg({ quality: 88 }).toBuffer();
      presenterImg = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    } catch (e) {
      console.error('presenterAd: tela final sem apresentador:', e.message);
    }
    await renderEndCard({ plan, project, assets, color, phone, outPath: endPath, duration: endDur, presenterImg });
    clips.push(endPath);
    durations.push(endDur);

    const finalPath = path.join(tmp, 'comercial.mp4');
    await concatWithVoices(clips, durations, [...voices.map((v) => (v ? v.file : null)), null], finalPath);

    const buf = fs.readFileSync(finalPath);
    let videoUrl;
    try {
      videoUrl = await deps.upload(buf, 'video/mp4', `comercial-${Date.now()}.mp4`);
    } catch (e) {
      console.error('presenterAd: upload falhou, devolvendo dataURL:', e.message);
      videoUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }
    return {
      videoUrl,
      plan,
      lipsynced: motion.filter((m) => m && m.lipsync).length,
      animated: motion.filter(Boolean).length,
      duration: durations.reduce((a, b) => a + b, 0)
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { buildPresenterAd, planPresenter, isPresenterRequest, pickGender, _internals: { highlightOverlay, renderEndCard, concatWithVoices, findPhone, fallbackPlan, ensureBrandSpoken } };
