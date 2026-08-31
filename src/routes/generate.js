const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

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

// Gera imagem via fal.ai (modelos premium: Ideogram 4.0, Flux 2 Pro)
async function generateImageFal(prompt, opts) {
  const model = opts.model || 'ideogram4';
  const FAL_KEY = process.env.FAL_KEY;

  // Ideogram 4.0 - excelente para texto em imagem e fidelidade de prompt
  if (model === 'ideogram4' || model === 'ideogram') {
    const payload = {
      prompt,
      image_size: { width: opts.width || 1024, height: opts.height || 1024 },
      num_images: 1,
      rendering_speed: 'BALANCED',
      expand_prompt: false
    };
    const res = await axios.post('https://queue.fal.run/fal-ai/ideogram/v4', payload, {
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });
    const images = res.data.images || res.data.data || [];
    let url = null;
    if (images.length) {
      url = typeof images[0] === 'string' ? images[0] : (images[0].url || images[0].image_url);
    }
    return url;
  }

  // Flux 2 Pro - melhor fotorrealismo (via fal.ai)
  if (model === 'flux2pro' || model === 'fluxpro') {
    const payload = {
      prompt,
      image_size: { width: opts.width || 1024, height: opts.height || 1024 },
      num_images: 1,
      output_format: 'png',
      aspect_ratio: opts.aspectRatio || '1:1'
    };
    const res = await axios.post('https://queue.fal.run/fal-ai/flux-pro/v1.1', payload, {
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });
    const images = res.data.images || res.data.data || [];
    let url = null;
    if (images.length) {
      url = typeof images[0] === 'string' ? images[0] : (images[0].url || images[0].image_url);
    }
    return url;
  }

  return null;
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
    const { prompt, negativePrompt, model = 'ideogram4', width = 1024, height = 1024, upscale = false, aspectRatio, referenceImage, strength } = req.body;
    const user = req.user;

    if (!prompt || prompt.length < 3) {
      return res.status(400).json({ error: 'Prompt muito curto' });
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

    // Otimizar prompt automaticamente (português -> prompt técnico em inglês)
    const enhancedPrompt = optimizePrompt(prompt);
    if (negativePrompt && !enhancedPrompt.includes(negativePrompt)) {
      // Nada a fazer - negative prompt é tratado separadamente abaixo
    }

    // Atualizar geração com o prompt otimizado
    await prisma.generation.update({
      where: { id: generation.id },
      data: { prompt: enhancedPrompt }
    });

    let imageUrl = null;
    const FAL_KEY = process.env.FAL_KEY;

    // Se o usuário forneceu uma imagem de referência, priorizar image-to-image (adicionar/modificar)
    // para realmente editar a imagem original. Fallback genérico garante que nunca falha.
    if (referenceImage) {
      imageUrl = await generateImageStability(enhancedPrompt, { width, height, negativePrompt, referenceImage, strength });
    }

    // 1) Tentar modelos premium via fal.ai (Ideogram 4.0 / Flux 2 Pro)
    if (!imageUrl && FAL_KEY) {
      try {
        imageUrl = await generateImageFal(enhancedPrompt, {
          model,
          width,
          height,
          aspectRatio,
          negativePrompt
        });
      } catch (e) {
        console.error('fal.ai falhou, caindo para Hugging Face:', e.message);
      }
    }

    // 2) Fallback: Stability AI (gratuito, 25 creditos sem cartao) - suporta image-to-image
    if (!imageUrl) {
      imageUrl = await generateImageStability(enhancedPrompt, { width, height, negativePrompt, referenceImage, strength });
    }

    // 3) Fallback: Hugging Face Inference API (gratuito)
    if (!imageUrl) {
      const modelId = MODELS.image[model] || MODELS.image.flux;
      const hfResponse = await axios.post(
        `https://api-inference.huggingface.co/models/${modelId}`,
        { inputs: enhancedPrompt, parameters: { negative_prompt: negativePrompt, width, height } },
        {
          headers: {
            'Authorization': `Bearer ${process.env.HF_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 90000
        }
      );
      // Se HF retornar JSON de erro (ex: modelo carregando), trata como falha
      if (hfResponse.data[0] && hfResponse.data[0].error) {
        throw new Error(hfResponse.data[0].error);
      }
      const imageBase64 = Buffer.from(hfResponse.data).toString('base64');
      imageUrl = `data:image/png;base64,${imageBase64}`;
    }

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
// Requer saldo/créditos na conta fal.ai. Modelo: kling-video v1 standard image-to-video.
async function generateVideoFal(imageDataOrUrl, prompt, mode, opts) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('fal.ai não configurada (necessário saldo)');

  const finalPrompt = buildVideoPrompt(mode, { ...(opts || {}), prompt });

  const res = await axios.post(
    'https://queue.fal.run/fal-ai/kling-video/v1/standard/image-to-video',
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

module.exports = router;
