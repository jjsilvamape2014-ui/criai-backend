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
    'You are a world-class creative art director and image editor, like a top-tier AI image editor.',
    'The user is building a visual piece ITERATIVELY (marketing/post/logo/banner). They send references and corrections over many messages. You must interpret the full request — not just copy it — separating preserve / remove / replace / add, respecting brand identity, colors, objective and hierarchy.',
    '',
    'KNOWN PROJECT CONTEXT (persist these, they were decided in earlier messages):',
    projectContext,
    '',
    'FACTS of the piece the user already mentioned in this conversation (keep them in every prompt unless the user changes them):',
    (proj.facts && proj.facts.length ? proj.facts.map((f) => `${f.key}: ${f.value}`).join('\n') : '(none yet)'),
    '',
    'WHAT THE ATTACHED REFERENCE IMAGE(s) SHOW (from automatic vision — trust this as ground truth):',
    Array.isArray(memory && memory.refDescriptions) && memory.refDescriptions.length
      ? memory.refDescriptions.map((d, i) => `ref${i + 1}: ${d.caption}`).join('\n')
      : '(none described)',
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
    '  "facts": array of {key, value} — facts about the piece to remember across the conversation (price, phone, slogan, address, product, date). Use keys: brand, price, phone, slogan, address, product, text, offer, date, audience. [] if nothing durable.',
    '}',
    '',
    'IMPORTANT about "facts": when the user mentions a price, phone, slogan/name, address, product or offer — even inside an edit — capture it here so it persists into future versions.',
    'Use "ask" sparingly and ONLY when an essential, single piece of info is missing and would clearly change the result (e.g. creating a brand-new piece: "qual é o nome/marca da empresa?", "qual o objetivo: post p/ Instagram, banner, logo, anúncio?", "deseja incluir algum texto?"). IMPORANT: when the user has attached a reference IMAGE to edit, this is an EDIT — never ask, just do the edit (ask: []). If the request is editable with what we have, ask: []. Never ask more than once for the same field (check KNOWN PROJECT CONTEXT and recent replies against it). If the user says "não sei", "tanto faz", "você escolhe", or keeps it open, do NOT ask — proceed. If you have to ask, ask ONE question at a time.',
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
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.filter((f) => f && f.key && f.value).slice(0, 6)
      : [];
    if (parsed.needName) {
      return {
        reply: parsed.reply || 'Qual nome ou marca devo colocar na imagem?',
        needName: true,
        aspect_ratio: parsed.aspect_ratio || aspect || null,
        projectUpdate: extractProjectUpdate(message),
        facts,
        fromLLM: true
      };
    }
    // Pergunta(s) essencial(is) para gerar bem → bloco e não gera até responder
    const asks = Array.isArray(parsed.ask) ? parsed.ask.filter((q) => typeof q === 'string' && q.trim()).slice(0, 1) : [];
    if (asks.length > 0 && !(memory && memory.collecting)) {
      return {
        reply: asks.join('\n'),
        ask: asks,
        replace_prompt: !!parsed.replace_prompt,
        aspect_ratio: parsed.aspect_ratio || aspect || null,
        projectUpdate: extractProjectUpdate(message),
        facts,
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
      facts,
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

// Extrai os TEXTOS que o usuário quer impressos na imagem (aspas, idades, preços
// e nomes próprios) — usados para (a) reforçar no prompt e (b) conferir na QA.
function extractTextTokens(raw) {
  const out = new Set();
  const s = String(raw || '');
  // Aspas explícitas: "Joan Ravi", “5 anos”
  (s.match(/["""]([^""""]{2,40})["""]/g) || []).forEach((q) => out.add(q.replace(/["""]/g, '').trim().slice(0, 40)));
  // Números com unidade / valores: "5 anos", "R$ 12,90", "50%"
  const num = s.match(/\b\d+\s*(anos?|meses?|dias?|horas?|%|\b)/gi) || [];
  num.forEach((n) => n.trim() && out.add(n.trim()));
  const money = s.match(/R\$\s*[\d.,]+\s*/gi) || [];
  money.forEach((m) => out.add(m.trim()));
  // Nomes próprios (2+ palavras capitalizadas) — só quando o pedido já é textual
  // (convite/aniversário/logo/aspas/número), para não capturar frases comuns.
  const textual = /[""“”]/.test(s) || /\b\d+\s*(anos|meses)\b|\bR\$\s*\d/i.test(s) || /(convite|anivers[áa]rio|invitation|birthday|logo|lembranc[aa]|cart[ãa]o)/i.test(s);
  if (textual) {
    const skip = /^(Convite|Preciso|Quero|Gostaria|Queria|Gostava|Fizer|Faz|Cri|Estou|Eu|Ola|Ol[áa]|Oi|O|A|Para|Por favor|Minha|Minha|Nossa|Esse|Essa|Este|Esta|Uma|Um|Como|Quais|Quantos)\b/i;
    (s.match(/\b([A-ZÀ-Ú][a-zà-úçãõéíóúâêô]{1,}(?:\s+[A-ZÀ-Ú][a-zà-úçãõéíóúâêô]{1,}){0,3})\b/g) || []).forEach((c) => {
      const clean = (c || '').trim();
      if (clean.split(/\s+/).length >= 2 && !skip.test(clean) && clean.length <= 40) out.add(clean);
    });
  }
  return [...out].filter(Boolean).slice(0, 5);
}

// Garante que os textos extraídos estejam presentes no prompt EN (senão, anexa
// a instrução de imprimir exatamente aquele texto na imagem).
function ensureRequiredText(enPrompt, rawPrompt) {
  let out = String(enPrompt || '');
  for (const tok of extractTextTokens(rawPrompt)) {
    if (tok.length < 2) continue;
    if (!RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(out)) {
      out += ` Include the exact printed text "${tok}" clearly visible in the image, spelled correctly.`;
    }
  }
  return out;
}

// Reescreve o pedido do usuário em um prompt profissional de imagem em inglês,
// estilo ChatGPT: expande pedidos vagos/absurdos em cena -> sujeito -> estilo ->
// iluminação -> composição -> restrições. Retorna o prompt enriquecido + uma
// breve confirmação em PT. Nunca quebra (fallback: prompt original + toques).
// Conhecimento de marketing de eventos/peças: o Cérebro NÃO depende do usuário
// explicar o que é cada peça — reconhece o tipo e aplica convenções certas.
function marketingKnowledge(raw) {
  const r = String(raw || '');
  const hints = [];
  if (/(arraial|festa junina|junina|s[ãa]o jo[ãa]o|festa caipira|bandeirinha|pamonha|canjica|milho verde)/i.test(r)) {
    hints.push('Brazilian "arraial / Festa Junina / São João" = a COUNTRY PARTY: colorful pennant flags, chita patchwork fabric, hay bales, corn, bonfire, sky lanterns, checkered tablecloths. It is NOT a beach or sand scene.');
  }
  if (/(convite|invitation)/i.test(r)) {
    hints.push('Invitation (convite): elegant, readable layout — the HONOREE NAME, the age/anniversary number and the date MUST be prominent printed text.');
  }
  if (/(anivers[áa]rio|birthday)/i.test(r)) {
    hints.push('Birthday piece: festive and celebratory; honor the name + age in big, clear letters.');
  }
  if (/(banner)/i.test(r)) {
    hints.push('Banner = wide/horizontal promotional graphic with a BIG short headline and strong call-to-action; readable at a distance.');
  }
  if (/(flyer|panfleto|folder|folheto)/i.test(r)) {
    hints.push('Flyer = compact one-page promotion: headline, key info, offer/price and contact, with clean visual hierarchy.');
  }
  if (/(logo|logomarca|marca)/i.test(r)) {
    hints.push('Logo: minimal wordmark or emblem, strong silhouette, professional, printable.');
  }
  if (/(faculdade|escola|curso|universidade|vestibular|matr[cí]cula|est[áa]cio|ensino)/i.test(r)) {
    hints.push('Education marketing: trustworthy and aspirational look, clear offer/CTA (matrícula, vestibular, bolsa).');
  }
  if (/(hamburgueria|hamb[uú]rguer|burger|lanche|combo|fast[- ]?food)/i.test(r)) {
    hints.push('Hamburgueria/promo: appetizing food photography (steam, melting cheese, fresh bun, close-up), warm appetizing palette (red/yellow/orange), bold price or offer ("R$ XX,90", combo), strong CTA (peça pelo WhatsApp).');
  }
  if (/(pizzaria|pizza)/i.test(r)) {
    hints.push('Pizzaria: hero shot of pizza in foreground — melted cheese pull, wood-fired crust, toppings — warm inviting light, rustic Italian mood (red/wood tones), price/offer highlighted, delivery CTA.');
  }
  if (/(restaurante|restaurant|self[- ]?service|buffet|almo[çc]o|jantar|menu|card[áa]pio)/i.test(r)) {
    hints.push('Restaurante: appetizing professional food photography, warm light, dish as the hero, clean layout, clear offer/price emphasis, inviting mood.');
  }
  if (/(promo[çc][ãa]o|promo|black friday|desconto|oferta|sale|cupom|imperd[ií]vel)/i.test(r)) {
    hints.push('Promoção: the OFFER is the hero — big discount %, price clearly printed, urgency tone, bold colors, coupon/CTA. Only include additional texts the user asked for.');
  }
  if (/(candidato|candidata|prefeito|vereador|deputad[ao]|senador|elei[çc][ãa]o|santinho|campanha pol|campanha eleitoral|card pol|voto|urna|cumprindo|realiza[çc][ãa]o)/i.test(r)) {
    hints.push('Election campaign card/flyer ("santinho" de candidato): official Brazilian campaign aesthetic — the CANDIDATE PHOTO (from the reference photo, keep the face identical) is the hero; the NAME printed as on the ballot; the candidate NUMBER as very large, exact text ("Nº " or just the digits, exactly as provided, never invent or change digits); position (PREFEITO/VEREADOR etc.), city and year 2026 printed; strong institutional campaign colors (blue, red or green with white) on a clean bold vertical layout; all printed text must be correctly spelled and legally standard (no gibberish, no invented numbers).');
  }
  return hints.length ? '\nDOMAIN KNOWLEDGE (follow it strictly):\n- ' + hints.join('\n- ') : '';
}

// Cérebro em etapas — REGRA CENTRAL do produto: "antes de gerar, entenda
// exatamente o que o usuário quer; não invente elementos importantes não
// solicitados e nunca quebre o que foi pedido." Separa o pedido em
// OBRIGATÓRIO (deve aparecer) / NÃO ALTERAR (valores que não mudam) /
// PODE INTERPRETAR (detalhes abertos) / ESTILO. Retorna só o plano JSON
// (ou null se o LLM falhar — o fluxo segue pelo caminho antigo).
async function interpretImageRequest(raw, opts = {}) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed.length < 3) return null;

  const systemPrompt = [
    'You are the planning brain of an AI image studio.',
    'Separate the user request into valid JSON with EXACTLY these keys:',
    '{"obrigatorio":["..."],"nao_alterar":["..."],"pode_interpretar":["..."],"estilo":""}',
    'REGRA CENTRAL: never invent important elements the user did not ask for, and never drop or dilute what they did ask.',
    'obrigatorio: every explicit, concrete demand — person, gender, quantity, color, clothing, object, place, printed word/price, layout. Each as a short concrete phrase. Keep quantities EXACT ("2 celulares" is NOT "celulares"; "azul na mão esquerda" is NOT "um celular").',
    'nao_alterar: restate the exact must-keep values used in obrigatorio (e.g. "vestido vermelho", "cabelo preto", "2 celulares", "azul na esquerda") so the prompt can forbid changing them.',
    'pode_interpretar: ONLY reasonable open details NOT specified by the user (apparent age, decor, lighting, camera angle) — max 3, and never one that contradicts an explicit obrigatorio choice.',
    'estilo: the user-stated style only (realistic/photo, illustration, cartoon, minimal, logo, cinema...) or "" if unstated.',
    'Never invent elements that alter the intent. Reply valid JSON only, no explanations.'
  ].join('\n');

  const llmText = await callLLM(systemPrompt, `User request: ${trimmed}`, {
    temperature: 0.2,
    maxTokens: 500,
    maxAttempts: 1,
    timeout: 40000,
    json: true
  });
  if (!llmText || !llmText.trim()) return null;
  try {
    const obj = parseJsonLoose(llmText);
    if (!obj || typeof obj !== 'object') return null;
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'string' && x.trim().length > 1).map((x) => x.trim()) : []);
    return {
      obrigatorio: arr(obj.obrigatorio).slice(0, 8),
      nao_alterar: arr(obj.nao_alterar).slice(0, 10),
      pode_interpretar: arr(obj.pode_interpretar).slice(0, 3),
      estilo: typeof obj.estilo === 'string' ? obj.estilo.trim() : ''
    };
  } catch (e) {
    return null;
  }
}

async function enhanceImagePrompt(rawPrompt, opts = {}) {
  const trimmed = (rawPrompt || '').trim();
  if (!trimmed || trimmed.length < 3) return { prompt: trimmed, reply: '', required: { elements: [], texts: [] } };

  const proj = (opts.project || {});
  const projectLines = [
    proj.brand ? `Brand/company: ${proj.brand}` : '',
    (proj.colors && proj.colors.length) ? `Brand colors (use these): ${proj.colors.join(', ')}` : '',
    proj.style ? `Visual style: ${proj.style}` : '',
    proj.objective ? `Piece purpose: ${proj.objective}` : '',
    (proj.constraints && proj.constraints.length) ? `Constraints: ${proj.constraints.join('; ')}` : ''
  ].filter(Boolean).join(' | ');

  const domain = marketingKnowledge(trimmed);
  const required = { elements: [], texts: extractTextTokens(trimmed) };

  // Etapa 1 — PLANEJAR (cérebro em etapas)
  const plano = await interpretImageRequest(trimmed, opts);
  if (plano && (plano.obrigatorio.length || plano.nao_alterar.length)) {
    required.elements = plano.obrigatorio;

    // Etapa 2 — RENDERIZAR a partir do plano (o pedido original + categorias)
    const systemPrompt = [
      'You are a world-class render engineer for AI image generation (FLUX / Ideogram).',
      'Render ONE detailed English image prompt using: (a) the user\'s original request and (b) the structured plan below. The original request wins in any conflict.',
      projectLines ? 'KNOWN PROJECT IDENTITY (respect these unless contradicted by the user): ' + projectLines : '',
      'PLAN:',
      '- OBRIGATÓRIO (each MUST clearly appear exactly as stated — hero of the image, no substitutes, same quantities):',
      '  ' + (plano.obrigatorio.length ? plano.obrigatorio.join(' | ') : '(none)'),
      '- NÃO ALTERAR (values that MUST NOT change in the render):',
      '  ' + (plano.nao_alterar.length ? plano.nao_alterar.join(' | ') : '(none)'),
      '- PODE INTERPRETAR (only these open details may be freely completed — nothing else):',
      '  ' + (plano.pode_interpretar.length ? plano.pode_interpretar.join(' | ') : 'nothing extra; render only what the user said'),
      plano.estilo ? `- ESTILO EXPLÍCITO DO USUÁRIO (keep it, do not blend): ${plano.estilo}` : '- ESTILO: keep whatever the user implied; never force realism onto an illustration request or vice-versa.',
      domain,
      (opts.textSwap ? '- THIS IS A TEXT REPLACEMENT ON AN EXISTING REFERENCE DESIGN: keep the icon/emblem, colors, materials, panel, LED border, background and layout 100% IDENTICAL. Change ONLY the written text exactly as requested (match the requested text style, e.g. engraved/hollow/vazado). Do not redesign, do not move or replace the emblem, do not change the background.' : ''),
      'STRUCTURE: scene/background -> main subject (specific) -> style/medium -> lighting -> composition/framing -> mood. Make it explicit (materials, textures, colors, camera angle, depth of field).',
      'TEXT: if printed text was asked (promo/convite/logo/name/price), every string must appear verbatim with exact accents (ex: Promoção, já, não).',
      'End with constraints: no watermark, no gibberish letters, no unrelated text (unless printed text was asked).',
      'Never add “photorealistic, 8k, masterpiece, trending” spam. 2-5 sentences.',
      'Then, after a separator “###CONF:” append a 1-sentence friendly confirmation in PORTUGUESE telling the user what was generated (never mention the prompt).',
      'Format: <english prompt>\\n###CONF:<portuguese confirmation>'
    ].filter(Boolean).join('\n');

    const llmText = await callLLM(systemPrompt, `User request: ${trimmed}`, {
      temperature: 0.4,
      maxTokens: 700,
      maxAttempts: 1,
      timeout: 45000,
      json: false
    });

    let prompt = '';
    let reply = '';
    if (llmText && llmText.trim()) {
      const cleaned = llmText.replace(/```/g, '').trim();
      const confMatch = cleaned.match(/###CONF:\s*([\s\S]+)$/);
      prompt = confMatch ? cleaned.slice(0, confMatch.index).trim() : cleaned;
      reply = (confMatch && confMatch[1].trim()) || '';
    }
    if (!prompt) {
      // Fallback de renderização SEM LLM: monta o prompt direto do plano.
      prompt = [
        `${plano.obrigatorio.join('; ') || trimmed}.`,
        plano.estilo ? `Style: ${plano.estilo}.` : '',
        plano.pode_interpretar.length ? `Feel free to add tasteful detail (${plano.pode_interpretar.join(', ')}).` : ''
      ].filter(Boolean).join(' ');
    }

    if (prompt) {
      prompt = ensureRequiredText(prompt, trimmed);
      return { prompt, reply, required, fromLLM: true };
    }
  }

  // Sem plano estruturado (pedido vago ou LLM indisponível): caminho antigo, one-shot.
  const systemPrompt = [
    'You are a world-class prompt engineer for AI image generation (FLUX / Ideogram).',
    'The user describes in Portuguese (or English) what image they want — prompts can be vague, absurd or creative.',
    projectLines ? 'KNOWN PROJECT IDENTITY (respect these unless contradicted by the user): ' + projectLines : '',
    'Rewrite it into ONE detailed English image prompt, exactly as a top-tier AI studio would before rendering.',
    'STRICT FIDELITY RULES (non-negotiable):',
    '- The user\'s request is LAW. NEVER change, swap, drop or "improve" the subject, scene, action, style, colors or mood they asked. You only ADD professional rendering detail — you never contradict the request.',
    '- If the user asks for a specific thing (product, person, animal, place, word, price, color, layout), that thing MUST be the hero of the image. Do not replace it with a generic substitute.',
    '- If the user asks for a photo/realistic look, keep it realistic; if they ask for illustration/cartoon, keep that style. Never blend into something different.',
    '- structure: scene/background -> main subject (specific, with details) -> style/medium -> lighting -> composition/framing -> mood',
    '- make it explicit and concrete (materials, textures, colors, camera angle, depth of field)',
    '- keep the absurd/creative request alive (the user WANTS what they asked, even if wild) — do not censor, do not tone it down',
    '- if it is a product/logo/banner/flyer/invitation request, aim for professional quality (clean layout, high contrast, readable text)',
    '- TEXT: whenever the user wants printed text (name, age, price, convite, banner, flyer, logo, slogan, words), the text MUST appear clearly, correctly spelled and styled, exactly as requested. ALWAYS include: all quoted strings, all proper names of people/children/companies, ages, prices, dates and phone numbers as visible text. Never omit, abbreviate or change them. Spell Portuguese accents exactly (ex: Promoção, já, não, ação).',
    '- keep quoted text (“...” or \"...\") the user wants printed in the image, verbatim',
    domain,
    (opts.textSwap ? '- THIS IS A TEXT REPLACEMENT ON AN EXISTING REFERENCE DESIGN: keep the icon/emblem, colors, materials, panel, LED border, background and layout 100% IDENTICAL. Change ONLY the written text exactly as requested (match the requested text style, e.g. engraved/hollow/vazado). Do not redesign, do not move or replace the emblem, do not change the background.' : ''),
    '- end with hard constraints: no watermark, no gibberish letters, no unrelated text (unless the user asked for printed text)',
    'Rules: NEVER add “photorealistic, 8k, masterpiece, trending” spam. 2-5 sentences max. No explanations.',
    'Then, on the next line after a separator “###CONF:” append a 1-sentence friendly confirmation in PORTUGUESE telling the user what was generated (never mention the prompt).',
    'Format: <english prompt>\\n###CONF:<portuguese confirmation>'
  ].filter(Boolean).join('\n');

  const llmText = await callLLM(systemPrompt, `User request: ${trimmed}`, {
    temperature: 0.4,
    maxTokens: 700,
    maxAttempts: 1,
    timeout: 45000,
    json: false
  });

  if (llmText && llmText.trim()) {
    const cleaned = llmText.replace(/```/g, '').trim();
    const confMatch = cleaned.match(/###CONF:\s*([\s\S]+)$/);
    const prompt = confMatch ? cleaned.slice(0, confMatch.index).trim() : cleaned;
    const reply = (confMatch && confMatch[1].trim()) || '';
    if (prompt) return { prompt: ensureRequiredText(prompt, trimmed), reply, required, fromLLM: true };
  }

  // Fallback sem LLM: usa o otimizador leve por intenção (mantém o pedido do usuário)
  return { prompt: optimizeFallback(trimmed), reply: '', required, fromLLM: false };
}

// Otimizador leve sem LLM (fallback): adiciona toques técnicos por intenção.
function optimizeFallback(rawPrompt) {
  const p = rawPrompt.toLowerCase();
  let enhancement = '';
  if (/(arraial|festa junina|junina|s[ãa]o jo[ãa]o|festa caipira|bandeirinha)/.test(p)) {
    enhancement = ', Brazilian country party theme (arraial/Festa Junina), colorful pennant banners, chita patchwork fabric, corn, bonfire, festive invitation layout';
  } else if (/(convite|invitation|cart[ãa]o de anivers[áa]rio)/.test(p)) {
    enhancement = ', elegant invitation card design, festive, clean layout, with the name and age as prominent printed text';
  } else if (/(banner)/.test(p)) {
    enhancement = ', wide promotional banner, big bold headline, vibrant colors, professional marketing layout';
  } else if (/(flyer|panfleto|folder|folheto)/.test(p)) {
    enhancement = ', promotional flyer layout, clear visual hierarchy, headline, offer and price highlighted, professional print';
  } else if (/(hamburgueria|hamb[uú]rguer|burger|combo|lanche)/.test(p)) {
    enhancement = ', appetizing food photography, melting cheese, warm palette, bold price and offer text, professional promo';
  } else if (/(pizzaria|pizza)/.test(p)) {
    enhancement = ', hero shot of pizza with melted cheese, warm lighting, rustic Italian mood, offer and price highlighted';
  } else if (/(restaurante|restaurant|almo[çc]o|jantar|buffet|self[- ]service)/.test(p)) {
    enhancement = ', appetizing professional food photography, warm light, dish as hero, clean layout, price highlighted';
  } else if (/(produto|product|loja|ecommerce|vender|catálogo|celular|camiseta|caneca|garrafa|bolsa|tênis)/.test(p)) {
    enhancement = ', professional product photography, studio lighting, clean background, commercial quality, high-end e-commerce imagery';
  } else if (/(realist|foto|camera|paisagem|retrato|cachorro|pessoa|natureza|praia|carro)/.test(p)) {
    enhancement = ', ultra realistic photograph, natural lighting, sharp focus, professional photography';
  } else if (/(desenho|ilustra|cartoon|anime|pixel|arte|fantasia)/.test(p)) {
    enhancement = ', detailed digital illustration, vibrant colors, high detail';
  } else {
    enhancement = ', high quality, detailed, visually striking';
  }
  const hasQuoted = /"[^"]+"/.test(rawPrompt) || /(escrever|texto dizendo|com o texto|dizer|palavras?)/.test(p) ||
    /(convite|anivers[áa]rio|birthday|banner|flyer|panfleto|promo[çc][ãa]o|logo|hamburgueria|pizzaria|restaurante|oferta|pre[cç]o|R\$)/.test(p);
  const noText = hasQuoted ? '' : ', no text, no watermark, no letters, no words';
  return `${rawPrompt}${enhancement}${noText}`;
}

// Sugere uma FRASE PRONTA para o texto da peça quando o usuário pede "um texto"
// sem dizer qual — usa o tipo de peça + fatos da marca para copy de impacto em PT.
async function suggestPhraseFromRequest(raw, project) {
  const s = String(raw || '');
  const wantsAnyText = /(\btexto\b|\bfrase\b|\bslogan\b|\blema\b|\bchamada\b|\bmanchete\b|\bmensagem\b|legenda|escreve\w*\s+um texto|escrever u[mã]a? frase|um texto (legal|bom|bonito|de impacto|curto)|frase de impacto|texto de impacto)\b/i.test(s);
  const hasOwnText = /[""“”]/.test(s) || /R\$\s*\d|\b\d+\s*(anos|meses)\b/i.test(s) || /\b(telefone|contato|whatsapp)\b/i.test(s);
  if (!wantsAnyText || hasOwnText) return null;
  const facts = (project && project.facts) || [];
  const factLines = facts.filter((f) => f && f.key && f.value).map((f) => `- ${f.key}: ${f.value}`).join('\n');
  const sys = [
    'Você é um copywriter brasileiro sênior.',
    'Crie UMA frase curta e impactante (máx. 45 caracteres, em pt-BR, SEM emoji) para a peça visual descrita.',
    'Quando couber, use os fatos da marca na frase (nome da criança/idade, nome da empresa, oferta, slogan).',
    factLines ? 'Fatos da marca:\n' + factLines : '',
    'Responda SOMENTE com a frase — sem aspas, sem explicação.'
  ].filter(Boolean).join('\n');
  try {
    const t = await callLLM(sys, `Peça a criar: ${s.slice(0, 280)}`, { temperature: 0.8, maxTokens: 80, json: false });
    const ph = (t || '').trim().replace(/["'']+/g, '');
    if (ph.length >= 3 && ph.length <= 60) return ph;
    return null;
  } catch (e) {
    console.error('suggestPhraseFromRequest falhou:', e.message);
    return null;
  }
}

// Roteiro pronto para o "Anúncio Falado": a IA escreve a narração do vídeo que
// apresenta o produto, no tom de vendedor animado de marketplace.
async function generateAdScript(opts = {}) {
  const name = (opts.productName || '').trim();
  const desc = (opts.productDesc || '').trim();
  const price = (opts.productPrice || '').trim();
  const sys = [
    'Você é um redator de anúncios de marketplace brasileiro (Shopee/Mercado Livre).',
    'Escreva UM roteiro curto de 2 a 3 frases (máx. 40 palavras) para um vídeo apresentando o produto.',
    'Tom: animado, vendedor que ama o produto; fale com o cliente na 2ª pessoa.',
    'Comece chamando atenção (ex.: "Olha só que achado!").',
    price ? 'Mencione o preço como "R$ X".' : '',
    'Não use emojis. Responda SOMENTE o roteiro.'
  ].filter(Boolean).join('\n');
  const user = `Produto: ${name}\nVantagens: ${desc || 'não informadas'}\nPreço: ${price ? 'R$ ' + price : 'não informado'}`;
  try {
    const t = await callLLM(sys, user, { temperature: 0.9, maxTokens: 200, json: false });
    const script = (t || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 400);
    return script || null;
  } catch (e) {
    console.error('generateAdScript falhou:', e.message);
    return null;
  }
}

// Responde uma mensagem puramente conversacional (dúvida, pergunta geral, bate-papo)
// sem gerar imagem nem gastar crédito — o agente "conversa" como o ChatGPT.
async function replyConversation(message, memory) {
  const sys = [
    'You are the conversational assistant of "Criativa AI", an AI image/video creation platform.',
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
//   "edit" (editar imagem anexada), "video" (gerar vídeo),
//   "clarify" (pedido ambíguo/declarativo → agente deve perguntar o que o usuário quer)
function detectIntent(message, memory) {
  const m = (message || '').toLowerCase().trim();
  const hasRef = !!(memory && memory.refImages && memory.refImages.length > 0);

  // 1) VÍDEO
  if (/\b(v[íi]deo|anima[çc][ãa]o|anima\w*|tour\s*360|360\s*graus|imagem\s*em\s*movimento|movimenta\w*)\b/.test(m)) {
    return 'video';
  }

  // 2) EDIÇÃO: imagem anexada e o pedido altera A PRÓPRIA imagem (não cria do zero)
  if (hasRef) {
    const createNew = /(criar|cria|crie|fazer|faça|faca|gera|gere|montar|desenhar)\s+(uma|um|outra)\s+(nova\s+)?(imagem|arte|peça|peca|banner|logo|post|vídeo|video|capa)/.test(m);
    if (!createNew) return 'edit';
  }

  // 3) CONVERSA / cortesia / dúvida (restrito, só quando não há imagem e não pede ação)
  if (!hasRef && /(^|\s)(oi|ola|olá|opa|eai|e ai|bom dia|boa tarde|boa noite|tudo bem|obrigad|brigad|valeu)\b|(quem é|quem e|quem\s+voce|quem\s+você)\s|(como funciona|o que é|pra que serve|para que serve|me explica|explica como|como uso|como começar|não sei usar|quais as opções|o que posso|o que eu posso|pode me ajudar|você consegue fazer|você sabe|você existe|o que você faz|o que vc faz|me da um exemplo|me dê um exemplo)\b/.test(m)) {
    return 'conversation';
  }

  // 4) PEDIDO DECLARATIVO/SOLTO sem verbo de ação claro → perguntar o que o usuário quer.
  //     Se o usuário já pede um TIPO de peça ("quero um logo", "quero um banner"), é ação → create.
  const asksForPiece = /(quero|gostaria|preciso|necessito)\s+(de\s+)?(um|uma|um pouco de)\s+(logo|logomarca|banner|imagem|post|arte|pe[çc]a|capa|cartaz|flyer|panfleto|folder|cart[ãa]o|v[íi]deo|video|story|an[úu]ncio|impulso|comercial|marca|identidade)/.test(m);
  if (!asksForPiece && (/(^|\s)(quero|gostaria|necessito|preciso|talvez|seria bom|desejo)(\s|[.?!]|$)/.test(m) || /\b(me (dá|da|de) um exemplo|exemplo de|ideia de|sugest[ãa]o de|pode me dar|me manda)\b/.test(m)) && !/\b(criar|fazer|gera|gerar|edita|editar|transforma|mudar|trocar|remover|deixar|colocar|desenhar|montar|faz)\b/.test(m)) {
    return 'clarify';
  }

  // 5) Criação (ação explícita ou restante)
  return 'create';
}

// Extrai fatos de resposta direta a perguntas essenciais: se o usuário está
// respondendo "Qual o objetivo?" e diz "post pro instagram", guardamos objective;
// se é sobre nome/marca, guardamos brand. Forma o par (key,value) do briefing.
function extractBriefValue(key, answer) {
  const a = (answer || '').trim();
  if (!a) return null;
  if (key === 'objective') {
    const tipo = a.match(/\b(?:post|banner|an[úu]ncio|anuncio|capa|cartaz|flyer|folder|logo|logomarca|story|reels|p[ôo]ster|v[íi]deo|thumb)\b/i)?.[0]?.toLowerCase();
    const rede = a.match(/\b(instagram|facebook|whatsapp|linkedin|tiktok|youtube|site|e-commerce|ecommerce|impress[ãa]o)\b/i)?.[0]?.toLowerCase();
    if (tipo || rede) return { key, value: tipo ? (rede ? `${tipo} ${rede}` : tipo) : rede };
    return { key, value: a.slice(0, 40) };
  }
  if (key === 'brand') {
    const clean = a.replace(/(e|é|da|de|minha|nossa|empresa|chama|nome)/gi, ' ').replace(/\s+/g, ' ').trim();
    if (clean && clean.length >= 2 && clean.length <= 40) return { key, value: clean };
    return null;
  }
  // demais keys (cores, texto, estilo...) → o próprio texto é o valor
  const text = a.replace(/^[a-z]+[:\s]+/i, '').replace(/[.!]+$/g, '').trim();
  if (text && text.length <= 120) return { key, value: text };
  return null;
}

// Gera 3 legendas prontas para Instagram + chamada (CTA) para a peça criada.
// Usa os fatos duráveis (telefone/slogan/preço) e o objetivo da peça.
async function generateCaptions(prompt, project) {
  const facts = (project && project.facts) || [];
  const factLines = facts.map((f) => `${f.key}: ${f.value}`).join('\n');
  const sys = [
    'You are a Brazilian social media copywriter for Instagram/Facebook.',
    'Write 3 READY-TO-USE Portuguese (pt-BR) captions for the image the user just created.',
    'Style: short, punchy, with emoji, a hook on the first line, and ONE call-to-action per caption (e.g. chame no WhatsApp, siga para mais, comente “EU QUERO”).',
    'Use this known brand info when relevant:',
    factLines ? `Known facts: ${factLines}` : '(no facts provided)',
    'Format EXACTLY like this, no extra explanations:',
    '📱 Legenda 1: <caption>',
    '📱 Legenda 2: <caption>',
    '📱 Legenda 3: <caption>',
    '🔥 Melhor CTA: <one CTA>',
    'Hashtags: <up to 8 relevant hashtags, no space>'
  ].join('\n');
  try {
    const text = await callLLM(sys, `The piece is about: ${(prompt || '').slice(0, 900)}`, { temperature: 0.8, maxTokens: 700, json: false });
    if (text && text.trim()) return text.trim();
  } catch (e) {
    console.error('generateCaptions falhou:', e.message);
  }
  return null;
}

// Plano de conteúdo: 30 ideias de posts (um calendário) para a marca, separadas
// por tema e formato recomendado. Retorna texto pronto para exibir no chat.
async function contentPlan30(project, extra) {
  const facts = (project && project.facts) || [];
  const factLines = facts.map((f) => `${f.key}: ${f.value}`).join('\n');
  const brand = (project && project.brand) || 'sua marca';
  const objective = (project && project.objective) || 'redes sociais';
  const sys = [
    `You are a Brazilian social media strategist. Create a 30-day content calendar for ${brand} (focus: ${objective}).`,
    'Return as a numbered list (1 to 30), one idea per line: "DIA N — <título do post> (<formato: Reels/Story/Carrossel/Imagem>)".',
    'Mix: product highlights, before/after, testimonials, curiosities, tips, promos, behind-the-scenes, engagement questions. Vary formats.',
    'Use these facts when useful:',
    factLines || '(none)',
    'Keep every line short (max 90 characters). No extra text before or after the list.'
  ].join('\n');
  try {
    const suffix = extra ? `\nUser extra context: ${extra.slice(0, 300)}` : '';
    const text = await callLLM(sys, `Create the plan.${suffix}`, { temperature: 0.7, maxTokens: 1400, json: false });
    if (text && text.trim()) return text.trim();
  } catch (e) {
    console.error('contentPlan30 falhou:', e.message);
  }
  return null;
}

module.exports = { parseEditRequest, callLLM, getProvider, enhanceImagePrompt, replyConversation, detectIntent, extractBriefValue, generateCaptions, contentPlan30, extractTextTokens, ensureRequiredText, suggestPhraseFromRequest, generateAdScript };