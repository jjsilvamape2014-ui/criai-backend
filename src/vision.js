const axios = require('axios');
const crypto = require('crypto');
const sharp = require('sharp');

// Visão do Cérebro: olha a imagem de referência (flyer, logo, foto) e descreve o
// que vê — conteúdo, cores, textos exatos (nome, preço, telefone, slogan). O
// resultado é injetado no raciocínio (parse + prompts) para o modelo "entender"
// a imagem como o ChatGPT entende, não apenas heurística de formato.
//
// Usa o modelo Qwen2.5-VL na fal.ai (barato, ótimo OCR/visão). Desligue com
// VISION_ENABLED=false. Nunca quebra o fluxo: sem chave, erro ou timeout → null.

const cache = new Map(); // sha1 do conteúdo -> descrição (evita custo/latência repetidos)

function isEnabled() {
  return process.env.VISION_ENABLED !== 'false';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT_VISION = [
  'Descreva brevemente esta imagem em português. Seja objetivo (máx. 70 palavras):',
  '- O que é: foto, produto, logo/emblema, cartaz/flyer, banner, post, arte.',
  '- Sujeito/conteúdo principal e ambiente.',
  '- Cores dominantes.',
  '- TODOS os textos visíveis escritos EXATAMENTE (nome, preço, telefone, slogan, endereço, chamada).',
  '- Se for logo: diga se é ícone/emblema ou apenas texto (wordmark) e o texto exato dela.',
  'Formato: frases curtas em uma linha.'
].join(' ');

async function compress(src, maxPx = 768, quality = 70) {
  let buffer;
  if (src && src.startsWith('data:')) {
    const b64 = src.split(',')[1];
    buffer = b64 ? Buffer.from(b64, 'base64') : null;
  } else if (/^https?:\/\//.test(src)) {
    const res = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 });
    buffer = res.data;
  }
  if (!buffer || !buffer.length) return null;
  const img = sharp(buffer, { limitInputPixels: false });
  const meta = await img.metadata();
  const w = meta.width || maxPx;
  const h = meta.height || maxPx;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const out = await img
    .rotate()
    .resize({ width: Math.round(w * scale), height: Math.round(h * scale), fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

// Descreve uma imagem (dataURL ou URL). Retorna string ou null (sem quebrar o fluxo).
async function describeReference(src) {
  try {
    if (!isEnabled() || !process.env.FAL_KEY) return null;
    let key = src;
    if (src && src.startsWith('data:')) {
      const b64 = src.split(',')[1];
      key = crypto.createHash('sha1').update(b64 || '').digest('hex');
    }
    if (cache.has(key)) return cache.get(key);

    const compressed = await compress(src);
    if (!compressed) return null;

    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
    const res = await axios.post(
      'https://queue.fal.run/fal-ai/qwen/qwen2.5-vl-7b-instruct',
      { prompt: PROMPT_VISION, image_url: compressed, max_tokens: 400 },
      { headers, timeout: 30000, validateStatus: (s) => s < 500 }
    );
    const data = res.data || {};
    let caption = null;
    if (data.status_url) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const pollRes = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        if (pd.status === 'COMPLETED' || pd.output) {
          caption = typeof pd.output === 'string' ? pd.output : (pd.output && (pd.output.content || pd.output.text)) || null;
          break;
        }
        if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
      }
    } else if (typeof data.output === 'string') {
      caption = data.output;
    } else if (data.output && (data.output.content || data.output.text)) {
      caption = data.output.content || data.output.text;
    }

    caption = (caption || '').trim().replace(/\s+/g, ' ').slice(0, 400);
    if (caption) {
      cache.set(key, caption);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return caption;
    }
    return null;
  } catch (e) {
    console.error('visão do Cérebro falhou:', e.message);
    return null;
  }
}

// QA rigoroso: avalia a imagem (gerada ou enviada) como diretor de arte.
// Retorna { ok: boolean, reason?: string } ou null (sem chave/erro → não quebra).
const PROMPT_QA = [
  'You are a strict art director doing QA on an image.',
  'Inspect it carefully. Reply EXACTLY one of these two forms:',
  '"OK" when the image is acceptable,',
  'or "BAD: <short reason in Portuguese>" when there is any real problem, choosing the most severe:',
  '- deformed/missing/extra fingers or hands, distorted faces, duplicated body parts',
  '- cut off or crop-cut important elements',
  '- gibberish, mangled, misspelled or wrong text (words/letters that make no sense)',
  '- excessive blur, heavy noise, artifacts, severe overexposure',
  '- visible watermark or distortion',
  'Never call it BAD for style, composition or taste choices. Be pragmatic: minor imperfections are OK.'
].join(' ');

async function checkImageQuality(src) {
  try {
    if (!isEnabled() || !process.env.FAL_KEY) return null;
    let key = src;
    if (src && src.startsWith('data:')) {
      const b64 = src.split(',')[1];
      key = 'qa:' + crypto.createHash('sha1').update(b64 || '').digest('hex');
    }
    if (cache.has(key)) return cache.get(key);

    const compressed = await compress(src, 640, 66);
    if (!compressed) return null;

    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
    const res = await axios.post(
      'https://queue.fal.run/fal-ai/qwen/qwen2.5-vl-7b-instruct',
      { prompt: PROMPT_QA, image_url: compressed, max_tokens: 80 },
      { headers, timeout: 30000, validateStatus: (s) => s < 500 }
    );
    const data = res.data || {};
    let text = null;
    if (data.status_url) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const pollRes = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        if (pd.status === 'COMPLETED' || pd.output) {
          text = typeof pd.output === 'string' ? pd.output : (pd.output && (pd.output.content || pd.output.text)) || null;
          break;
        }
        if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
      }
    } else if (typeof data.output === 'string') {
      text = data.output;
    } else if (data.output && (data.output.content || data.output.text)) {
      text = data.output.content || data.output.text;
    }

    const raw = (text || '').trim();
    const ok = !/^BAD:/i.test(raw);
    const out = { ok, reason: ok ? '' : raw.replace(/^BAD:\s*/i, '').slice(0, 120) };
    cache.set(key, out);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    console.error('QA de imagem falhou:', e.message);
    return null;
  }
}

// QA de TEXTO: confere se os textos obrigatórios pedidos (nome, idade, preço...)
// APARECERAM corretos na imagem gerada. Retorna { ok, missing? } ou null (não quebra).
async function checkImageText(src, tokens) {
  try {
    if (!isEnabled() || !process.env.FAL_KEY) return null;
    if (!tokens || !tokens.length) return null;
    const tag = Array.isArray(tokens) ? tokens.join(' | ') : String(tokens);
    let key = src;
    if (src && src.startsWith('data:')) {
      key = 'txt:' + crypto.createHash('sha1').update(src.split(',')[1] || '').digest('hex') + '|' + tag;
    } else {
      key = 'txt:' + src + '|' + tag;
    }
    if (cache.has(key)) return cache.get(key);

    const compressed = await compress(src, 640, 66);
    if (!compressed) return null;

    const prompt = [
      'You are a strict proofreader checking printed text inside an image.',
      `These exact texts were requested: "${tag}".`,
      'Look at the image carefully. For EACH requested text, check if it is visible, complete and correctly spelled.',
      'Reply EXACTLY one of:',
      '"OK" if ALL requested texts are present and correctly spelled,',
      'or "MISSING: <each missing or miswritten text separated by |>" listing ONLY the problems.',
      'Ignore unrelated text. Reply nothing else.'
    ].join(' ');

    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
    const res = await axios.post(
      'https://queue.fal.run/fal-ai/qwen/qwen2.5-vl-7b-instruct',
      { prompt, image_url: compressed, max_tokens: 100 },
      { headers, timeout: 30000, validateStatus: (s) => s < 500 }
    );
    const data = res.data || {};
    let text = null;
    if (data.status_url) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const pollRes = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        if (pd.status === 'COMPLETED' || pd.output) {
          text = typeof pd.output === 'string' ? pd.output : (pd.output && (pd.output.content || pd.output.text)) || null;
          break;
        }
        if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
      }
    } else if (typeof data.output === 'string') {
      text = data.output;
    } else if (data.output && (data.output.content || data.output.text)) {
      text = data.output.content || data.output.text;
    }

    const raw = (text || '').trim();
    const out = { ok: !/^MISSING:/i.test(raw), missing: raw.replace(/^MISSING:\s*/i, '').slice(0, 160) || '' };
    cache.set(key, out);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    console.error('QA de texto falhou:', e.message);
    return null;
  }
}

// QA de ELEMENTOS: confere se os elementos OBRIGATÓRIOS que o usuário pediu
// (ex: "homem de terno azul", "pasta vermelha", "2 cachorros") APARECERAM na
// imagem gerada. Retorna { ok, missing: [] } ou null (não quebra o fluxo).
// É o coração do "gera → analisa → corrige": a IA só entrega se cumpriu o pedido.
async function checkImageElements(src, elements) {
  try {
    if (!isEnabled() || !process.env.FAL_KEY) return null;
    const list = (Array.isArray(elements) ? elements : []).filter((e) => e && typeof e === 'string' && e.trim());
    if (!list.length) return null;
    const tag = list.map((e) => e.trim().slice(0, 40)).join(' | ');
    let key = src;
    if (src && src.startsWith('data:')) {
      key = 'el:' + crypto.createHash('sha1').update(src.split(',')[1] || '').digest('hex') + '|' + tag;
    } else {
      key = 'el:' + src + '|' + tag;
    }
    if (cache.has(key)) return cache.get(key);

    const compressed = await compress(src, 640, 66);
    if (!compressed) return null;

    const prompt = [
      'You are a strict visual proofreader matching a generated image against the elements the user asked for.',
      `These elements were requested (each one MUST be clearly present in the image): "${tag}".`,
      'Look at the image very carefully. For EACH element, decide if it is present and clearly recognizable (a missing, swapped or wrong-variant element counts as missing).',
      'Reply EXACTLY one of:',
      '"OK" if ALL requested elements are present,',
      'or "MISSING: <each missing element separated by |>" listing ONLY the elements that are missing or wrong.',
      'Ignore style or composition taste. Reply nothing else.'
    ].join(' ');

    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
    const res = await axios.post(
      'https://queue.fal.run/fal-ai/qwen/qwen2.5-vl-7b-instruct',
      { prompt, image_url: compressed, max_tokens: 120 },
      { headers, timeout: 30000, validateStatus: (s) => s < 500 }
    );
    const data = res.data || {};
    let text = null;
    if (data.status_url) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const pollRes = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        if (pd.status === 'COMPLETED' || pd.output) {
          text = typeof pd.output === 'string' ? pd.output : (pd.output && (pd.output.content || pd.output.text)) || null;
          break;
        }
        if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
      }
    } else if (typeof data.output === 'string') {
      text = data.output;
    } else if (data.output && (data.output.content || data.output.text)) {
      text = data.output.content || data.output.text;
    }

    const raw = (text || '').trim();
    const out = {
      ok: !/^MISSING:/i.test(raw),
      missing: raw
        .replace(/^MISSING:\s*/i, '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6)
    };
    cache.set(key, out);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    console.error('QA de elementos falhou:', e.message);
    return null;
  }
}

// "OLHE COMO UM CLIENTE" — segunda análise comercial da imagem: notas de
// Atenção/Clareza/Desejo/Profissionalismo + veredito + sugestão concreta de
// melhoria. Alimenta o "Faça melhor": a IA não regenera aleatório, melhora
// o que está impedindo a imagem de parecer profissional.
async function evaluateAsClient(src) {
  try {
    if (!isEnabled() || !process.env.FAL_KEY) return null;
    let key = src;
    if (src && src.startsWith('data:')) {
      key = 'review:' + crypto.createHash('sha1').update(src.split(',')[1] || '').digest('hex');
    } else {
      key = 'review:' + src;
    }
    if (cache.has(key)) return cache.get(key);

    const compressed = await compress(src, 640, 66);
    if (!compressed) return null;

    const prompt = [
      'You are a demanding customer AND a senior art director analyzing a commercial image.',
      'Score it 0 to 10 on:',
      '- attention (does it stop the scroll? hierarchy and contrast?)',
      '- clarity (is the message/product instantly understandable?)',
      '- desire (does it make the person want the product?)',
      '- professionalism (technical quality and finishing)',
      'Then give a verdict and ONE concrete, actionable improvement in Portuguese.',
      'Reply EXACTLY in this JSON format (no markdown):',
      '{"attention":8,"clarity":7,"desire":9,"professionalism":8,"verdict":"<1 short PT sentence>","suggestion":"<1 short PT sentence, specific fix>"}'
    ].join(' ');

    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
    const res = await axios.post(
      'https://queue.fal.run/fal-ai/qwen/qwen2.5-vl-7b-instruct',
      { prompt, image_url: compressed, max_tokens: 160 },
      { headers, timeout: 30000, validateStatus: (s) => s < 500 }
    );
    const data = res.data || {};
    let text = null;
    if (data.status_url) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const pollRes = await axios.get(data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pollRes.data || {};
        if (pd.status === 'COMPLETED' || pd.output) {
          text = typeof pd.output === 'string' ? pd.output : (pd.output && (pd.output.content || pd.output.text)) || null;
          break;
        }
        if (pd.status === 'ERROR' || pd.status === 'CANCELLED') break;
      }
    } else if (typeof data.output === 'string') {
      text = data.output;
    } else if (data.output && (data.output.content || data.output.text)) {
      text = data.output.content || data.output.text;
    }

    let obj = null;
    try {
      const cleaned = (text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) obj = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      obj = null;
    }
    if (!obj) return null;

    const clamp = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : d;
    };
    const out = {
      attention: clamp(obj.attention, 7),
      clarity: clamp(obj.clarity, 7),
      desire: clamp(obj.desire, 7),
      professionalism: clamp(obj.professionalism, 7),
      verdict: String(obj.verdict || '').trim().slice(0, 160),
      suggestion: String(obj.suggestion || '').trim().slice(0, 200)
    };
    cache.set(key, out);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    console.error('Avaliação como cliente falhou:', e.message);
    return null;
  }
}

module.exports = { describeReference, checkImageQuality, checkImageText, checkImageElements, evaluateAsClient };