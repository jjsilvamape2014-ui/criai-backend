const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const { enhanceImagePrompt, extractTextTokens, ensureRequiredText, suggestPhraseFromRequest, generateAdScript, extractIntent, createConcepts } = require('../llm');
const vision = require('../vision');
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

// Peça cuja ESSÊNCIA é texto impresso (legível, em português): o Ideogram renderiza
// texto muito melhor que o FLUX. Esse classificador decide qual modelo usar.
function looksLikeTextPiece(raw) {
  const s = String(raw || '');
  return /(\btexto\b|\bfrase\b|\bslogan\b|\bchamada\b|\bmanchete\b|\bmensagem\b|com o texto|dizendo|escrev\w+|legenda|escrito)/i.test(s) ||
    /(convite|cart[ãa]o de anivers[áa]rio|birthday invitation)/i.test(s) ||
    /(banner|flyer|panfleto|folder|folheto|cartaz|p[ôo]ster|outdoor|faixa)/i.test(s) ||
    /(logo|logomarca|wordmark|marca)/i.test(s) ||
    /(promo[çc][ãa]o|oferta|desconto|black friday|cupom|an[úu]ncio|sale)/i.test(s) ||
    /R\$\s*\d/.test(s) ||
    /["“”][^"“”]{2,30}["“”]/.test(s) ||
    /(hamb[uú]rguer|pizza|pizzaria|restaurante|hamburgueria)/i.test(s);
}

// Extrai a URL (ou URLs) de imagem do corpo de resposta das APIs da fal.ai,
// suportando os vários formatos de saída (images[], data[], image{}).
function extractImages(data) {
  if (!data) return null;
  const images = data.images || data.data || (data.image ? (Array.isArray(data.image) ? data.image : [data.image]) : []);
  if (!images || !images.length) return null;
  const im = images[0];
  return typeof im === 'string' ? im : (im.url || im.image_url || null);
}

// Gera imagem via fal.ai (modelos premium: Flux Pro v1.1 / Flux 2 Pro, Ideogram 4.0)
// Flux Pro v1.1 suporta image-to-image (edição real) quando uma imagem de referência é enviada.
async function generateImageFal(prompt, opts) {
  const model = opts.model || 'fluxpro';
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) return null;

  const headers = { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isFlux2 = /flux[-_ ]?2/i.test(model) || model === 'flux2pro';
  const isIdeogram = /ideogram/i.test(model);

  // Monta lista de candidatos endpoint/payload em ordem de preferência.
  const buildAttempts = () => {
    if (isIdeogram) {
      // NOTA: o caminho /fal-ai/ideogram/v4 NÃO existe na fal.ai (POST entra na fila mas
      // "conclui" sem gerar imagem). O v3 existe e é excelente em renderizar TEXTO em
      // português. Saída: { images: [{ url }] }.
      return [{
        endpoint: 'https://queue.fal.run/fal-ai/ideogram/v3',
        payload: {
          prompt,
          image_size: { width: opts.width || 1024, height: opts.height || 1024 },
          num_images: 1,
          rendering_speed: 'BALANCED',
          expand_prompt: false
        }
      }];
    }

    if (isFlux2) {
      const tries = [];
      // FLUX 2 Pro: a geração mais obediente ao prompt que existe hoje na fal.ai.
      if (opts.referenceImage) {
        tries.push({
          endpoint: 'https://queue.fal.run/fal-ai/flux-2-pro/edit',
          payload: {
            prompt,
            output_format: 'png',
            enable_safety_checker: true,
            image_urls: [opts.referenceImage],
            ...(opts.width && opts.height ? { image_size: { width: opts.width, height: opts.height } } : {})
          }
        });
      } else {
        tries.push({
          endpoint: 'https://queue.fal.run/fal-ai/flux-2-pro',
          payload: {
            prompt,
            output_format: 'png',
            enable_safety_checker: true,
            ...(opts.width && opts.height ? { image_size: { width: opts.width, height: opts.height } } : {})
          }
        });
      }
      // Rede de segurança: se o FLUX 2 Pro recusar, tenta o Flux Pro v1.1 (mais testado)
      const ratio = opts.aspectRatio || (opts.width > opts.height ? '16:9' : opts.height > opts.width ? '9:16' : '1:1');
      const v11Payload = {
        prompt,
        num_images: 1,
        output_format: 'png',
        aspect_ratio: ratio
      };
      if (opts.referenceImage) v11Payload.image_url = opts.referenceImage;
      tries.push({ endpoint: 'https://queue.fal.run/fal-ai/flux-pro/v1.1', payload: v11Payload });
      return tries;
    }

    // Flux Pro v1.1 (fotorrealismo + suporte a edição com imagem de referência)
    const ratio = opts.aspectRatio || (opts.width > opts.height ? '16:9' : opts.height > opts.width ? '9:16' : '1:1');
    const payload = {
      prompt,
      num_images: 1,
      output_format: 'png',
      aspect_ratio: ratio
    };
    if (opts.referenceImage) {
      // Campo correto do flux-pro v1.1 para image-to-image (o "image" é ignorado pela API,
      // o que fazia o app gerar do zero e desconsiderar a foto anexada).
      payload.image_url = opts.referenceImage;
    }
    return [{ endpoint: 'https://queue.fal.run/fal-ai/flux-pro/v1.1', payload }];
  };

  // Envia para o primeiro candidato que responder; se todos falharem, propaga o último erro.
  let data = null;
  let lastErr = null;
  for (const { endpoint, payload } of buildAttempts()) {
    try {
      const res = await axios.post(endpoint, payload, { headers, timeout: 60000 });
      const d = res.data || {};
      if (d.status_url || (d.images && d.images.length)) { data = d; break; }
    } catch (e) {
      lastErr = e;
      console.error(`fal.ai ${endpoint.split('/').pop()} falhou:`, e.response && e.response.status, (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 160)) || e.message);
    }
  }
  if (!data) { if (lastErr) throw lastErr; return null; }

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

// Edição instrucional de imagem via Nano Banana Pro (Google Gemini image editing) —
// preserva o sujeito/pessoa original e aplica a instrução (ex: "coloca um chapéu").
// Aceita uma (ou mais) imagens de referência em image_urls + prompt de instrução.
async function generateImageNanoBanana(prompt, opts = {}) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) return null;
  const headers = { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const imageUrls = (opts.imageUrls || []).filter(Boolean).slice(0, 4);
  if (!imageUrls.length) return null;

  let endpoint;
  let payload;
  if (process.env.FAL_NANO_EDIT_ENDPOINT) {
    endpoint = process.env.FAL_NANO_EDIT_ENDPOINT;
    payload = {
      prompt,
      num_images: 1,
      output_format: 'png',
      image_urls: imageUrls
    };
  } else {
    endpoint = 'https://queue.fal.run/fal-ai/nano-banana-pro/edit';
    payload = {
      prompt,
      num_images: 1,
      aspect_ratio: 'auto',
      output_format: 'png',
      resolution: '1K',
      limit_generations: true,
      safety_tolerance: '4',
      image_urls: imageUrls
    };
  }

  try {
    const res = await axios.post(endpoint, payload, { headers, timeout: 90000 });
    const data = res.data || {};

    if (data.status_url) {
      const deadline = Date.now() + (opts.timeout || 180000);
      let status = data.status || 'IN_QUEUE';
      while (Date.now() < deadline) {
        await sleep(2500);
        try {
          const pollRes = await axios.get(data.status_url, { headers, timeout: 30000, validateStatus: (s) => s < 500 });
          const pd = pollRes.data || {};
          status = pd.status || status;
        } catch (e) {
          const st = e.response && e.response.status;
          if (!st || st >= 500) continue;
          console.error('nano-banana status erro:', e.message);
          return null;
        }
        if (status === 'COMPLETED') break;
        if (status === 'ERROR' || status === 'CANCELLED') {
          console.error('nano-banana job falhou:', status);
          return null;
        }
      }
      if (status !== 'COMPLETED') return null;
      if (data.response_url) {
        for (let tries = 0; tries < 3; tries++) {
          try {
            const final = await axios.get(data.response_url, { headers, timeout: 60000, validateStatus: (s) => s < 500 });
            if (final.status === 200) {
              const out = extractImages(final.data);
              if (out) return out;
            }
          } catch (e) {
            console.error('nano-banana fetch resultado falhou:', e.message);
          }
          await sleep(2000);
        }
      }
      return null;
    }

    return extractImages(data);
  } catch (e) {
    console.error('nano-banana falhou:', e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    return null;
  }
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

    // Verificar créditos (plano PREMIUM é ilimitado)
    const isUnlimitedImage = user.plan === 'PREMIUM';
    const totalImageCredits = user.creditsImages + user.creditsPurchased;
    if (!isUnlimitedImage && totalImageCredits <= 0) {
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

    // Consumir crédito (plano PREMIUM não consome; primeiro os comprados, depois os mensais)
    let creditsToDeduct = 1;
    if (!isUnlimitedImage && user.creditsPurchased > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { creditsPurchased: { decrement: 1 } }
      });
    } else if (!isUnlimitedImage) {
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
    const genModel = !/ideogram/i.test(model) && !/mystic/i.test(model) && looksLikeTextPiece(prompt) ? 'ideogram' : model;
    let imageUrl = await generateImageFromProviders(enhancedPrompt, {
      model: genModel, width, height, aspectRatio, negativePrompt, referenceImage: refImage, strength
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

// ===== PESQUISA DE REFERÊNCIAS + GERAÇÃO COM STATUS AO VIVO =====
// O Cérebro pesquisa modelos atuais (Freepik) e fontes recomendadas antes de gerar,
// e o usuário VÊ no app onde a IA está pesquisando — como o ChatGPT mostrando busca.

const FONT_DB = [
  { match: /(arraial|festa junina|junina|s[ãa]o jo[ãa]o|festa caipira|bandeirinha)/i, fonts: ['Lilita One', 'Pacifico', 'Lobster'] },
  { match: /(hamburgueria|hamb[uú]rguer|burger|combo|lanche|fast[- ]food)/i, fonts: ['Lilita One', 'Bebas Neue', 'Anton'] },
  { match: /(pizzaria|pizza|italiano|trattoria)/i, fonts: ['Playfair Display', 'Lobster', 'Oswald'] },
  { match: /(restaurante|restaurant|almo[çc]o|jantar|buffet|self[- ]service)/i, fonts: ['Playfair Display', 'Cormorant Garamond', 'Poppins'] },
  { match: /(promo[çc][ãa]o|promo|oferta|desconto|sale|black friday|cupom)/i, fonts: ['Anton', 'Bebas Neue', 'Montserrat'] },
  { match: /(convite|invitation|anivers[áa]rio|birthday|infantil|cart[ãa]o)/i, fonts: ['Baloo 2', 'Titan One', 'Pacifico'] },
  { match: /(logo|logomarca|marca|empresa|corporativ)/i, fonts: ['Montserrat', 'Poppins', 'Playfair Display'] },
  { match: /(faculdade|universidade|escola|curso|vestibular)/i, fonts: ['Montserrat', 'Oswald', 'Roboto'] }
];

function fontsFor(raw) {
  const hits = FONT_DB.filter((f) => f.match.test(raw || ''));
  if (hits.length) {
    const list = [...new Set(hits.flatMap((h) => h.fonts))];
    return list.slice(0, 3);
  }
  return ['Montserrat', 'Poppins'];
}

// Busca modelos do Freepik (e fontes por tema) como referência visual. Sem chave ou
// erro → retorna apenas as fontes, nunca quebra a geração.
async function researchForPrompt(raw) {
  const topic = (raw || '').replace(/[“”"']+/g, '').trim().slice(0, 60);
  const research = { fonts: fontsFor(raw), topic, sources: 0, inspiration: [] };
  const key = process.env.FREEPIK_API_KEY;
  if (!key) return research;
  try {
    const r = await axios.get('https://api.freepik.com/v1/resources', {
      params: {
        locale: 'pt-BR',
        limit: 4,
        order: '-relevance',
        'filters[term][freepik]': topic || 'flyer',
        'filters[is_premium][freepik]': 'false'
      },
      headers: { 'X-Freepik-API-Key': key, 'Accept-Language': 'pt-BR' },
      timeout: 12000
    });
    const items = (r.data && r.data.data) || [];
    research.inspiration = items
      .map((it) => ({
        title: it.title || '',
        thumb: (it.image && ((it.image.source && it.image.source.url) || it.image.url)) || null,
        page: it.url || (it.image && it.image.link) || null
      }))
      .filter((t) => t.thumb)
      .slice(0, 3);
    research.sources = research.inspiration.length;
  } catch (e) {
    console.warn('Pesquisa de referências (Freepik) falhou:', e.message);
  }
  return research;
}

// Geração com status em tempo real (SSE). Fluxo igual à rota /image, mas emite
// eventos mostrando onde a IA está "pesquisando" e cada etapa da criação.
router.post('/live-image', authMiddleware, generateLimiter, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const emitStatus = (text) => send('status', { text });

  try {
    const { prompt, negativePrompt, model = 'fluxpro', width = 1024, height = 1024, upscale = false, aspectRatio, referenceImage, strength } = req.body;
    const user = req.user;
    if (!prompt || String(prompt).trim().length < 3) {
      send('error', { error: 'Prompt muito curto' });
      return res.end();
    }

    const isUnlimitedImage = user.plan === 'PREMIUM';
    const totalImageCredits = user.creditsImages + user.creditsPurchased;
    if (!isUnlimitedImage && totalImageCredits <= 0) {
      send('error', { error: 'Créditos esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
      return res.end();
    }

    const refImage = referenceImage ? await compressReferenceImage(referenceImage).catch(() => null) : null;

    const generation = await prisma.generation.create({
      data: { userId: user.id, type: 'IMAGE', prompt, negativePrompt, status: 'PROCESSING', cost: 1 }
    });

    if (!isUnlimitedImage && user.creditsPurchased > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
    } else if (!isUnlimitedImage) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsImages: { decrement: 1 } } });
    }

    // 1) PESQUISA: onde a IA "navega" por modelos/fontes atuais (Freepik p/ referência)
    emitStatus('Pesquisando modelos atuais e fontes para o seu tema…');
    const research = await researchForPrompt(prompt);
    if (research.sources) {
      send('research', research);
      emitStatus(`Encontrei ${research.sources} modelos de referência + fontes em destaque`);
    } else if (research.fonts && research.fonts.length) {
      send('research', research);
      emitStatus(`Buscando fontes certas para a peça: ${research.fonts.join(', ')}`);
    } else {
      emitStatus('Refinando o tema para buscar referências…');
    }

    // 2) APRIMORA: planeja (interpretador em etapas) e reescreve em prompt profissional
    emitStatus('Tradando o pedido do jeito que um designer faria…');
    let enhancedPrompt;
    let imageRequired = { elements: [], texts: [] };
    try {
      const enh = await enhanceImagePrompt(prompt);
      enhancedPrompt = enh.prompt || optimizePrompt(prompt);
      imageRequired = enh.required || imageRequired;
    } catch (e) {
      console.error('Falha ao melhorar prompt via LLM, usando otimizador local:', e.message);
      enhancedPrompt = optimizePrompt(prompt);
    }

    // 3) Se o usuário pediu "um texto/frase" sem dizer qual, a IA SUGERE uma frase
    const reqTokens = extractTextTokens(prompt);
    if (!reqTokens.length) {
      const phrase = await suggestPhraseFromRequest(prompt, null);
      if (phrase) {
        reqTokens.push(phrase);
        enhancedPrompt = ensureRequiredText(enhancedPrompt, `"${phrase}"`);
        emitStatus(`Sugeri a frase: “${phrase}”`);
      }
    }

    await prisma.generation.update({ where: { id: generation.id }, data: { prompt: enhancedPrompt } });

    // 3b) ESCOLHA DO MODELO: peça com texto impresso → Ideogram (renderiza PT/correto);
    //     o resto → FLUX 2 Pro (a geração mais fiel ao pedido).
    const genModel = !/ideogram/i.test(model) && !/mystic/i.test(model) && looksLikeTextPiece(prompt) ? 'ideogram' : model;

    // 4) GERA
    emitStatus('Gerando a arte com a melhor IA disponível…');
    let imageUrl = await generateImageFromProviders(enhancedPrompt, {
      model: genModel, width, height, aspectRatio, negativePrompt, referenceImage: refImage, strength
    });
    if (!imageUrl) throw new Error('Nenhum provedor gerou imagem');

    // 5) QA de TEXTO: textos pedidos precisam APARECER; se faltaram, refaz 1x de graça
    if (reqTokens.length) {
      try {
        emitStatus('Conferindo se os textos pedidos ficaram corretos…');
        const txtQa = await vision.checkImageText(imageUrl, reqTokens);
        if (txtQa && txtQa.ok === false) {
          emitStatus(`Texto incompleto (${(txtQa.missing || 'conferir')}) — refazendo automaticamente…`);
          await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { increment: 1 } } });
          const retryUrl = await generateImageFromProviders(ensureRequiredText(enhancedPrompt, prompt), {
            model: genModel, width, height, aspectRatio, negativePrompt, referenceImage: refImage, strength
          });
          if (retryUrl) {
            imageUrl = retryUrl;
            if (!isUnlimitedImage) {
              if (user.creditsPurchased > 0) {
                await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
              } else {
                await prisma.user.update({ where: { id: user.id }, data: { creditsImages: { decrement: 1 } } });
              }
            }
          }
        }
      } catch (e) {
        console.error('QA de texto falhou (seguindo com a imagem):', e.message);
      }
    }

    // 5b) QA de ELEMENTOS (o coração do "gera → analisa → corrige"): confere se os
    //     elementos obrigatórios do pedido APARECERAM. Se faltou, refaz uma vez
    //     reforçando explicitamente o que faltou. Funciona nos bastidores —
    //     o usuário só vê "estou corrigindo". Máx. 1 novo gasto de crédito além
    //     do texto, alinhado ao limite prudente (2-3 tentativas no total).
    const requiredElements = (imageRequired.elements || []).filter(Boolean);
    if (requiredElements.length) {
      let elementFixIterations = 0;
      let elUrl = imageUrl;
      try {
        while (elementFixIterations < 2) {
          emitStatus(elementFixIterations === 0 ? 'Conferindo se cada elemento pedido apareceu na imagem…' : 'Conferindo a correção na nova versão…');
          const elQa = await vision.checkImageElements(elUrl, requiredElements);
          if (!elQa || elQa.ok !== false || !(elQa.missing || []).length) break;
          const miss = (elQa.missing || []).join(', ');
          emitStatus(`Ajustei o pedido (falta: ${miss}) — corrigindo…`);
          elementFixIterations += 1;
          await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { increment: 1 } } });
          const correction = [
            enhancedPrompt,
            '',
            'CRITICAL RETRY INSTRUCTION (the user\'s request is LAW):',
            `The previous attempt was REJECTED because these REQUIRED elements were missing or wrong: ${miss}.`,
            'This new version MUST clearly include every one of them, exactly as the user requested, with the same quantities, colors and positions.'
          ].join('\n');
          const retryUrl = await generateImageFromProviders(correction, {
            model: genModel, width, height, aspectRatio, negativePrompt, referenceImage: refImage, strength, force: true
          });
          if (!retryUrl) break;
          elUrl = retryUrl;
          if (!isUnlimitedImage) {
            if (user.creditsPurchased > 0) {
              await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
            } else {
              await prisma.user.update({ where: { id: user.id }, data: { creditsImages: { decrement: 1 } } });
            }
          }
        }
        if (elementFixIterations > 0) imageUrl = elUrl;
      } catch (e) {
        console.error('QA de elementos falhou (seguindo com a imagem):', e.message);
      }
    }

    // 6) UPSCALE opcional
    if (upscale) {
      emitStatus('Aplicando upscale de alta qualidade…');
      imageUrl = await upscaleImage(imageUrl, { upscale: '4k' }, user.plan);
    }

    await prisma.generation.update({ where: { id: generation.id }, data: { status: 'COMPLETED', imageUrl } });
    const credits = await prisma.user.findUnique({
      where: { id: user.id },
      select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
    });

    emitStatus('Pronto! Montando o resultado…');
    send('done', { success: true, generationId: generation.id, imageUrl, credits, research });
  } catch (err) {
    console.error('Erro na geração ao vivo:', err.message);
    if (req.user) {
      await prisma.user.update({ where: { id: req.user.id }, data: { creditsPurchased: { increment: 1 } } });
    }
    send('error', { error: 'Erro ao gerar imagem. Tente novamente.', details: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// Gera imagem via Pollinations.ai — API pública GRÁTIS (sem chave), usa modelos FLUX.
// Serve como rede de segurança de custo zero na cadeia de provedores: quando a fal.ai
async function generateImagePollinations(prompt, opts = {}) {
  const w = opts.width || 1024;
  const h = opts.height || 1024;
  const model = opts.pollinationsModel || 'flux'; // 'flux' é grátis por padrão
  const seed = Math.floor(Math.random() * 100000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&model=${model}&seed=${seed}&nologo=true&enhance=false`;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      validateStatus: (s) => s < 500
    });
    if (res.data && res.data.byteLength > 2000) {
      return `data:image/jpeg;base64,${Buffer.from(res.data).toString('base64')}`;
    }
    return null;
  } catch (e) {
    console.error('pollinations falhou:', e.message);
    return null;
  }
}

// Gera imagem via Magnific API (Mystic — hoje a Magnific é a dona do Freepik).
// ⚠️ PAGO (créditos): 1K ~$0.069, 2K ~$0.119 por imagem. Só age se MAGNIFIC_API_KEY
// estiver configurada (chave só é criada em planos pagos). Fluxo async: POST →
// task_id → poll GET /v1/ai/mystic/{task-id} até COMPLETED. Retorna URL ou null.
function mysticAspect(width, height) {
  if (!width || !height) return 'square_1_1';
  const r = width / height;
  if (Math.abs(r - 1) < 0.15) return 'square_1_1';
  if (r > 1) return r >= 1.5 ? 'widescreen_16_9' : 'classic_4_3';
  return r < 2 / 3 ? 'portrait_9_16' : 'portrait_3_4';
}

async function generateImageMystic(prompt, opts = {}) {
  const key = process.env.MAGNIFIC_API_KEY;
  if (!key) return null;
  const headers = { 'x-magnific-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let structureReference = null;
  if (opts.referenceImage) {
    try {
      const buf = await imageToBuffer(opts.referenceImage);
      // reduz para evitar payload gigante (referência de estrutura é base64)
      let b = buf;
      try {
        b = await sharp(buf, { limitInputPixels: false }).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      } catch (e) {}
      structureReference = b.toString('base64');
    } catch (e) {
      console.error('mystic: falha ao preparar referência:', e.message);
    }
  }

  const payload = {
    prompt: String(prompt || '').slice(0, 4000),
    resolution: opts.resolution || '1k', // 1k | 2k | 4k (barato por padrão)
    aspect_ratio: opts.aspectRatio || mysticAspect(opts.width, opts.height),
    model: opts.mysticModel || 'realism',
    engine: opts.engine || 'automatic',
    filter_nsfw: true,
    fixed_generation: false,
    creative_detailing: typeof opts.creativeDetailing === 'number' ? opts.creativeDetailing : 33,
    adherence: typeof opts.adherence === 'number' ? opts.adherence : 50,
    hdr: typeof opts.hdr === 'number' ? opts.hdr : 50
  };
  if (structureReference) payload.structure_reference = structureReference;
  if (typeof opts.structureStrength === 'number') payload.structure_strength = opts.structureStrength;
  if (Array.isArray(opts.colorsHex) && opts.colorsHex.length) {
    payload.styling = {
      colors: opts.colorsHex.slice(0, 5).map((color, i) => ({ color, weight: +(1 / (i + 1)).toFixed(2) }))
    };
  }

  try {
    const res = await axios.post('https://api.magnific.com/v1/ai/mystic', payload, { headers, timeout: 60000 });
    const taskId = res.data && res.data.data && res.data.data.task_id;
    if (!taskId) {
      console.error('mystic: sem task_id no retorno:', JSON.stringify(res.data).slice(0, 200));
      return null;
    }
    const deadline = Date.now() + (opts.timeout || 150000); // 2K leva ~20-40s
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        const poll = await axios.get(`https://api.magnific.com/v1/ai/mystic/${taskId}`, {
          headers,
          timeout: 30000,
          validateStatus: (s) => s < 500
        });
        const d = poll.data && poll.data.data;
        const status = (d && d.status) || 'IN_PROGRESS';
        if (status === 'COMPLETED') {
          const gen = d.generated || [];
          const url = gen.find((u) => typeof u === 'string') || null;
          if (url) return url;
        }
        if (status === 'FAILED' || status === 'CANCELLED') {
          console.error('mystic: tarefa falhou:', status);
          return null;
        }
      } catch (e) {
        const st = e.response && e.response.status;
        if (st && st === 401) { console.error('mystic: chave inválida.'); return null; }
        if (st && st < 500) { console.error('mystic poll erro:', e.message); return null; }
      }
    }
    return null;
  } catch (e) {
    console.error('mystic falhou:', (e.response && e.response.status), (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 200)) || e.message);
    return null;
  }
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

  // 0) Modelo solicitado "mystic" (Magnific, pago) — só age se houver MAGNIFIC_API_KEY.
  //    Se falhar, cai na cadeia normal (fal → stability → pollinations).
  if (model === 'mystic') {
    try {
      imageUrl = await generateImageMystic(prompt, {
        width, height,
        resolution: opts.resolution || '1k',
        referenceImage,
        structureStrength: opts.structureStrength,
        colorsHex: opts.colorsHex
      });
    } catch (e) {
      console.error('mystic (modelo solicitado) falhou:', e.message);
    }
    if (imageUrl) return imageUrl;
  }

  // Se há uma imagem de referência, priorizar a edição instrucional (Nano Banana Pro /
  // Gemini) que PRESERVA o sujeito/pessoa original (ex: "coloca um chapéu na pessoa").
  // Fallback: flux-pro v1.1 (image-to-image) e Stability AI (img2img).
  if (referenceImage) {
    if (FAL_KEY) {
      try {
        imageUrl = await generateImageNanoBanana(prompt, { imageUrls: Array.isArray(referenceImage) ? referenceImage : [referenceImage] });
      } catch (e) {
        console.error('nano-banana edição falhou:', e.message);
      }
    }
    if (!imageUrl && FAL_KEY) {
      try {
        imageUrl = await generateImageFal(prompt, { model, width, height, aspectRatio, negativePrompt, referenceImage });
      } catch (e) {
        console.error('fal.ai img2img falhou:', e.message);
      }
    }
    if (!imageUrl) {
      imageUrl = await generateImageStability(prompt, { width, height, negativePrompt, referenceImage, strength });
    }
    if (!imageUrl) {
      imageUrl = await generateImagePollinations(prompt, { width, height, negativePrompt });
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

  // 3) Rede de segurança 100% grátis: Pollinations.ai (FLUX, sem chave) — garante que
  //    o usuário SEMPRE receba uma imagem, mesmo se os provedores pagos falharem.
  if (!imageUrl) {
    imageUrl = await generateImagePollinations(prompt, { width, height, negativePrompt });
  }

  // 3) NOTA: sem fallback via Hugging Face — a Railway não tem DNS para
  //    api-inference.huggingface.co (getaddrinfo ENOTFOUND), causando 500 no site.
  //    Se nem fal.ai nem Stability gerarem, devolvemos null e a rota trata.

  return imageUrl;
}

// Estilos prontos de anúncio em vídeo (o Cérebro usa o motion certo para cada um).
// 'promo' é o estilo "impulso de marketplace" (Shopee) — o queridinho dos anúncios.
const VIDEO_AD_PRESETS = {
  afiliado: {
    label: 'Afiliado (Shopee)',
    prompt: 'Affiliate marketplace ad presenting the product to sell: dynamic camera moves around the product revealing every detail, energetic upbeat commercial rhythm, vibrant gradient background with subtle moving light, product pops and shines, popular e-commerce ad style, clean and engaging, no gibberish text'
  },
  promo: {
    label: 'Impulso (Shopee)',
    prompt: 'Punchy marketplace ad: quick energetic push-in zoom toward the product, vibrant saturated colors, subtle flash highlight, bouncy upbeat motion, clean bright background, product pops forward naturally, no text overlay'
  },
  brasil: {
    label: 'Energia BR',
    prompt: 'Brazilian marketplace ad energy: vibrant festive colors, upbeat rhythm, product bouncing with playful motion, confetti-like light particles, joyful commercial feel, clean background, no gibberish text'
  },
  empresa: {
    label: 'Empresa',
    prompt: 'Professional company presentation video: elegant epic camera moves over the brand visual, corporate pride mood, subtle animated light glows following the logo, premium clean style, no gibberish text'
  },
  logo: {
    label: 'Logo',
    prompt: 'Logo presentation commercial: smooth cinematic reveal of the logo, slow zoom and gentle rise, soft depth of field, dark elegant background with subtle light pulses, premium brand identity feel, no gibberish text'
  },
  elegant: {
    label: 'Elegante',
    prompt: 'Luxury product commercial: slow cinematic drift, soft volumetric light, shallow depth of field, smooth elegant float, premium mood, no text overlay'
  },
  lifestyle: {
    label: 'Lifestyle',
    prompt: 'Energetic lifestyle commercial: handheld camera motion turning around the product in a real scene, natural light, color pop, dynamic composition, alive and engaging, no text overlay'
  },
  orbit: {
    label: 'Rotação 360°',
    prompt: 'Showcase video: camera orbiting 360 degrees around the product on a turntable, studio lighting, steady rotation revealing all sides, premium e-commerce presentation, no text overlay'
  },
  hero: {
    label: 'Hero shot',
    prompt: 'Cinematic hero shot: slow gentle push-in toward the product, dramatic studio lighting, background softly blurred, the product as the star, timeless commercial feel, no text overlay'
  }
};

// Constrói o prompt de movimento para a IA de vídeo.
// No modo 'product', descreve um anúncio de apresentação de produto (estilo anúncio de marketplace/Shopee).
function buildVideoPrompt(mode, opts) {
  // Preset escolhido vale A MENOS que o usuário escreva um movimento próprio.
  if (opts.preset && VIDEO_AD_PRESETS[opts.preset] && !String(opts.prompt || '').trim()) {
    const name = (opts.productName || '').trim();
    const points = (opts.productDesc || '').trim();
    const price = (opts.productPrice || '').trim();
    let p = VIDEO_AD_PRESETS[opts.preset].prompt;
    if (name) p = `${name}, ` + p;
    if (points) p += `. Highlight: ${points}`;
    // Anúncio de afiliado pede o preço em destaque (etiqueta animada).
    if (price && (opts.preset === 'afiliado' || opts.preset === 'promo')) {
      p += `. Include an animated price tag clearly showing the exact price: R$ ${price}.`;
    }
    return p;
  }
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

// Gera vídeo via Magnific API — Kling v3 Pro (image-to-video premium, com áudio).
// ⚠️ PAGO (créditos). Só age se MAGNIFIC_API_KEY estiver configurada. Async:
// POST devolve task_id + IN_PROGRESS → poll GET /v1/ai/video/kling-v3-pro/{task-id}.
async function generateVideoMagnific(imageDataOrUrl, prompt, opts = {}) {
  const key = process.env.MAGNIFIC_API_KEY;
  if (!key) throw new Error('MAGNIFIC_API_KEY não configurada');
  const headers = { 'x-magnific-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Deriva o aspect_ratio da imagem de origem quando o chamador não passou.
  let aspect = opts.aspectRatio || '16:9';
  if (!opts.aspectRatio && imageDataOrUrl) {
    try {
      const imgBuf = await imageToBuffer(imageDataOrUrl);
      const meta = await sharp(imgBuf, { limitInputPixels: false }).metadata();
      if (meta && meta.width && meta.height) {
        const r = meta.width / meta.height;
        aspect = Math.abs(r - 1) < 0.15 ? '1:1' : (r > 1 ? '16:9' : '9:16');
      }
    } catch (e) {}
  }

  const payload = {
    prompt: String(prompt || 'animate this image naturally with smooth motion').slice(0, 2000),
    start_image_url: imageDataOrUrl,
    generate_audio: true,
    multi_shot: false,
    aspect_ratio: aspect,
    duration: String(opts.duration || '5'),
    negative_prompt: 'blur, distort, low quality, artifacts',
    cfg_scale: typeof opts.cfgScale === 'number' ? opts.cfgScale : 0.5
  };

  try {
    const res = await axios.post('https://api.magnific.com/v1/ai/video/kling-v3-pro', payload, { headers, timeout: 90000 });
    const taskId = res.data && res.data.data && res.data.data.task_id;
    if (!taskId) {
      console.error('magnific-video: sem task_id:', JSON.stringify(res.data).slice(0, 200));
      return null;
    }
    const deadline = Date.now() + (opts.timeout || 180000);
    while (Date.now() < deadline) {
      await sleep(4000);
      try {
        const poll = await axios.get(`https://api.magnific.com/v1/ai/video/kling-v3-pro/${taskId}`, {
          headers,
          timeout: 30000,
          validateStatus: (s) => s < 500
        });
        const d = poll.data && poll.data.data;
        const status = (d && d.status) || 'IN_PROGRESS';
        if (status === 'COMPLETED') {
          const gen = d.generated || [];
          const url = gen.find((u) => typeof u === 'string') || (d.video && (typeof d.video === 'string' ? d.video : d.video.url)) || null;
          if (url) return url;
        }
        if (status === 'FAILED' || status === 'CANCELLED') {
          console.error('magnific-video: tarefa falhou:', status);
          return null;
        }
      } catch (e) {
        const st = e.response && e.response.status;
        if (st === 401) { console.error('magnific-video: chave inválida.'); return null; }
        if (st && st < 500) { console.error('magnific-video poll erro:', e.message); return null; }
      }
    }
    return null;
  } catch (e) {
    console.error('magnific-video falhou:', (e.response && e.response.status), (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 200)) || e.message);
    return null;
  }
}

// Cadeia de vídeo: Magnific (Kling v3 Pro, se chave existir) → fal.ai (Kling v2.1).
async function generateVideoFromProviders(source, prompt, mode, opts = {}) {
  if (process.env.MAGNIFIC_API_KEY) {
    try {
      const u = await generateVideoMagnific(source, prompt, { ...opts });
      if (u) return u;
    } catch (e) {
      console.error('vídeo Magnific falhou, tentando fal.ai:', e.message);
    }
  }
  return generateVideoFal(source, prompt, mode, opts);
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
    const { imageUrl, duration = 5, mode, prompt, preset } = req.body;
    const user = req.user;
    const imageData = req.body.imageData;

    if (!imageUrl && !imageData) {
      return res.status(400).json({ error: 'Envie uma imagem de origem (imageUrl ou imageData)' });
    }

    // Verificar créditos de vídeo (plano PREMIUM é ilimitado)
    const isUnlimitedVideo = user.plan === 'PREMIUM';
    if (!isUnlimitedVideo && user.creditsVideos <= 0 && user.creditsPurchased <= 0) {
      return res.status(403).json({ error: 'Créditos de vídeo esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
    }

    const generation = await prisma.generation.create({
      data: {
        userId: user.id,
        type: 'VIDEO',
        prompt: `[video${preset ? `:${preset}` : ''}]`,
        status: 'PROCESSING',
        cost: 1
      }
    });

    // Consumir crédito de vídeo (plano PREMIUM não consome)
    if (!isUnlimitedVideo && user.creditsPurchased > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
    } else if (!isUnlimitedVideo) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { decrement: 1 } } });
    }

    const source = imageData || imageUrl;
    // O movimento do vídeo vem do preset de anúncio (ou do prompt/campo livre do usuário)
    const motionPrompt = buildVideoPrompt(mode, req.body);
    const videoDataUrl = await generateVideoFromProviders(source, motionPrompt, mode, {
      productName: req.body.productName,
      productDesc: req.body.productDesc,
      preset
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

// ===== ANÚNCIO FALADO (avatar apresentando o produto com voz) =====
// Pipeline: roteiro (IA) → imagem de um apresentador com o produto → narração em
// PT-BR (fal Kokoro) → lipsync (fal sync-lipsync v3) → vídeo final. SSE ao vivo.

// Submete no fal.queue e espera COMPLETED (mesmo padrão de polling já usado no app).
async function falRunAsync(endpoint, body, deadlineMs = 180000) {
  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY não configurada');
  const res = await axios.post(`https://queue.fal.run/${endpoint}`, body, { headers, timeout: 60000, validateStatus: (s) => s < 500 });
  const data = res.data || {};
  let result = null;
  const deadline = Date.now() + deadlineMs;
  if (data.status_url) {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const pr = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
      const pd = pr.data || {};
      if (pd.status === 'COMPLETED' || pd.output) { result = pd; break; }
      if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
    }
  } else if (data.output) {
    result = data;
  }
  if (!result) throw new Error(`fal ${endpoint} não retornou resultado`);
  return result.output || result;
}

router.post('/talking-ad', authMiddleware, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const emitStatus = (text) => send('status', { text });

  try {
    const { imageData, imageUrl, productName, productDesc, productPrice, script, presenter } = req.body;
    const user = req.user;
    if (!imageData && !imageUrl) {
      send('error', { error: 'Envie a imagem do produto' });
      return res.end();
    }
    const isUnlimited = user.plan === 'PREMIUM';
    const total = user.creditsVideos + user.creditsPurchased;
    if (!isUnlimited && total <= 0) {
      send('error', { error: 'Créditos de vídeo esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
      return res.end();
    }

    const source = imageData || imageUrl;
    const generation = await prisma.generation.create({
      data: { userId: user.id, type: 'VIDEO', prompt: '[anuncio-falado]', status: 'PROCESSING', cost: 1 }
    });

    // Consome 1 crédito de vídeo (PREMIUM não consome)
    if (!isUnlimited && user.creditsPurchased > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
    } else if (!isUnlimited) {
      await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { decrement: 1 } } });
    }

    let videoUrl = null;
    let presenterImage = null;
    let finalScript = null;

    try {
      // 1) Roteiro
      emitStatus('Escrevendo o roteiro do anúncio…');
      finalScript = script || await generateAdScript(req.body) || null;
      if (!finalScript) finalScript = `Olha esse achado! ${productName || 'Esse produto'} é incrível — qualidade de primeira com o melhor preço. Corre que é por tempo limitado!`;

      // 2) Imagem do apresentador segurando o produto (usa a foto enviada como base)
      emitStatus('Criando o apresentador com o seu produto…');
      const isMale = String(presenter || 'mulher').toLowerCase() === 'homem';
      const presenterCore = isMale
        ? 'a handsome, charismatic young Brazilian man in his mid-20s, sharp features, confident and charming'
        : 'a gorgeous, charismatic young Brazilian woman in her mid-20s, naturally beautiful, glowing healthy skin, warm radiant smile';
      presenterImage = await generateImageFromProviders(
        `${presenterCore}, photorealistic commercial, presenting the product from the attached photo: holds it up toward the camera and smiles with authentic enthusiasm, product fully visible and centered, looking directly at the viewer, clean bright modern storefront background softly blurred, vertical 9:16 composition, professional soft lighting like a premium TV commercial, natural realistic skin texture, flawless attractive look`,
        { width: 720, height: 1280, referenceImage: source, strength: 0.6 }
      );
      if (!presenterImage) throw new Error('Não consegui criar a imagem do apresentador');

      // 3) Narração em português (fal Kokoro PT-BR)
      emitStatus('Gerando a narração em português…');
      const audioOut = await falRunAsync('fal-ai/kokoro/brazilian-portuguese', { prompt: finalScript, voice: 'pf_dora' }, 90000);
      const audioUrl = audioOut && ((audioOut.audio && audioOut.audio.url) || (typeof audioOut.audio === 'string' ? audioOut.audio : null));
      if (!audioUrl) throw new Error('Narração não foi gerada');

      // 4) Lipsync: a imagem fala a narração
      emitStatus('Animando o apresentador falando…');
      const videoOut = await falRunAsync('fal-ai/sync-lipsync/v3/image-to-video', { image_url: presenterImage, audio_url: audioUrl }, 240000);
      videoUrl =
        (videoOut && videoOut.video && videoOut.video.url) ||
        (videoOut && typeof videoOut.video === 'string' ? videoOut.video : null) ||
        (typeof videoOut === 'string' ? videoOut : null);
      if (!videoUrl) throw new Error('Vídeo do apresentador não foi gerado');

      await prisma.generation.update({ where: { id: generation.id }, data: { status: 'COMPLETED', imageUrl: videoUrl } });
    } catch (innerErr) {
      console.error('anúncio falado — etapa falhou:', innerErr.message);
      // Devolve o crédito (a geração não foi concluída)
      try {
        await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { increment: 1 } } });
        await prisma.generation.update({ where: { id: generation.id }, data: { status: 'FAILED' } });
      } catch (e2) {}
      throw innerErr;
    }

    const credits = await prisma.user.findUnique({
      where: { id: user.id },
      select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
    });
    emitStatus('Pronto! Montando o resultado…');
    send('done', { success: true, generationId: generation.id, videoUrl, presenterImage, script: finalScript, credits });
  } catch (err) {
    console.error('Erro no anúncio falado:', err.message);
    if (!res.writableEnded) send('error', { error: 'Não consegui gerar o anúncio falado. Tente novamente.', details: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// DIRETORA CRIATIVA: entende a INTENÇÃO do pedido e devolve a confirmação
// "Entendi sua ideia…" + direção criativa. canTakeOver=false → o pedido já é
// uma descrição concreta de imagem (vai direto para a geração).
router.post('/intent', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body || {};
    const msg = String(message || '').trim();
    if (msg.length < 3) return res.status(400).json({ error: 'Mensagem muito curta' });
    const understanding = await extractIntent(msg);
    if (!understanding) return res.status(200).json({ success: true, canTakeOver: false, intent: {}, confirmation: '', direction: '' });
    res.json({ success: true, ...understanding });
  } catch (err) {
    console.error('Falha ao entender intenção:', err.message);
    res.status(500).json({ error: 'Não consegui interpretar agora.' });
  }
});

// "Não sei o que criar": negócio + objetivo → 3 conceitos visuais para escolher.
router.post('/concepts', authMiddleware, async (req, res) => {
  try {
    const { business, goal } = req.body || {};
    const concepts = await createConcepts(business, goal);
    if (!concepts) return res.status(422).json({ error: 'Não consegui criar ideias agora.' });
    res.json({ success: true, concepts });
  } catch (err) {
    console.error('Falha ao criar conceitos:', err.message);
    res.status(500).json({ error: 'Não consegui criar ideias agora.' });
  }
});

// "Olhe como um cliente": avalia a imagem com olhar comercial (notas + sugestão).
router.post('/review', authMiddleware, async (req, res) => {
  try {
    const { imageUrl } = req.body || {};
    if (!imageUrl || typeof imageUrl !== 'string') return res.status(400).json({ error: 'Faltou a imagem' });
    const clientReview = await vision.evaluateAsClient(imageUrl);
    if (!clientReview) return res.status(422).json({ error: 'Não consegui avaliar a imagem agora.' });
    res.json({ success: true, clientReview });
  } catch (err) {
    console.error('Falha na avaliação como cliente:', err.message);
    res.status(500).json({ error: 'Não consegui avaliar a imagem agora.' });
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

// Exclui uma criação do histórico (só do próprio usuário)
router.delete('/history/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const existing = await prisma.generation.findFirst({ where: { id, userId: req.user.id } });
    if (!existing) return res.status(404).json({ error: 'Não encontrada' });
    await prisma.generation.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir' });
  }
});

router.optimizePrompt = optimizePrompt;
router.generateImageFromProviders = generateImageFromProviders;
router.generateVideoFal = generateVideoFal;
router.generateVideoFromProviders = generateVideoFromProviders;
router.compressReferenceImage = compressReferenceImage;
router.generateImageMystic = generateImageMystic;
router.looksLikeTextPiece = looksLikeTextPiece;
router.enhanceImagePrompt = enhanceImagePrompt;
module.exports = router;
