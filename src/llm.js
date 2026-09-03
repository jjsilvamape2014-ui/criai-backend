const axios = require('axios');

// Provedor configurável via LLM_PROVIDER; sem ele, detecta pela chave:
//   sk- = OpenAI; AIza.../AQ. = Gemini; gsk_ = Groq
function getProvider() {
  const key = process.env.LLM_API_KEY || '';
  if (!key) return null;
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-')) return 'openai';
  return 'gemini';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_MODEL = {
  gemini: 'gemini-flash-latest',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct'
};

const BASE_URL = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1'
};

const JSON_MODE_OK = {
  gemini: false,
  openai: true,
  groq: true,
  openrouter: false
};

async function callLLM(systemPrompt, userText, opts = {}) {
  const key = process.env.LLM_API_KEY;
  const provider = getProvider();
  if (!key || !provider) return null;

  const model = process.env.LLM_MODEL || DEFAULT_MODEL[provider] || DEFAULT_MODEL.openai;
  const maxAttempts = opts.maxAttempts || 2;

  // Gemini usa corpo diferente (generateContent)
  if (provider === 'gemini') {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.post(
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
      } catch (e) {
        const status = e.response && e.response.status;
        const detail = (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 300)) || e.message;
        const retryable = !status || status >= 500;
        if (!retryable || attempt === maxAttempts) {
          console.error(`LLM[gemini] falhou (tentativa ${attempt}/${maxAttempts}):`, detail);
          return null;
        }
        console.warn(`LLM[gemini] sobrecarregado (HTTP ${status}), tentando novamente (${attempt}/${maxAttempts})...`);
        await sleep(2000 * attempt);
      }
    }
    return null;
  }

  // OpenAI / Groq / OpenRouter — API OpenAI-compatível
  const base = process.env.LLM_BASE_URL || BASE_URL[provider] || BASE_URL.openai;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (provider === 'openrouter') headers['HTTP-Referer'] = 'https://criativa.ai';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText }
        ],
        temperature: opts.temperature || 0.2,
        max_tokens: opts.maxTokens || 1024
      };
      if (JSON_MODE_OK[provider] && opts.json !== false) payload.response_format = { type: 'json_object' };

      const res = await axios.post(`${base}/chat/completions`, payload, { timeout: opts.timeout || 60000, headers });

      // Groq/OpenRouter erram o trata array melhor: pega a 1ª escolha
      const choice = res.data && res.data.choices && res.data.choices[0];
      const content = choice && choice.message && choice.message.content;
      return content || null;
    } catch (e) {
      const status = e.response && e.response.status;
      const detail = (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 300)) || e.message;
      const retryable = !status || status >= 500;
      // JSON mode no formato correto nem sempre é suportado (400) → tenta sem response_format
      if (status === 400) {
        console.warn(`LLM sem suporte a response_format, tentando sem JSON mode... (${detail})`);
        try {
          const res = await axios.post(`${base}/chat/completions`, {
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }],
            temperature: opts.temperature || 0.2,
            max_tokens: 1024
          }, { timeout: 60000, headers });
          const choice = res.data && res.data.choices && res.data.choices[0];
          return (choice && choice.message && choice.message.content) || null;
        } catch (e2) {
          const s2 = e2.response && e2.response.status;
          const d2 = (e2.response && e2.response.data && JSON.stringify(e2.response.data).slice(0, 300)) || e2.message;
          console.error(`LLM retry-sem-json falhou (tentativa ${attempt}/${maxAttempts}):`, d2);
          if (s2 && s2 < 500) return null;
        }
      }
      if (!retryable || attempt === maxAttempts) {
        console.error(`LLM[${provider}] falhou (tentativa ${attempt}/${maxAttempts}):`, detail);
        return null;
      }
      console.warn(`LLM[${provider}] sobrecarregado (HTTP ${status}), tentando novamente (${attempt}/${maxAttempts})...`);
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

// Interpreta o pedido do usuário -> comando técnico de edição.
// Faz interpretação multi-camada (como o ChatGPT): preservar/remover/substituir,
// identidade da marca, objetivo da peça e hierarquia visual — tudo mantendo a
// memória de projeto entre as versões.
async function parseEditRequest(message, memory) {
  const aspect = detectAspect(message, (memory && memory.currentPrompt) ? null : null);
  const proj = (memory && memory.project) || {};
  const projectContext = [
    `Brand: "${proj.brand || ''}"`,
    `Colors: ${(proj.colors || []).join(', ') || 'none recorded'}`,
    `Style: "${proj.style || ''}"`,
    `Objective: "${proj.objective || ''}"`,
    `Typography: "${proj.typography || ''}"`,
    `Constraints: ${(proj.constraints || []).join('; ') || 'none recorded'}`
  ].join('\n');

  const systemPrompt = [
    'You are a world-class creative art director and image editor, like ChatGPT\'s image feature.',
    'The user is building a visual piece ITERATIVELY (marketing/post/logo/banner). They send references and corrections over many messages. You must interpret the full request — not just copy it — separating preserve / remove / replace / add, respecting brand identity, colors, objective and hierarchy.',
    '',
    'KNOWN PROJECT CONTEXT (persist these, they were decided in earlier messages):',
    projectContext,
    '',
    'Return ONLY a JSON object with EXACTLY these fields:',
    '{',
    '  "reply": short confirmation in PORTUGUESE (1 sentence), tells the user what was done, never mentions the prompt,',
    '  "prompt_delta": ENGLISH suffix describing the visual change to append to the full image prompt. Combine multiple simultaneous changes into ONE coherent sentence (e.g. remove texts, apply brand colors, keep the truck).',
    '  "replace_prompt": boolean — true when the user wants a brand new image/scene from scratch (respect the recorded brand/colors/style),',
    '  "new_prompt": full ENGLISH image prompt when replace_prompt is true, otherwise ""',
    '  "strength": number 0-1 (edits 0.6, subtle 0.35, brand new 1.0),',
    '  "aspect_ratio": "1:1" | "16:9" | "9:16" ("" keep current),',
    '  "needName": boolean — true ONLY when the user asks for a brand/logo but gave no name (then reply asks the name, prompt_delta="")',
    '  "ask": array of 1-2 short questions in PORTUGUESE ("..."), or [] — when TRUE essential information is missing to do a GREAT job and only 1 question unblocks the whole request.',
    '}',
    '',
    'Use "ask" sparingly and ONLY when an essential, single piece of info is missing and would clearly change the result (e.g. creating a brand-new piece: "qual é o nome/marca da empresa?", "qual o objetivo: post p/ Instagram, banner, logo, anúncio?", "deseja incluir algum texto?"). IMPORANT: when the user has attached a reference IMAGE to edit, this is an EDIT — never ask, just do the edit (ask: []). If the request is editable with what we have, ask: []. Never ask more than once for the same field (check KNOWN PROJECT CONTEXT and recent replies against it). If the user says "não sei", "tanto faz", "você escolhe", or keeps it open, do NOT ask — proceed.',
    '',
    'Rules:',
    '- Combine all instructions in the user message into a single, coherent, non-contradictory prompt_delta. If the user says "troca o caminhão mas mantém o caminhão", interpret intent: replace the specific truck with another similar one, keep the composition.',
    '- TEXT in the image: when the user asks to write text (name, phrase, number, MPa unit, phone), ALWAYS put it as literal text in quotes (ex: "XYZ TECNOLOGIA EM CONCRETO") and specify exact spelling, capitalization and accentuation. Preserve facts like "20 MPa" exactly.',
    '- LOGO/BRAND: render ONLY the name as clean minimalist wordmark on the piece (never an image logo). If no name given, ask for it.',
    '- Keep the main subject, style and brand colors unless the user asks to change them.',
    '- Never invent capabilities. Photorealistic/commercial quality for marketing pieces.'
  ].join('\n');

  const hasRef = !!(memory && memory.refImages && memory.refImages.length > 0);
  const userBlock = [
    `User request: ${message}`,
    hasRef ? 'A REFERENCE IMAGE(s) IS ATTACHED for editing — treat this as an EDIT of that image (e.g. add a hat), NOT a new image. Do not ask questions, do the edit.' : '',
    memory && memory.currentPrompt ? `Current full prompt so far: "${memory.currentPrompt}"` : '',
    memory && memory.collecting
      ? `ALREADY ASKED these questions (do not ask again): ${JSON.stringify(memory.pending && memory.pending.ask ? memory.pending.ask : memory.collecting)}`
      : '',
    'Previous edits in this session: ' + JSON.stringify((memory && memory.edits ? memory.edits.slice(-4) : []).map((e) => ({ command: e.message })))
  ].filter(Boolean).join('\n');

  const llmText = await callLLM(systemPrompt, userBlock, { temperature: 0.5, maxTokens: 900 });
  const parsed = parseJsonLoose(llmText);

  if (parsed && typeof parsed.reply === 'string') {
    if (parsed.needName) {
      return {
        reply: parsed.reply || 'Qual nome ou marca devo colocar na imagem?',
        needName: true,
        aspect_ratio: parsed.aspect_ratio || aspect || null,
        projectUpdate: extractProjectUpdate(message),
        fromLLM: true
      };
    }
    // Pergunta(s) essencial(is) para gerar bem → bloco e não gera até responder
    const asks = Array.isArray(parsed.ask) ? parsed.ask.filter((q) => typeof q === 'string' && q.trim()).slice(0, 2) : [];
    if (asks.length > 0 && !(memory && memory.collecting)) {
      return {
        reply: asks.join('\n'),
        ask: asks,
        replace_prompt: !!parsed.replace_prompt,
        aspect_ratio: parsed.aspect_ratio || aspect || null,
        projectUpdate: extractProjectUpdate(message),
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
      projectUpdate: extractProjectUpdate(message),
      fromLLM: true
    };
  }

  // Fallback heurístico: se é pra criar uma peça nova do zero mas faltam dados
  // essenciais e o usuário não está respondendo a uma pergunta anterior, pergunte.
  const isNewPiece = /(criar|cria|crie|fazer|faça|faca|gera|gere|montar|desenhar)\s+.*(banner|logo|logomarca|post|anúncio|anuncio|capa|cartaz|cartão|cartao|flyer|folheto|folder|panfleto|pôster|poster)/i.test(message);
  const projMiss = (memory && memory.project) || {};
  const missingNew = [];
  if (!projMiss.brand && /logo|logomarca|marca/.test(message)) missingNew.push('Qual é o nome/marca da empresa?');
  if (!projMiss.objective) missingNew.push('Qual o objetivo desta peça (post p/ Instagram, banner de site, anúncio, capa...)?');
  if (!projMiss.colors || !projMiss.colors.length) missingNew.push('Quais cores devo usar (cores da sua marca)?');
  if (missingNew.length && isNewPiece && !hasRef && !(memory && memory.collecting)) {
    return {
      reply: missingNew.slice(0, 2).join('\n'),
      ask: missingNew.slice(0, 2),
      replace_prompt: true,
      aspect_ratio: aspect,
      fromLLM: false
    };
  }

  return { ...parseHeuristic(message, memory, aspect), projectUpdate: extractProjectUpdate(message), fromLLM: false };
}

// Extrai rapidamente fato(s) de identidade visual da mensagem para atualizar a
// memória de projeto (marca, cores, estilo, objetivo, restrições). Heurística leve
// complementar ao LLM — não remove informação, apenas adiciona o que reconhecer.
function extractProjectUpdate(message) {
  const m = (message || '').toLowerCase();
  const proj = {};

  // Pré-limpa frases que introduzem o nome da marca para capturar o nome real
  // (ex: "a empresa se chama XYZ" -> "XYZ"; "chama-se XYZ" -> "XYZ")
  const wasNameReply = /(?:se chama|chama-se|chama|chamo-me|me chamo|se chamar|nome da empresa|o nome é)\b/.test(m);
  const cleanMsg = m
    .replace(/(?:a |o )?empresa (?:se chama|chama-se|chama|é|e a|e)/g, ' ')
    .replace(/(?:se chama|chama-se|chama|chamo-me|me chamo|se chamar)/g, ' ')
    .replace(/\s+/g, ' ').trim();

  let brand = cleanMsg.match(/(?:marca|logo|assinatura|empresa|nome da marca)\s+(?:da\s+|do\s+|d[ao]s?\s+|é\s+|e\s+)?["']?([a-z0-9à-úçãéíóúâêô &_.-]{2,40})/i);
  // Resposta direta a pergunta de marca: o texto limpo começa com o nome
  if (!brand && wasNameReply) {
    const lead = cleanMsg.match(/^["']?([a-z0-9à-úçãéíóúâêô &_.-]{2,40})/i);
    if (lead) brand = [null, lead[1]];
  }
  if (brand && brand[1] && !/(imagem|foto|produto|caneca|camiseta|aqui|topo|canto|marca d)/.test(brand[1])) {
    let name = brand[1].trim().replace(/[.,;"']+$/g, '');
    name = name.split(/\s+(?:em|com|para|no|na|nos|nas|de|da|do|das|dos|por|que|ou|e\s)/i)[0].trim();
    if (name.length >= 2) proj.brand = name;
  }

  const colorMap = { azul: 'azul', vermelho: 'vermelho', cinza: 'cinza', preto: 'preto', branco: 'branco', amarelo: 'amarelo', verde: 'verde', roxo: 'roxo', laranja: 'laranja', rosa: 'rosa', dourado: 'dourado', prata: 'prata', marrom: 'marrom', lilás: 'lilás' };
  const visto = new Set((proj.colors || []));
  for (const [pt, en] of Object.entries(colorMap)) {
    if (new RegExp(pt).test(m)) visto.add(en);
  }
  if (visto.size) proj.colors = [...visto];

  if (/(profissional|institucional|executivo|clean|moderno|minimalista|industrial|tecnológico|tecnologica)/.test(m)) {
    proj.style = m.match(/(profissional|institucional|executivo|clean|moderno|minimalista|industrial|tecnológico|tecnologica)/)?.[0] || proj.style || '';
  }

  const obj = m.match(/(?:para|post de|banner de|anúncio de|material de|peça de|conteúdo de)\s+(linkedin|instagram|facebook|site|recrutamento|vendas|divulgação|campanha|imprensa|comercial|e-mail|whatsapp|impressão)/i);
  if (obj) proj.objective = obj[1].toLowerCase();

  return Object.keys(proj).length ? proj : null;
}

// Reescreve o pedido do usuário em um prompt profissional de imagem em inglês,
// estilo ChatGPT: expande pedidos vagos/absurdos em cena -> sujeito -> estilo ->
// iluminação -> composição -> restrições. Retorna o prompt enriquecido + uma
// breve confirmação em PT. Nunca quebra (fallback: prompt original + toques).
async function enhanceImagePrompt(rawPrompt, opts = {}) {
  const trimmed = (rawPrompt || '').trim();
  if (!trimmed || trimmed.length < 3) return { prompt: trimmed, reply: '' };

  const proj = (opts.project || {});
  const projectLines = [
    proj.brand ? `Brand/company: ${proj.brand}` : '',
    (proj.colors && proj.colors.length) ? `Brand colors (use these): ${proj.colors.join(', ')}` : '',
    proj.style ? `Visual style: ${proj.style}` : '',
    proj.objective ? `Piece purpose: ${proj.objective}` : '',
    (proj.constraints && proj.constraints.length) ? `Constraints: ${proj.constraints.join('; ')}` : ''
  ].filter(Boolean).join(' | ');

  const systemPrompt = [
    'You are a world-class prompt engineer for AI image generation (FLUX).',
    'The user describes in Portuguese (or English) what image they want — prompts can be vague, absurd or creative.',
    projectLines ? 'KNOWN PROJECT IDENTITY (respect these unless contradicted by the user): ' + projectLines : '',
    'Rewrite it into ONE detailed English image prompt, exactly as ChatGPT would before rendering:',
    '- structure: scene/background -> main subject (specific, with details) -> style/medium -> lighting -> composition/framing -> mood',
    '- make it explicit and concrete (materials, textures, colors, camera angle, depth of field)',
    '- keep the absurd/creative request alive (the user WANTS what they asked, even if wild) — do not censor, do not tone it down',
    '- if it is a product/logo/banner request, aim for professional commercial quality (studio lighting, clean background)',
    '- keep quoted text (“...” or \"...\") that the user wants printed in the image, verbatim, in quotes',
    '- end with hard constraints: no text, no watermark, no letters (unless the user asked for text)',
    'Rules: NEVER add “photorealistic, 8k, masterpiece, trending” spam. 2-5 sentences max. No explanations.',
    'Then, on the next line after a separator “###CONF:” append a 1-sentence friendly confirmation in PORTUGUESE telling the user what was generated (never mention the prompt).',
    'Format: <english prompt>\\n###CONF:<portuguese confirmation>'
  ].filter(Boolean).join('\n');

  const llmText = await callLLM(systemPrompt, `User request: ${trimmed}`, {
    temperature: 0.7,
    maxTokens: 600,
    maxAttempts: 1,
    timeout: 45000,
    json: false
  });

  if (llmText && llmText.trim()) {
    // Resposta pode vir com fenced code ou texto extra; extrai a última linha "###CONF:"
    const cleaned = llmText.replace(/```/g, '').trim();
    const confMatch = cleaned.match(/###CONF:\s*([\s\S]+)$/);
    const prompt = confMatch ? cleaned.slice(0, confMatch.index).trim() : cleaned;
    const reply = (confMatch && confMatch[1].trim()) || '';
    if (prompt) return { prompt, reply, fromLLM: true };
  }

  // Fallback sem LLM: usa o otimizador leve por intenção (mantém o pedido do usuário)
  return { prompt: optimizeFallback(trimmed), reply: '', fromLLM: false };
}

// Otimizador leve sem LLM (fallback): adiciona toques técnicos por intenção.
function optimizeFallback(rawPrompt) {
  const p = rawPrompt.toLowerCase();
  let enhancement = '';
  if (/(produto|product|loja|ecommerce|vender|catálogo|celular|camiseta|caneca|garrafa|bolsa|tênis)/.test(p)) {
    enhancement = ', professional product photography, studio lighting, clean background, commercial quality, high-end e-commerce imagery';
  } else if (/(realist|foto|camera|paisagem|retrato|cachorro|pessoa|natureza|praia|carro)/.test(p)) {
    enhancement = ', ultra realistic photograph, natural lighting, sharp focus, professional photography';
  } else if (/(desenho|ilustra|cartoon|anime|pixel|arte|fantasia)/.test(p)) {
    enhancement = ', detailed digital illustration, vibrant colors, high detail';
  } else {
    enhancement = ', high quality, detailed, visually striking';
  }
  const hasQuoted = /"[^"]+"/.test(rawPrompt) || /(escrever|texto dizendo|com o texto|dizer|palavras?)/.test(p);
  const noText = hasQuoted ? '' : ', no text, no watermark, no letters, no words';
  return `${rawPrompt}${enhancement}${noText}`;
}

// Responde uma mensagem puramente conversacional (dúvida, pergunta geral, bate-papo)
// sem gerar imagem nem gastar crédito — o agente "conversa" como o ChatGPT.
async function replyConversation(message, memory) {
  const sys = [
    'You are the conversational assistant of "Criativa AI", an image/video creation platform (like ChatGPT).',
    'You also help users design marketing pieces. Be friendly, concise, in PORTUGUESE (pt-BR).',
    'If the user asks something you cannot do, say so honestly and offer what you CAN do.',
    'Answer the user\'s question directly. Keep it short (2-5 sentences) unless they ask for details.',
    'When relevant, mention you can create/edit images and videos by describing what you want.'
  ].join('\n');
  try {
    const text = await callLLM(sys, `User: ${message}`, { temperature: 0.6, maxTokens: 500 });
    if (text && text.trim()) return text.trim();
  } catch (e) {
    console.error('replyConversation falhou:', e.message);
  }
  return null;
}

// Classifica a intenção do pedido do usuário para o agente decidir a ação:
//   "conversation" (só conversa/dúvida), "create" (gerar do zero),
//   "edit" (editar imagem anexada), "video" (gerar vídeo), "logo" (nome/marca)
function detectIntent(message, memory) {
  const m = (message || '').toLowerCase();
  const hasRef = !!(memory && memory.refImages && memory.refImages.length > 0);

  if (/\b(v[íi]deo|anima[çc][ãa]o|anima\w*|transforma?\s*em\s*(v[íi]deo|anima)|tour\s*360|360\s*graus|imagem\s*em\s*movimento|movimenta\w*)\b/.test(m)) {
    return 'video';
  }
  if (/(quem é você|quem e voce|você existe|você é uma|o que é|como funciona|me explica|explica|pra que serve|para que serve|obrigad|tudo bem|bom dia|boa tarde|boa noite|oi|ola|olá|como você (está|ta)|pode me ajudar|ajuda|você consegue fazer|você sabe|não sei|tanto faz|muito obrigad)/.test(m) && !hasRef) {
    return 'conversation';
  }
  // Edição quando há imagem anexada e o pedido altera a imagem (não cria do zero)
  if (hasRef) {
    const createFromScratch = /(criar|cria|crie|fazer|faça|faca|gera|gere|montar|desenhar)\s+(uma|um|outra)\s+(nova\s+)?(\s*(imagem|arte|peça|peca|banner|logo|post|vídeo|video|capa))/.test(m);
    if (!createFromScratch) return 'edit';
  }
  return 'create';
}

module.exports = { parseEditRequest, callLLM, getProvider, enhanceImagePrompt, replyConversation, detectIntent };