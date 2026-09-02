const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const { enhanceImagePrompt } = require('../llm');
const router = express.Router();
const prisma = new PrismaClient();

// Comprime/redimensiona uma imagem de referência (dataURL, URL ou Buffer) para um
// tamanho seguro para envio à fal.ai. Fotos de celular em base64 podem passar de vários
// MB e estourar o payload HTTP/limite da fal → erro 500 no site. Aqui reduzimos para
// no máximo 1024px no maior lado e formato JPEG/q80 (~150-300KB), bem abaixo do limite.
async function compressReferenceImage(imageDataOrUrl, maxPx = 1024, quality = 80) {
  if (!imageDataOrUrl) return imageDataOrUrl;
  let buffer;
  try {
    if (imageDataOrUrl.startsWith('data:')) {
      const base64 = imageDataOrUrl.split(',')[1];
      buffer = Buffer.from(base64, 'base64');
    } else {
      // URL externa → baixa
      const res = await axios.get(imageDataOrUrl, { responseType: 'arraybuffer', timeout: 30000 });
      buffer = Buffer.from(res.data);
    }
    if (!buffer || buffer.length === 0) return imageDataOrUrl;
  } catch (e) {
    console.error('compressReferenceImage: falha ao obter buffer, usando original:', e.message);
    return imageDataOrUrl;
  }

  try {
    let img = sharp(buffer, { limitInputPixels: false });
    const meta = await img.metadata();
    const w = meta.width || maxPx;
    const h = meta.height || maxPx;
    const scale = Math.min(1, maxPx / Math.max(w, h));
    const out = await img
      .rotate() // corrige orientação EXIF de fotos de celular
      .resize({ width: Math.round(w * scale), height: Math.round(h * scale), fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString('base64')}`;
  } catch (e) {
    console.error('compressReferenceImage: sharp falhou, usando original:', e.message);
    return imageDataOrUrl;
  }
}

// Rate limit por usuário: 1 req/5s free, 1 req/1s premium
const generateLimiter = rateLimit({
  windowMs: 5000,
  max: 1, // 1 requisição por janela (free e premium na mesma proporção base)
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Aguarde antes de gerar novamente.' }
});

// Modelos fallback open-source gratuitos no Hugging Face
const MODELS = {
  image: {
    flux: 'black-forest-labs/FLUX.1-schnell',
    sdxl: 'stabilityai/stable-diffusion-xl-base-1.0',
    sd3: 'stabilityai/stable-diffusion-3-medium-diffusers',
    playground: 'playgroundai/playground-v2.5-1024px-aesthetic'
  }
};

// Otimização automática de prompt: transforma descrição em PT num prompt técnico em inglês
function optimizePrompt(rawPrompt) {
  const trimmed = (rawPrompt || '').trim();
  if (!trimmed) return trimmed;

  const p = trimmed.toLowerCase();

  // Detectar intenção/estilo
  let enhancement = '';
  if (/(produto|product|loja|ecommerce|vender|catálogo)/.test(p)) {
    enhancement = ', professional product photography, studio lighting, clean background, commercial quality, high-end e-commerce imagery';
  } else if (/(logo|logotipo|marca|icone)/.test(p)) {
    enhancement = ', minimalist professional logo design, vector style, clean lines, brand identity, white background';
  } else if (/(poster|cartaz|anuncio|banner|social)/.test(p)) {
    enhancement = ', professional graphic design, striking layout, balanced composition, advertising quality';
  } else if (/(realist|foto|camera|paisagem|retrato|cachorro|pessoa|natureza)/.test(p)) {
    enhancement = ', ultra realistic photograph, 8k, natural lighting, sharp focus, shallow depth of field, professional photography';
  } else if (/(desenho|ilustra|cartoon|anime|pixel|arte)/.test(p)) {
    enhancement = ', detailed digital illustration, vibrant colors, high detail, trending art style';
  }

  // Se o usuário colocou texto entre aspas, mantém o texto na imagem; senão, evita texto espúrio
  const hasQuoted = /"[^"]+"/.test(trimmed) || /(escrever|texto dizendo|com o texto|dizer|palavras?)/.test(p);
  const noText = hasQuoted ? '' : ', no text, no watermark, no letters, no words, no captions';

  return `${trimmed}${enhancement}${noText}`;
}

// Gera imagem via fal.ai (modelos premium: Flux Pro v1.1 / Flux 2 Pro, Ideogram 4.0)
// Flux Pro v1.1 suporta image-to-image (edição real) quando uma imagem de referência é enviada.
async function generateImageFal(prompt, opts) {
  const model = opts.model || 'fluxpro';
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) return null;

  const headers = { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let endpoint;
  let payload;

  if (model === 'ideogram4' || model === 'ideogram') {
    endpoint = 'https://queue.fal.run/fal-ai/ideogram/v4';
    payload = {
      prompt,
      image_size: { width: opts.width || 1024, height: opts.height || 1024 },
      num_images: 1,
      rendering_speed: 'BALANCED',
      expand_prompt: false
    };
  } else {
    // Flux Pro v1.1 (fotorrealismo + suporte a edição com imagem de referência)
    endpoint = 'https://queue.fal.run/fal-ai/flux-pro/v1.1';
    const ratio = opts.aspectRatio || (opts.width > opts.height ? '16:9' : opts.height > opts.width ? '9:16' : '1:1');
    payload = {
      prompt,
      num_images: 1,
      output_format: 'png',
      aspect_ratio: ratio
    };
    if (opts.referenceImage) {
      payload.image = opts.referenceImage;
    }
  }

  const extractImages = (data) => {
    if (!data) return null;
    const images = data.images || data.data || (data.image ? (Array.isArray(data.image) ? data.image : [data.image]) : []);
    if (!images.length) return null;
    const im = images[0];
    return typeof im === 'string' ? im : (im.url || im.image_url || null);
  };

  const res = await axios.post(endpoint, payload, { headers, timeout: 60000 });
  const data = res.data || {};

  // fal.ai é assíncrono: o POST devolve IN_QUEUE/IN_PROGRESS + status_url/response_url.
  // Fluxo correto: sondar status_url até COMPLETED e então baixar o resultado em response_url.
  if (data.status_url) {
    const deadline = Date.now() + (opts.timeout || 240000);
    let status = data.status || 'IN_QUEUE';
    while (Date.now() < deadline) {
      await sleep(2500);
      try {
        const pollRes = await axios.get(data.status_url, { headers, timeout: 30000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        status = pd.status || status;
      } catch (e) {
        // erro transitório na sondagem → continua aguardando
        const st = e.response && e.response.status;
        if (!st || st >= 500) continue;
        console.error('fal.ai status erro:', e.message);
        return null;
      }
      if (status === 'COMPLETED') break;
      if (status === 'ERROR' || status === 'CANCELLED') {
        console.error('fal.ai job falhou:', status);
        return null;
      }
    }

    if (status !== 'COMPLETED') return null;

    // COMPLETED → buscar o resultado em response_url (com pequenas re-tentativas)
    if (data.response_url) {
      for (let tries = 0; tries < 3; tries++) {
        try {
          const final = await axios.get(data.response_url, { headers, timeout: 60000, validateStatus: (s) => s < 500 });
          if (final.status === 200) {
            const out = extractImages(final.data);
            if (out) return out;
            if (final.data && final.data.status === 'COMPLETED') { /* aguarda outro ciclo */ }
          }
        } catch (e) {
          console.error('fal.ai fetch resultado falhou:', e.message);
        }
        await sleep(2000);
      }
    }
    return null;
  }

  // Alguns endpoints respondem síncrono com as imagens direto no corpo do POST
  return extractImages(data);
}

// Gera imagem via Stability AI (SD 3.5 / Core) - 25 creditos gratis, autenticacao Bearer + multipart
// Suporta image-to-image quando uma imagem de referencia e fornecida (campo 'image' + strength)
async function generateImageStability(prompt, opts) {
  const STABILITY_KEY = process.env.STABILITY_API_KEY;
  if (!STABILITY_KEY) return null;
  try {
    const boundary = `----criai${Date.now()}`;
    const LF = '\r\n';
    const fields = { prompt, output_format: 'png', width: String(opts.width || 1024), height: String(opts.height || 1024) };
    if (opts.negativePrompt) fields.negative_prompt = opts.negativePrompt;

    let body = '';
    for (const [k, v] of Object.entries(fields)) {
      body += `--${boundary}${LF}Content-Disposition: form-data; name="${k}"${LF}${LF}${v}${LF}`;
    }

    // Image-to-image: adiciona a imagem base e o parâmetro 'strength'
    if (opts.referenceImage) {
      const imgBuf = await imageToBuffer(opts.referenceImage);
      body += `--${boundary}${LF}Content-Disposition: form-data; name="image"; filename="ref.png"${LF}Content-Type: image/png${LF}${LF}`;
      // Corpo multipart precisa do buffer binário; montamos via concatenação de Buffer
      const prefix = Buffer.from(body, 'utf8');
      const suffix = Buffer.from(`${LF}--${boundary}${LF}Content-Disposition: form-data; name="strength"${LF}${LF}${opts.strength || 0.5}${LF}--${boundary}--${LF}`, 'utf8');
      const finalBody = Buffer.concat([prefix, imgBuf, suffix]);
      const res = await axios.post('https://api.stability.ai/v2beta/stable-image/generate/core', finalBody, {
        headers: {
          Authorization: `Bearer ${STABILITY_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Accept: 'image/*'
        },
        timeout: 90000,
        responseType: 'arraybuffer'
      });
      if (res.data && res.data.byteLength) {
        return `data:image/png;base64,${Buffer.from(res.data).toString('base64')}`;
      }
      return null;
    }

    body += `--${boundary}--${LF}`;

    const res = await axios.post('https://api.stability.ai/v2beta/stable-image/generate/core', body, {
      headers: {
        Authorization: `Bearer ${STABILITY_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Accept: 'image/*'
      },
      timeout: 90000,
      responseType: 'arraybuffer'
    });
    if (res.data && res.data.byteLength) {
      return `data:image/png;base64,${Buffer.from(res.data).toString('base64')}`;
    }
    return null;
  } catch (e) {
    console.error('Stability AI falhou:', (e.response && (e.response.data ? Buffer.from(e.response.data).toString() : e.response.status)) || e.message);
    return null;
  }
}

// Realiza upscaling 4K da imagem (via fal.ai se configurado, senão mantém)
async function upscaleImage(imageUrl, opts, userPlan) {
  const FAL_KEY = process.env.FAL_KEY;
  // Apenas premium recebe upscaling 4K
  if (!FAL_KEY || userPlan !== 'PREMIUM' || opts.upscale !== '4k') return imageUrl;
  try {
    const res = await axios.post('https://queue.fal.run/fal-ai/topaz/v1/upscale', {
      image_url: imageUrl,
      scale: 2
    }, {
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      timeout: 180000
    });
    const dataUrl = res.data.image ? (typeof res.data.image === 'string' ? res.data.image : res.data.image.url) : res.data.url;
    if (dataUrl) return dataUrl;
  } catch (e) {
    console.error('Upscale falhou, usando original:', e.message);
  }
  return imageUrl;
}

// Gerar imagem
router.post('/image', authMiddleware, generateLimiter, async (req, res) => {
  try {
    const { prompt, negativePrompt, model = 'fluxpro', width = 1024, height = 1024, upscale = false, aspectRatio, referenceImage, strength } = req.body;
    const user = req.user;

    if (!prompt || prompt.length < 3) {
      return res.status(400).json({ error: 'Prompt muito curto' });
    }

    // Comprime a imagem de referência para evitar 500 por payload gigante
    // (fotos de celular em base64 podem estourar o limite da fal.ai).
    let refImage = referenceImage;
    if (refImage) {
      try {
        refImage = await compressReferenceImage(refImage);
      } catch (e) {
        console.error('Falha ao comprimir referência:', e.message);
      }
    }

    // Verificar créditos
    const totalImageCredits = user.creditsImages + user.creditsPurchased;
    if (totalImageCredits <= 0) {
      return res.status(403).json({ 
        error: 'Créditos esgotados',
        code: 'NO_CREDITS',
        upgradeUrl: '/plans'
      });
    }

    // Criar registro de geração
    const generation = await prisma.generation.create({
      data: {
        userId: user.id,
        type: 'IMAGE',
        prompt,
        negativePrompt,
        status: 'PROCESSING',
        cost: 1
      }
    });

    // Consumir crédito (primeiro os comprados, depois os mensais)
    let creditsToDeduct = 1;
    if (user.creditsPurchased > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { creditsPurchased: { decrement: 1 } }
      });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { creditsImages: { decrement: 1 } }
      });
    }

    // Otimizar prompt automaticamente via LLM (estilo ChatGPT): reescreve o
    // pedido do usuário em um prompt profissional de imagem. Se o LLM falhar,
    // cai no otimizador leve local por intenção.
    let enhancedPrompt;
    try {
      const enh = await enhanceImagePrompt(prompt);
      enhancedPrompt = enh.prompt || optimizePrompt(prompt);
    } catch (e) {
      console.error('Falha ao melhorar prompt via LLM, usando otimizador local:', e.message);
      enhancedPrompt = optimizePrompt(prompt);
    }
    if (negativePrompt && !enhancedPrompt.includes(negativePrompt)) {
      // Nada a fazer - negative prompt é tratado separadamente abaixo
    }

    // Atualizar geração com o prompt otimizado
    await prisma.generation.update({
      where: { id: generation.id },
      data: { prompt: enhancedPrompt }
    });

    // Gera usando a cadeia de provedores (fal.ai -> Stability AI -> Hugging Face)
    let imageUrl = await generateImageFromProviders(enhancedPrompt, {
      model, width, height, aspectRatio, negativePrompt, referenceImage: refImage, strength
    });

    if (!imageUrl) {
      throw new Error('Nenhum provedor gerou imagem');
    }

    // 3) Upscaling 4K (apenas premium faz; função verifica plano e FAL_KEY)
    if (upscale) {
      imageUrl = await upscaleImage(imageUrl, { upscale: '4k' }, user.plan);
    }

    // Atualizar geração
    await prisma.generation.update({
      where: { id: generation.id },
      data: { status: 'COMPLETED', imageUrl }
    });

    // Buscar créditos atualizados
    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
    });

    res.json({
      success: true,
      generationId: generation.id,
      imageUrl,
      credits: updatedUser
    });

  } catch (err) {
    console.error('Erro na geração:', err.message);

    // Marcar como falha
    if (req.body.generationId) {
      await prisma.generation.update({
        where: { id: req.body.generationId },
        data: { status: 'FAILED' }
      });
    }

    // Devolver crédito em caso de falha
    if (req.user) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { creditsPurchased: { increment: 1 } }
      });
    }

    res.status(500).json({ 
      error: 'Erro ao gerar imagem. Tente novamente.',
      details: err.message 
    });

  }
});

// Converte uma dataURL/base64 ou URL em Buffer de imagem
async function imageToBuffer(imageUrlOrData) {
  if (!imageUrlOrData) throw new Error('Imagem de origem não fornecida');
  if (imageUrlOrData.startsWith('data:')) {
    const base64 = imageUrlOrData.split(',')[1];
    return Buffer.from(base64, 'base64');
  }
  const res = await axios.get(imageUrlOrData, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

// Cadeia de provedores de geração de imagem (fal.ai -> Stability AI -> Hugging Face).
// Usada pelo /image (padrão) e pelo Cérebro Visual (chat de edição).
async function generateImageFromProviders(prompt, opts = {}) {
  const {
    model,
    width,
    height,
    aspectRatio,
    negativePrompt,
    referenceImage,
    strength
  } = opts;

  let imageUrl = null;
  const FAL_KEY = process.env.FAL_KEY;

  // Se há uma imagem de referência, priorizar flux-pro v1.1 (image-to-image real) para
  // realmente editar a imagem original (remover pessoa, trocar cor, colocar logo, etc).
  // Stability AI também suporta img2img; Hugging Face é só texto→imagem (fallback final).
  if (referenceImage) {
    if (FAL_KEY) {
      try {
        imageUrl = await generateImageFal(prompt, { model, width, height, aspectRatio, negativePrompt, referenceImage });
      } catch (e) {
        console.error('fal.ai img2img falhou:', e.message);
      }
    }
    if (!imageUrl) {
      imageUrl = await generateImageStability(prompt, { width, height, negativePrompt, referenceImage, strength });
    }
  }

  // 1) Sem referência: modelos premium via fal.ai (Flux Pro v1.1 / Ideogram 4.0)
  if (!imageUrl && FAL_KEY) {
    try {
      imageUrl = await generateImageFal(prompt, { model, width, height, aspectRatio, negativePrompt });
    } catch (e) {
      console.error('fal.ai falhou:', e.message);
    }
  }

  // 2) Fallback: Stability AI (suporta image-to-image)
  if (!imageUrl) {
    imageUrl = await generateImageStability(prompt, { width, height, negativePrompt, referenceImage, strength });
  }

  // 3) NOTA: sem fallback via Hugging Face — a Railway não tem DNS para
  //    api-inference.huggingface.co (getaddrinfo ENOTFOUND), causando 500 no site.
  //    Se nem fal.ai nem Stability gerarem, devolvemos null e a rota trata.

  return imageUrl;
}

// Constrói o prompt de movimento para a IA de vídeo.
// No modo 'product', descreve um anúncio de apresentação de produto (estilo anúncio de marketplace/Shopee).
function buildVideoPrompt(mode, opts) {
  if (mode === 'product') {
    const name = (opts.productName || '').trim();
    const points = (opts.productDesc || '').trim();
    let p = 'Professional e-commerce product commercial: ';
    if (name) p += `${name}, `;
    p += 'camera slowly rotating around the product, soft studio lighting, clean background, ';
    p += 'gentle motion highlighting the product details and quality, upscale premium feel, ';
    p += 'smooth cinematic movement, no text overlay';
    if (points) p += `. Highlight: ${points}`;
    return p;
  }
  return (opts.prompt || '').trim() || 'animate this image naturally with smooth motion';
}

// Gera vídeo a partir de uma imagem usando fal.ai (image-to-video)
// ATENÇÃO: a Stability AI descontinuou a API de vídeo (jul/2025); por isso usamos fal.ai.
// Requer saldo/créditos na conta fal.ai. Modelo padrão: Kling v2.1 Standard (image-to-video) — 
// ~US$ 0,25 por vídeo de 5s, ótimo custo-benefício para anúncios de produto.
async function generateVideoFal(imageDataOrUrl, prompt, mode, opts) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('fal.ai não configurada (necessário saldo)');

  const finalPrompt = buildVideoPrompt(mode, { ...(opts || {}), prompt });

  const res = await axios.post(
    'https://fal.run/fal-ai/kling-video/v2.1/standard/image-to-video',
    {
      prompt: finalPrompt,
      image_url: imageDataOrUrl,
      duration: '5',
      cfg_scale: 0.5
    },
    {
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 240000
    }
  );

  const video = res.data.video || res.data.data;
  if (typeof video === 'string') return video;
  if (video && video.url) return video.url;
  throw new Error('Sem vídeo no retorno da fal.ai: ' + JSON.stringify(res.data).slice(0, 200));
}

// Gerar vídeo (image-to-video via fal.ai - requer saldo)
// A Stability descontinuou a API de vídeo em jul/2025; usamos fal.ai como provedor.
router.post('/video', authMiddleware, async (req, res) => {
  // Não aplicar generateLimiter para vídeo (é assíncrono e lento);
  // cada requisição bloqueia a resposta por até ~3min.
  try {
    const { imageUrl, duration = 5, mode, prompt } = req.body;
    const user = req.user;
    const imageData = req.body.imageData;

    if (!imageUrl && !imageData) {
      return res.status(400).json({ error: 'Envie uma imagem de origem (imageUrl ou imageData)' });
    }

    // Verificar créditos de vídeo (comprados primeiro, depois mensais)
    if (user.creditsVideos <= 0 && user.creditsPurchased <= 0) {
      return res.status(403).json({ error: 'Créditos de vídeo esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
    }

    const generation = await prisma.generation.create({
      data: {
        userId: user.id,
        type: 'VIDEO',
        prompt: '[image-to-video]',
        status: 'PROCESSING',
        cost: 1
      }
    });

    // Consumir crédito de vídeo
    if (user.creditsPurchased > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { decrement: 1 } } });
    }

    const source = imageData || imageUrl;
    const videoDataUrl = await generateVideoFal(source, prompt, mode, {
      productName: req.body.productName,
      productDesc: req.body.productDesc
    });

    await prisma.generation.update({
      where: { id: generation.id },
      data: { status: 'COMPLETED', imageUrl: videoDataUrl }
    });

    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
    });

    res.json({ success: true, generationId: generation.id, videoUrl: videoDataUrl, credits: updatedUser });
  } catch (err) {
    console.error('Erro na geração de vídeo:', err.message);
    // Devolver crédito em caso de falha
    if (req.user && (req.user.creditsVideos > 0 || req.user.creditsPurchased > 0)) {
      try {
        await prisma.user.update({ where: { id: req.user.id }, data: { creditsVideos: { increment: 1 } } });
      } catch (e) {}
    }
    res.status(500).json({ error: 'Erro ao gerar vídeo. Tente novamente.', details: err.message });
  }
});

// Histórico de gerações
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const generations = await prisma.generation.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(generations);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

router.optimizePrompt = optimizePrompt;
router.generateImageFromProviders = generateImageFromProviders;
module.exports = router;
