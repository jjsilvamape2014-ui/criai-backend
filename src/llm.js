const axios = require('axios');

function getProvider() {
  const key = process.env.LLM_API_KEY || '';
  if (!key) return null;
  // sk- = OpenAI; AIza... e AQ. (novo formato) = Google Gemini
  return key.startsWith('sk-') ? 'openai' : 'gemini';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLM(systemPrompt, userText, opts = {}) {
  const key = process.env.LLM_API_KEY;
  const provider = getProvider();
  if (!key || !provider) return null;

  const defaultModel = provider === 'gemini' ? 'gemini-flash-latest' : 'gpt-4o-mini';
  const model = process.env.LLM_MODEL || defaultModel;
  const maxAttempts = opts.maxAttempts || 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let res;
      if (provider === 'gemini') {
        res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userText}` }] }],
            generationConfig: { temperature: opts.temperature || 0.2, maxOutputTokens: 1024 }
          },
          { timeout: 60000, headers: { 'x-goog-api-key': key } }
        );
        const candidates = res.data && res.data.candidates;
        if (!candidates || !candidates.length) return null;
        const parts = (candidates[0].content && candidates[0].content.parts) || [];
        return parts.map((p) => p.text || '').join('');
      }

      // OpenAI / compatible
      res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText }
          ],
          temperature: opts.temperature || 0.2,
          response_format: { type: 'json_object' }
        },
        { timeout: 60000, headers: { Authorization: `Bearer ${key}` } }
      );
      return (res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content) || null;
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 300)) || e.message;
      const retryable = !status || status >= 500;
      if (!retryable || attempt === maxAttempts) {
        console.error(`LLM falhou (tentativa ${attempt}/${maxAttempts}):`, detail);
        return null;
      }
      console.warn(`LLM sobrecarregado (HTTP ${status}), tentando novamente (${attempt}/${maxAttempts})...`);
      await sleep(2000 * attempt);
    }
  }
  return null;
}

function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function detectAspect(message, prev) {
  if (/16\s*[:/x]\s*9|wide|wideira|widescreen|horizontal|banner|estimulo/.test(message)) return '16:9';
  if (/9\s*[:/x]\s*16|vertical|story|reels/.test(message)) return '9:16';
  if (/quadrado|square|1\s*[:/x]\s*1/.test(message)) return '1:1';
  return prev || null;
}

// Parser heurístico em português/inglês — usado quando não há chave LLM ou em falhas
function parseHeuristic(message, memory, aspect) {
  const msg = (message || '').trim();
  const lower = msg.toLowerCase();

  const reply = `Entendido: ${msg}`;

  // Criar imagem nova do zero
  if (/(criar nova|cria uma nova|nova imagem|do zero|começar do zero|gerar nova|nova cena)/.test(lower)) {
    return {
      reply,
      replace_prompt: true,
      new_prompt: msg.replace(/(criar nova|cria uma nova|nova imagem|do zero|começar do zero|gerar nova|nova cena)\s*[:,-]?\s*/i, '').trim() || msg,
      strength: 0,
      aspect_ratio: aspect
    };
  }

  // Trocar texto na imagem
  const textMatch = lower.match(/texto (?:para|por|dizendo|com|:)\s*(.+)|(?:escrever|escreva|trocar texto)\s*(?:para|com)?\s*(.+)/i);
  if (textMatch) {
    const text = (textMatch[1] || textMatch[2] || '').trim();
    return {
      reply: `Vou ajustar o texto na imagem para "${text}".`,
      prompt_delta: `update the printed/label text to say exactly "${text}", crisp legible typography, correct Portuguese spelling`,
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Trocar cor
  // cor da/do X para Y  |  cor X para Y  |  cor X em Y
  const colorObj = lower.match(/cor\s+(?:da|do|das|dos)?\s*([a-zçãéíóúâêô]+)\s+(?:para|em|de)\s+([a-zçãéíóúâêô]+)/i);
  const colorFrom = lower.match(/(?:cor|pintar)\s+([a-zçãéíóúâêô ]+?)\s+(?:para|em|de)\s+([a-zçãéíóúâêô]+)/i);
  if (/(cor|color|pintar)/.test(lower) && colorObj) {
    return {
      reply: `Vou trocar a cor do(a) ${colorObj[1]} para ${colorObj[2]}.`,
      prompt_delta: `change the color of the ${colorObj[1]} to ${colorObj[2]}, keep the same product and style`,
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }
  if (/(cor|color|pintar)/.test(lower) && colorFrom && colorFrom[1].trim().length < 20 && colorFrom[1].trim().includes(' ')) {
    const subject = colorFrom[1].trim().replace(/\s+/, ' ');
    return {
      reply: `Vou trocar a cor ${subject} para ${colorFrom[2]}.`,
      prompt_delta: `change the ${subject} color to ${colorFrom[2]}, keep the same product and style`,
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }
  if (/(cor|color|pintar)/.test(lower) && colorFrom) {
    return {
      reply: `Vou trocar a cor para ${colorFrom[2]}.`,
      prompt_delta: `change the dominant color to ${colorFrom[2]}, replace previous ${colorFrom[1]} tones`,
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Colocar "logo" no produto — sempre SOMENTE o NOME (como assinatura/wordmark limpo),
  // nunca uma imagem de logo. Se o usuário não disser o nome, pergunta antes (needName).
  if (/(colocar|coloca|inserir|insira|põe|adicionar|adiciona|usar).*(logo|logomarca|marca|assinatura)/.test(lower) || /(logo|logomarca|marca).*(na imagem|na foto|no produto|acima|abaixo|aqui)/.test(lower)) {
    // tenta extrair o nome/marca mencionado pelo usuário (ex: "colocar a logo Criativa AI na imagem")
    const nameRaw = lower.match(/(?:logo|logomarca|marca|assinatura)\s+(?:da\s+)?(?:minha\s+)?(?:empresa\s+|marca\s+)?([a-z0-9à-ú_&.\s-]{2,40})$/i);
    const cleanName = (s) => (s || '')
      .replace(/^(na|no|nas|nos|em|sobre|com|de|da|do|das|dos|aqui|mesma|minha|meu)\s+/i, '')
      .replace(/\s+(na imagem|na foto|no produto|na caneca|na camiseta|aqui|em cima|embaixo|no copo|no saco|na embalagem|no topo|no canto)\.?$/i, '')
      .trim();
    const nameInMsg = cleanName(nameRaw ? nameRaw[1] : null);
    const quoted = msg.match(/["'“”]([^"'“”]{2,30})["'“”]/i);

    if (nameInMsg && nameInMsg.length >= 2 && !/(imagem|foto|produto|caneca|camiseta|copo|saco|embalagem|aqui|topo|canto)/.test(nameInMsg)) {
      return {
        reply: `Vou colocar apenas o nome "${nameInMsg}" na imagem, como assinatura limpa e profissional.`,
        prompt_delta: `superimpose only the text "${nameInMsg}" as a clean minimalist wordmark brand on the product/photo, subtle transparent watermark style, no logo image, no other text`,
        replace_prompt: false,
        strength: 0.55,
        aspect_ratio: aspect
      };
    }
    if (quoted) {
      return {
        reply: `Vou colocar apenas o nome "${quoted[1]}" na imagem, como assinatura limpa e profissional.`,
        prompt_delta: `superimpose only the text "${quoted[1]}" as a clean minimalist wordmark brand on the product/photo, subtle transparent watermark style, no logo image, no other text`,
        replace_prompt: false,
        strength: 0.55,
        aspect_ratio: aspect
      };
    }
    // Não sabemos o nome → pergunta (não gera nem gasta crédito)
    return {
      reply: 'Qual nome ou marca devo colocar na imagem? Ex: "colocar a logo Criativa AI".',
      needName: true,
      aspect_ratio: aspect
    };
  }

  // Remover ruído/textos/nomes indesejados
  if (/(remover|remove|tirar|limpar|limpa).*(ru[íi]do|textos?|nomes?|palavras?|escritas?|legendas?)/.test(lower)) {
    return {
      reply: 'Vou remover o ruído e os textos/nomes indesejados da imagem.',
      prompt_delta: 'remove all noise, unwanted text, names, words, captions, watermarks and artifacts; clean sharp professional result, keep the main subject intact',
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Deixar branco / fundo limpo
  if (/(deixar|ficar|tudo).*(branco)|fundos?\s*branc|background branco/.test(lower) || /white background|make it white/.test(lower)) {
    return {
      reply: 'Vou deixar o fundo/área branco e limpo.',
      prompt_delta: 'clean white background, bright and minimal, remove textures and objects from the background',
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Remover fundo
  if (/(remover|remova|tirar|sem)\s*(o\s*)?fundo/.test(lower) || /remove background/.test(lower)) {
    return {
      reply: 'Vou isolar o produto em fundo branco/limpo.',
      prompt_delta: 'isolate the subject on a plain clean white background, no background scenery',
      replace_prompt: false,
      strength: 0.65,
      aspect_ratio: aspect
    };
  }

  // Excluir pessoas
  if (/(remover|remova|tirar|sem)\s*(a\s*)?pessoas?|sem gente/.test(lower) || /remove (the )?person/.test(lower)) {
    return {
      reply: 'Vou remover a pessoa da imagem.',
      prompt_delta: 'without any people, remove the person, empty scene',
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Negação genérica (sem X)
  const noMatch = lower.match(/sem\s+(o\s+a\s+|os\s+|as\s+)?([a-zçãéíóúâêô]+)/i);
  if (noMatch) {
    return {
      reply: `Vou remover/adicionar o que você pediu (sem ${noMatch[2]}).`,
      prompt_delta: `without ${noMatch[2]}, remove ${noMatch[2]} from the scene`,
      replace_prompt: false,
      strength: 0.6,
      aspect_ratio: aspect
    };
  }

  // Edição/refino genérico
  return {
    reply,
    prompt_delta: msg,
    replace_prompt: false,
    strength: 0.5,
    aspect_ratio: aspect
  };
}

// Interpreta o pedido do usuário -> comando técnico de edição
async function parseEditRequest(message, memory) {
  const aspect = detectAspect(message, (memory && memory.currentPrompt) ? null : null);

  const systemPrompt = [
    'You are a creative image-editing assistant that translates a user request (usually in Portuguese) into a technical instruction.',
    'The user is iterating on an AI-generated image. Return ONLY a JSON object with exactly these fields:',
    '{',
    '  "reply": short confirmation in PORTUGUESE (1 sentence) — never mention the prompt itself, just what was done,',
    '  "prompt_delta": short ENGLISH suffix to append to the image prompt describing the change (keep quoted text if the user asked for specific text),',
    '  "replace_prompt": boolean — true only when the user wants a brand new image from scratch,',
    '  "new_prompt": full ENGLISH image prompt when replace_prompt is true, otherwise ""',
    '  "strength": number 0-1 (0.6 for edits, 0.35 for subtle, 1.0 for brand new),',
    '  "aspect_ratio": "1:1" | "16:9" | "9:16" ("" to keep current),',
    '  "needName": boolean — true ONLY when the user asks to put a brand/logo but did not give a name (then reply asks which name; prompt_delta="")',
    '}',
    'Current image prompt so far: "' + ((memory && memory.currentPrompt) || '') + '"',
    'Rules: never invent unsupported capabilities. When the user asks to add a LOGO/BRAND, ALWAYS render ONLY the name as text — a clean minimalist wordmark/watermark on the product — never an image logo. If no brand name was given, set needName=true and ask for the name instead of inventing one. For background removal keep a clean white background. Always keep the main subject and style unless asked to change them.'
  ].join('\n');

  const llmText = await callLLM(systemPrompt, `User request: ${message}`);
  const parsed = parseJsonLoose(llmText);

  if (parsed && typeof parsed.reply === 'string') {
    if (parsed.needName) {
      return {
        reply: parsed.reply || 'Qual nome ou marca devo colocar na imagem?',
        needName: true,
        aspect_ratio: parsed.aspect_ratio || aspect || null,
        fromLLM: true
      };
    }
    return {
      reply: parsed.reply || 'Feito.',
      prompt_delta: (parsed.prompt_delta || '').trim(),
      replace_prompt: !!parsed.replace_prompt,
      new_prompt: (parsed.new_prompt || '').trim(),
      strength: typeof parsed.strength === 'number' ? Math.min(1, Math.max(0, parsed.strength)) : 0.6,
      aspect_ratio: parsed.aspect_ratio || aspect || null,
      fromLLM: true
    };
  }

  return { ...parseHeuristic(message, memory, aspect), fromLLM: false };
}

module.exports = { parseEditRequest, callLLM, getProvider };