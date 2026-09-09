const express = require('express');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const { authMiddleware } = require('../middleware');
const generateRoutes = require('./generate');
const { parseEditRequest, enhanceImagePrompt, replyConversation, detectIntent, extractBriefValue, generateCaptions, contentPlan30, extractTextTokens, suggestPhraseFromRequest } = require('../llm');
const cerebro = require('../cerebro');
const logo = require('../logo');
const vision = require('../vision');
const axios = require('axios');
const sharp = require('sharp');

const router = express.Router();
const prisma = new PrismaClient();

// Limite por usuário (chats são baratos, mas a geração de imagem consome)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  keyGenerator: (req) => (req.user ? req.user.id : req.ip),
  message: { error: 'Aguarde um momento antes do próximo comando.' }
});

async function consumeCredit(user) {
  // Plano PREMIUM é ilimitado — não consome crédito.
  if (user.plan === 'PREMIUM') return false;
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
  return true;
}

async function refundCredits(user) {
  // Plano PREMIUM é ilimitado — nunca consumiu, então não reembolsa.
  if (user.plan === 'PREMIUM') return;
  await prisma.user.update({
    where: { id: user.id },
    data: { creditsPurchased: { increment: 1 } }
  });
}

// Extrai as cores dominantes de uma imagem de referência (dataURL ou URL) via sharp.
// O gerador usa essa paleta para harmonizar o design com as cores da marca/logo.
async function dominantPalette(src, top = 4) {
  try {
    let buf;
    if (src && src.startsWith('data:')) {
      const b64 = src.split(',')[1];
      buf = b64 ? Buffer.from(b64, 'base64') : null;
    } else if (/^https?:\/\//.test(src)) {
      const res = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 });
      buf = res.data;
    } else {
      buf = null;
    }
    if (!buf) return null;
    const stats = await sharp(buf).resize(200, 200, { fit: 'inside' }).stats();
    const dominant = (stats.channels[0] && stats.channels[0].dominant) || [];
    const hex = dominant.map((d) => d.colorId).filter((h) => typeof h === 'string');
    return hex.slice(0, top);
  } catch (e) {
    return null;
  }
}

// Regras de composição para geração com imagens de referência — ensina o modelo a
// tratar logos como MARCA (pequeno, no canto/topo, sem caixa) e NUNCA colar a
// referência como quadro retângulo no centro. Reproduz o comportamento "estilo
// ChatGPT": harmoniza as cores da logo e posiciona a logo como emblema.
function multiRefDesignRules(paletteBlock) {
  const lines = [
    'Composition rules (follow strictly):'
  ];
  if (paletteBlock) {
    lines.push(`- Harmonize the whole piece with these reference color palettes: ${paletteBlock}.`);
  }
  lines.push('- Any reference that looks like a LOGO or brand mark must be used ONLY as a small brand logo/emblem placed in the top area or a corner (never centered as a big square box).');
  lines.push('- Do not paste any reference image as a full plain rectangle in the middle of the design; use references as design content or as brand mark only.');
  lines.push('- If the user asked to redo/recreate the piece, produce a fresh professional layout with balanced composition and legible, correctly spelled text in the requested language.');
  return lines.join('\n');
}

// POST /api/cerebro/chat — interpreta o comando e gera a nova versão da imagem
// Aceita: message, sessionId, image (principal, dataURL/string) ou images: [urls/dataURLs] (até 4)
router.post('/chat', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { sessionId, message, image, images, portrait } = req.body || {};
    const user = req.user;

    if (!message || message.trim().length < 2) {
      return res.status(400).json({ error: 'Digite o que quer mudar na imagem.' });
    }

    // Modo RETRATO: presets de estilo (neo-noir, capa de álbum etc.) aplicados numa
    // selfie mantendo o rosto. Vem por flag do app OU quando o texto é um preset.
    const isPortrait = !!(portrait || /(uploaded selfie|uploaded person|original reference image|the picture provided)/i.test(message || ''));

    const sid = typeof sessionId === 'string' && sessionId ? sessionId : cerebro.newSessionId();
    const session = cerebro.getOrCreateSession(user.id, sid);

    // 🗂️ MEMÓRIA DE LONGO PRAZO: hidrata o projeto com o que o usuário já decidiu
    // em conversas anteriores (marca, cores, fatos). Tudo que ele repete nunca mais
    // precisa ser reexplicado — vale para qualquer sessão.
    const longMem = cerebro.loadUserMemory(user.id);
    if (longMem && !session.memory.onlyFromDisk) {
      const proj = session.memory.project;
      if (!proj.brand && longMem.brand) proj.brand = longMem.brand;
      if (!(proj.colors && proj.colors.length) && Array.isArray(longMem.colors) && longMem.colors.length) {
        proj.colors = longMem.colors;
      }
      if (!proj.style && longMem.style) proj.style = longMem.style;
      if (!proj.objective && longMem.objective) proj.objective = longMem.objective;
      if (!(proj.facts && proj.facts.length) && Array.isArray(longMem.facts) && longMem.facts.length) {
        proj.facts = longMem.facts;
      }
      // "onlyFromDisk" impede re-hidratar depois de o usuário mudar algo na sessão
      session.memory.onlyFromDisk = true;
    }

    // Pergunta sobre como funciona → responde com explicação sem gerar nem gastar crédito
    const HOW_IT_WORKS = /como funciona|cria imagem|gerar imagem|fazer imagem|como você cria|como eu crio|como vc cria|como vc gera|como você (gera|cria|faz)|o que você faz|o que vc faz|explica como|me explica|como funciona a criação|de texto ou imagem/i;
    if (HOW_IT_WORKS.test(message)) {
      cerebro.pushHistory(session, 'user', message, null);
      const reply = '⚙️ Como funciona na prática:\n\n• Texto → Conceitos visuais: você descreve a cena e o modelo entende cada parte.\n\n• Composição → Renderização: o modelo organiza os elementos e gera a imagem pixel por pixel.\n\n• Imagem enviada → Referência: se você manda uma foto, ela serve como base para aplicar mudanças ou estilos.\n\nEnvie a foto + sua logo e peça para colocar a logo — eu sobreponho ela exatamente na posição que você escolher.';
      cerebro.pushHistory(session, 'assistant', reply, null);
      return res.json({
        success: true,
        sessionId: session.id,
        reply,
        imageUrl: null,
        memory: session.memory,
        history: session.history.slice(-20)
      });
    }

    // Guarda imagem(s) de referência — aceita uma lista de até 4 imagens para edição real
    const refsFromClient = Array.isArray(images) && images.length > 0
      ? images.filter((u) => typeof u === 'string' && u).slice(0, 4)
      : [];

    if (refsFromClient.length > 0) {
      session.memory.refImages = refsFromClient;
      if (!session.memory.baseImage) session.memory.baseImage = refsFromClient[0];
    } else if (image && !session.memory.baseImage) {
      session.memory.baseImage = image;
      session.memory.refImages = [image];
    }

    // 👁️ VISÃO DO CÉREBRO: quando novas referências chegam, a IA olha cada uma e
    // grava uma descrição (conteúdo, cores, textos exatos). Isso é injetado no LLM
    // de interpretação e no prompt, fazendo a IA "entender" a imagem — não só a forma.
    if (session.memory.refImages.length) {
      const known = new Set(
        (session.memory.refDescriptions || []).map((d) => d.src)
      );
      const pending = [];
      for (const ref of session.memory.refImages) {
        if (!ref || known.has(ref)) continue;
        pending.push(ref);
      }
      if (pending.length) {
        session.memory.refDescriptions = session.memory.refDescriptions || [];
        for (const ref of pending) {
          const caption = await vision.describeReference(ref);
          if (caption) {
            session.memory.refDescriptions.push({ src: ref, caption });
            if (session.memory.refDescriptions.length > 8) {
              session.memory.refDescriptions = session.memory.refDescriptions.slice(-8);
            }
          }
        }
      }
    }

    // 0) AGENTE conversacional: se o pedido é só uma conversa/dúvida (não é uma ação
    //     de criação/edição/vídeo), responde como chat normal SEM gastar crédito.
    const intent = detectIntent(message, session.memory);

    // 🗓️ PLANO DE CONTEÚDO (30 dias): quando o usuário pede ideias de posts para a
    //     marca, geramos um calendário — sem gerar imagem nem gastar crédito.
    if (/\b(plano de (conte[úu]do|posts|publica[çc][ãa]o)|calend[áa]rio( de conte[úu]do)?|ideias de posts|30 (dias|posts)\b)/i.test(message)) {
      cerebro.pushHistory(session, 'user', message, null);
      const plan = await contentPlan30(session.memory.project, message) ||
        'Ainda sem minha chave IA configurada para texto, mas aqui vai um começo:\n\n1) Apresentação da marca (Reels)\n2) Bastidores (Story)\n3) Antes/depois (Carrossel)\n4) Depoimento de cliente (Reels)\n5) Dica rápida (Story)\n6) Promo/Sorteio (Imagem)\n\nConfigure a chave (LLM_API_KEY) para eu gerar os 30 dias completos.';
      cerebro.pushHistory(session, 'assistant', plan, null);
      return res.json({
        success: true,
        sessionId: session.id,
        reply: plan,
        imageUrl: null,
        videoUrl: null,
        type: 'plan',
        memory: session.memory,
        history: session.history.slice(-20)
      });
    }

    // 📸 AVISO DE FOTO RUIM ANTES DE GASTAR: se o usuário anexou uma imagem que está
    //     borrada/escura/de baixa resolução, avisamos ANTES de gerar em cima dela.
    if ((intent === 'edit' || intent === 'create') && session.memory.refImages.length) {
      const firstRef = session.memory.refImages[0];
      // Só avaliamos fotos ENVIADAS pelo usuário (dataURL) — outputs/URLs (Freepik,
      // resultados gerados) são pulados para não travar a edição de uma peça.
      if (firstRef && firstRef.startsWith('data:')) {
      try {
        let dims = null;
        if (firstRef) {
          let buf = null;
          if (firstRef.startsWith('data:')) {
            buf = Buffer.from(firstRef.split(',')[1] || '', 'base64');
          } else if (/^https?:\/\//.test(firstRef)) {
            const rT = await axios.get(firstRef, { responseType: 'arraybuffer', timeout: 15000 });
            buf = rT.data;
          }
          if (buf && buf.length) {
            const meta = await sharp(buf, { limitInputPixels: false }).metadata();
            if (meta && meta.width && meta.height) dims = { w: meta.width, h: meta.height };
          }
        }
        const tooSmall = dims && (dims.w < 400 || dims.h < 400);
        const qa = tooSmall ? { ok: false, reason: `a imagem é pequena (${dims.w}×${dims.h}px)` } : await vision.checkImageQuality(firstRef);
        if (qa && qa.ok === false) {
          const advise = `⚠️ A imagem que você enviou está com problema: ${qa.reason || 'qualidade insuficiente'}. Vou gerar mesmo assim, mas o resultado pode sair ruim. Se puder, envie uma foto melhor (mais nítida e com mais de 400×400 px). Se quiser, toque em "Gerar" com uma nova imagem.`;
          cerebro.pushHistory(session, 'user', message, null);
          cerebro.pushHistory(session, 'assistant', advise, null);
          return res.json({
            success: true,
            sessionId: session.id,
            reply: advise,
            imageUrl: null,
            videoUrl: null,
            type: 'warn',
            memory: session.memory,
            history: session.history.slice(-20)
          });
        }
      } catch (e) {
          console.error('Aviso de foto ruim falhou (seguindo em frente):', e.message);
        }
      }
    }
    if (intent === 'clarify') {
      cerebro.pushHistory(session, 'user', message, null);
      const clarifyReply = 'Entendi, mas me conta um pouco mais para eu acertar de primeira:\n\n• O que você quer criar ou mudar? (imagem, logo, banner, vídeo...)\n• Tem uma foto/marca para eu usar como base?\n\nQuanto mais detalhe você der (tipo de peça, cores, texto, objetivo), melhor fica o resultado.';
      cerebro.pushHistory(session, 'assistant', clarifyReply, null);
      return res.json({
        success: true,
        sessionId: session.id,
        reply: clarifyReply,
        imageUrl: null,
        videoUrl: null,
        type: 'clarify',
        memory: session.memory,
        history: session.history.slice(-20)
      });
    }
    if (intent === 'conversation') {
      cerebro.pushHistory(session, 'user', message, null);
      const answer = await replyConversation(message, session.memory) || 'Não entendi ainda — pode me falar o que você quer criar? Posso gerar e editar imagens e vídeos.';
      cerebro.pushHistory(session, 'assistant', answer, null);
      return res.json({
        success: true,
        sessionId: session.id,
        reply: answer,
        imageUrl: null,
        videoUrl: null,
        type: 'conversation',
        memory: session.memory,
        history: session.history.slice(-20)
      });
    }

    // 1) PERGUNTA FORTE (travada ANTES do LLM de interpretação): se o pedido é criar
    //     uma peça nova do zero (sem imagem anexada) e ainda faltam as informações
    //     essenciais de identidade, o agente pergunta ANTES de gerar — em vez de
    //     "chutar" ou deixar o LLM responder no escuro. Não gasta crédito.
    //     BRIEFING GUIADO: uma pergunta por vez; o que já foi perguntado nunca se repete.
    const noRefForStrong = !(session.memory.refImages && session.memory.refImages.length > 0);
    if (intent === 'create' && noRefForStrong && !session.memory.collecting) {
      const projStrong = session.memory.project || {};
      const askedStrong = session.memory.asked || [];
      const wantsBrandStrong = /(logo|logomarca|marca|identidade|assinatura)/i.test(message);
      const wantsObjStrong = /(banner|post|an[úu]cio|capa|cartaz|flyer|panfleto|p[ôo]ster|folder|comercial|campanha|publicidade|material|cart[ãa]o|impulso|story|logo|imagem|arte|arte final)/i.test(message) || /\b(para|destinado|voltado)\b/i.test(message);
      const qStrong = [];
      if (wantsBrandStrong && !projStrong.brand && !askedStrong.includes('brand')) qStrong.push({ field: 'brand', q: 'Qual é o nome/marca que deve aparecer na peça?' });
      if (wantsObjStrong && !projStrong.objective && !askedStrong.includes('objective')) qStrong.push({ field: 'objective', q: 'Qual o objetivo/tipo da peça (ex: post p/ Instagram, banner, capa, cartaz, anúncio...)?' });
      if (!(projStrong.colors && projStrong.colors.length) && !askedStrong.includes('colors')) qStrong.push({ field: 'colors', q: 'Quais cores devo usar (cores da sua marca ou preferência)?' });
      if (qStrong.length) {
        const firstStrong = qStrong[0];
        session.memory.asked = [...new Set([...askedStrong, firstStrong.field])];
        session.memory.pending = {
          fields: qStrong.map((x) => x.field),
          askedAt: Date.now(),
          creating: true,
          question: firstStrong.field
        };
        session.memory.collecting = true;
        cerebro.pushHistory(session, 'user', message, null);
        cerebro.pushHistory(session, 'assistant', firstStrong.q, null);
        return res.json({
          success: true,
          sessionId: session.id,
          reply: firstStrong.q,
          ask: [firstStrong.q],
          needInfo: true,
          imageUrl: null,
          videoUrl: null,
          type: 'create',
          memory: session.memory,
          history: session.history.slice(-20)
        });
      }
    }

    // 1) Entender o que o usuário quer (LLM se houver saldo, senão heurística)
    let cmd;
    try {
      cmd = await parseEditRequest(message, session.memory);
    } catch (e) {
      console.error('Falha ao interpretar comando:', e.message);
      cmd = { reply: 'Entendi! Vou ajustar a imagem.', prompt_delta: null, replace_prompt: false, strength: 0.65, aspect_ratio: null, fromLLM: false };
    }

    // 1b) Atualiza a memória de projeto (marca, cores, estilo, objetivo) com o que
    //     foi reconhecido no pedido — mantém coerência visual entre as versões.
    if (cmd.projectUpdate && session.memory.project) {
      const up = cmd.projectUpdate;
      const proj = session.memory.project;
      if (up.brand) proj.brand = up.brand;
      if (Array.isArray(up.colors) && up.colors.length) {
        proj.colors = [...new Set([...(proj.colors || []), ...up.colors])];
      }
      if (up.style) proj.style = up.style;
      if (up.objective) proj.objective = up.objective;
    }
    // 🧠 MEMÓRIA DE FATOS: preço, telefone, slogan, endereço e produto mencionados
    // ficam gravados no projeto e reaparecem em toda versão (chave igual = atualiza).
    if (Array.isArray(cmd.facts) && cmd.facts.length) {
      cerebro.mergeFacts(session.memory.project, cmd.facts);
      // Persiste no disco → memória de longo prazo (sobrevive a sessões).
      cerebro.saveUserMemory(user.id, session.memory.project);
    }
    if (cmd.projectUpdate || (Array.isArray(cmd.facts) && cmd.facts.length)) {
      cerebro.saveUserMemory(user.id, session.memory.project);
    }

    // 2) Registrar o pedido no histórico
    cerebro.pushHistory(session, 'user', message, null);

    // 2a) Estamos coletando resposta de uma pergunta anterior → este comando é a
    //     resposta; consumimos o estado de coleta.
    const wasCollecting = session.memory.collecting;
    const pendInfo = session.memory.pending;
    if (wasCollecting) session.memory.collecting = null;
    session.memory.pending = null;

    // BRIEFING GUIADO: quando o usuário responde a pergunta anterior (criando peça
    // nova do zero), capturamos o campo respondido, aplicamos fatos, e se ainda
    // faltar informação essencial que nunca perguntamos, perguntamos a próxima.
    // Se o usuário "dispensa" ("não sei", "tanto faz", "você escolhe") → gera logo.
    if (wasCollecting && pendInfo && pendInfo.creating) {
      const proj = session.memory.project || {};
      const dismissive = /(não sei|nao sei|tanto faz|você escolhe|vc escolhe|você decide|faz do seu jeito|a seu critério|deixa com você|faz você)\b/i.test(message);

      // Captura o valor da pergunta que estava pendente (que campo ele respondia).
      if (pendInfo.question) {
        const fill = extractBriefValue(pendInfo.question, message);
        if (fill) {
          if (pendInfo.question === 'colors') {
            proj.colors = [...new Set([
              ...(proj.colors || []),
              ...String(fill.value).split(/[,;e]/).map((s) => s.trim()).filter(Boolean)
            ])];
          } else {
            proj[pendInfo.question] = fill.value;
          }
        }
      }

      // Ainda falta informação essencial que nunca perguntamos → próxima pergunta.
      const nextPend = (pendInfo.fields || []).find((fld) => {
        const filled = fld === 'colors' ? !!(proj.colors && proj.colors.length) : !!proj[fld];
        return !filled && !(session.memory.asked || []).includes(fld);
      });
      if (nextPend && !dismissive) {
        session.memory.asked = [...new Set([...(session.memory.asked || []), nextPend])];
        const qMap = {
          brand: 'Qual é o nome/marca que deve aparecer na peça?',
          colors: 'Quais cores devo usar (da sua marca ou para combinar)?',
          objective: 'Qual o objetivo/tipo da peça (ex: post p/ Instagram, banner, capa, cartaz, anúncio...)?',
          style: 'Qual estilo visual você prefere (moderno, profissional, criativo)?',
          text: 'Qual texto ou chamada deve aparecer na peça?'
        };
        session.memory.pending = {
          fields: pendInfo.fields,
          askedAt: Date.now(),
          creating: true,
          question: nextPend
        };
        session.memory.collecting = true;
        const qText = qMap[nextPend] || 'Me conta mais um detalhe para eu acertar a peça.';
        cerebro.pushHistory(session, 'assistant', qText, null);
        return res.json({
          success: true,
          sessionId: session.id,
          reply: qText,
          ask: [qText],
          needInfo: true,
          imageUrl: null,
          videoUrl: null,
          type: 'create',
          memory: session.memory,
          history: session.history.slice(-20)
        });
      }

      // Tudo certo (ou usuário dispensou) → tratamos a resposta como a especificação
      // da peça e forçamos a geração com a identidade projetual já coletada.
      const ctx = [];
      if (proj.brand) ctx.push(`${proj.brand}`);
      if (proj.colors && proj.colors.length) ctx.push(`paleta: ${proj.colors.join(', ')}`);
      if (proj.style) ctx.push(`estilo: ${proj.style}`);
      if (proj.objective) ctx.push(`objetivo: ${proj.objective}`);
      if (proj.facts && proj.facts.length) ctx.push(`fatos: ${proj.facts.map((f) => `${f.key}: ${f.value}`).join(', ')}`);
      const build = `Create a professional commercial marketing piece. Subject/context decided with the user: "${message}". Brand identity: ${ctx.join(' | ') || 'none specified — use a clean modern professional look'}. High quality, balanced composition, no watermark.`;
      let newPrompt = build;
      try {
        const enh = await enhanceImagePrompt(build, { project: proj });
        if (enh.prompt) newPrompt = enh.prompt;
      } catch (e) {}
      cmd = {
        reply: 'Perfeito! Vou criar a peça com as informações que você me deu.',
        replace_prompt: true,
        new_prompt: newPrompt,
        strength: 1,
        fromLLM: true
      };
    } else if (wasCollecting && pendInfo && !pendInfo.creating) {
      // Era uma pergunta pontual (não-criadora, ex: nome para a logo). O comando já
      // foi interpretado com a resposta; só impedimos que o LLM re-pergunte agora.
      if (cmd.ask && cmd.ask.length) cmd.ask = [];
    }

    // 2b) Precisamos de informação antes de gerar (ex: qual nome colocar na logo) —
    //     mas se o usuário já enviou a logo real (2ª imagem), usa ela e não pergunta o nome.
    const isLogoRequest = /(logo|logomarca|marca d|marca da)/i.test(message);
    const logoImageAvailable = session.memory.refImages.length >= 2;
    if (cmd.needName && !(isLogoRequest && logoImageAvailable)) {
      cerebro.pushHistory(session, 'assistant', cmd.reply, null);
      const creditsNow = await prisma.user.findUnique({
        where: { id: user.id },
        select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
      });
      return res.json({
        success: true,
        sessionId: session.id,
        reply: cmd.reply,
        needName: true,
        imageUrl: null,
        memory: session.memory,
        history: session.history.slice(-20),
        credits: creditsNow
      });
    }

    // 2c) O Cérebro decidiu que precisa perguntar algo essencial → responde sem gerar
    //     e guarda as perguntas pendentes para continuar quando o usuário responder.
    //     Proteção anti-loop: se já estávamos coletando, força geração com o que temos.
    const alreadyCollecting = session.memory.collecting;
    if (cmd.ask && cmd.ask.length > 0 && !alreadyCollecting) {
      // Mapeia a pergunta para o campo do projeto (para o briefing guiado não repetir).
      const inferField = (q) => {
        const s = (q || '').toLowerCase();
        if (/nome|marca/.test(s)) return 'brand';
        if (/cor(es)?/.test(s)) return 'colors';
        if (/objetivo|tipo|finalidade|post|banner|an[úu]ncio/.test(s)) return 'objective';
        if (/texto|chamada|escrever/.test(s)) return 'text';
        if (/estilo/.test(s)) return 'style';
        return 'objective';
      };
      const fields = cmd.ask.map((q) => inferField(q));
      session.memory.pending = {
        fields,
        askedAt: Date.now(),
        creating: !!cmd.replace_prompt, // é criação de peça nova → a resposta deve gerar
        question: fields[0]
      };
      session.memory.collecting = true;
      cerebro.pushHistory(session, 'assistant', cmd.reply, null);
      const creditsNow = await prisma.user.findUnique({
        where: { id: user.id },
        select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
      });
      return res.json({
        success: true,
        sessionId: session.id,
        reply: cmd.reply,
        ask: cmd.ask,
        needInfo: true,
        imageUrl: null,
        memory: session.memory,
        history: session.history.slice(-20),
        credits: creditsNow
      });
    }
    // Se já estávamos coletando, garante que o flag é limpo antes de gerar
    session.memory.collecting = null;

    // 2c-bis) Caso extra de criação do zero detectado pelo LLM (replace_prompt) que
    //     não passou pela pergunta forte do topo — pode gerar direto (nada a fazer).
    //     A pergunta forte principal roda ANTES do parseEditRequest.

    // 2d) AGENTE: pedido de vídeo → interpreta e gera image-to-video a partir da imagem
    //     anexada (ou da última gerada). O Cérebro decide o movimento pelo pedido.
    const isVideoRequest = /\b(v[íi]deo|anima[çc][ãa]o|anima\w*|transforma?\s*em\s*(v[íi]deo|anima)|faz\s*um\s*(v[íi]deo|anima)|tour\s*360|360\s*graus|cena\s*em\s*movimento|imagem\s*em\s*movimento|movimenta\w*)\b/i.test(message);
    if (isVideoRequest) {
      const videoSource = session.memory.refImages[0] || session.memory.baseImage;
      if (!videoSource) {
        cerebro.pushHistory(session, 'assistant', 'Para criar um vídeo, envie antes a imagem (foto) que quer transformar em vídeo.', null);
        return res.json({ success: true, sessionId: session.id, reply: 'Para criar um vídeo, envie antes a imagem (foto) que quer transformar em vídeo.', imageUrl: null, videoUrl: null, memory: session.memory, history: session.history.slice(-20) });
      }
      if (user.plan !== 'PREMIUM' && user.creditsVideos <= 0 && user.creditsPurchased <= 0) {
        return res.status(403).json({ error: 'Créditos de vídeo esgotados. Assine o plano para gerar vídeos.', code: 'NO_CREDITS', upgradeUrl: '/plans' });
      }

      const generation = await prisma.generation.create({
        data: { userId: user.id, type: 'VIDEO', prompt: '[agente-video] ' + message.slice(0, 200), status: 'PROCESSING', cost: 1 }
      });
      const usedPurchased = user.plan !== 'PREMIUM' && user.creditsPurchased > 0;
      if (usedPurchased) {
        await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
      } else if (user.plan !== 'PREMIUM') {
        await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { decrement: 1 } } });
      }

      const motion = /\btour\b|\b360\b|giro|rota|circular|panoram/i.test(message) ? 'orbit' : (/andar|caminhar|andar em dire|personagem se move|ele anda/i.test(message) ? 'walk' : 'subtle');
      try {
        const videoUrl = await generateRoutes.generateVideoFromProviders(videoSource, `create a smooth cinematic ${motion === 'orbit' ? '360-degree rotating view' : motion === 'walk' ? 'walking movement' : 'subtle lifelike motion'} of this image`, motion, {});
        if (videoUrl) {
          await prisma.generation.update({ where: { id: generation.id }, data: { status: 'COMPLETED', imageUrl: videoUrl } });
          session.memory.baseImage = videoUrl;
          session.memory.refImages[0] = videoUrl;
          const credits = await prisma.user.findUnique({ where: { id: user.id }, select: { creditsImages: true, creditsVideos: true, creditsPurchased: true } });
          cerebro.pushHistory(session, 'assistant', 'Vídeo gerado!', videoUrl);
          return res.json({ success: true, sessionId: session.id, reply: 'Vídeo criado a partir da sua imagem.', videoUrl, type: 'video', memory: session.memory, history: session.history.slice(-20), credits });
        }
      } catch (e) {
        console.error('Cérebro: geração de vídeo falhou:', e.message);
      }
      await prisma.user.update({
        where: { id: user.id },
        data: usedPurchased ? { creditsPurchased: { increment: 1 } } : (user.plan === 'PREMIUM' ? {} : { creditsVideos: { increment: 1 } })
      });
      return res.status(502).json({ error: 'Não foi possível gerar o vídeo agora. Tente novamente.', code: 'GEN_FAILED' });
    }

    // Checagem de crédito de IMAGEM: deve ocorrer SÓ aqui (antes de gerar/debitar),
    // e NUNCA no início, para que conversa/perguntas/coleta funcionem sem crédito.
    const totalImageCredits = user.creditsImages + user.creditsPurchased;
    if (user.plan !== 'PREMIUM' && totalImageCredits <= 0) {
      return res.status(403).json({ error: 'Créditos esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
    }

    // 3) Compor o prompt técnico acumulado (memória fotográfica da conversa)
    let finalPrompt = cerebro.composePrompt(session.memory, cmd, message);
    const { width, height } = cerebro.aspectSizes(cmd.aspect_ratio || null);

    // 3a) Paleta de cores das referências (>=2 imagens = flyer/exemplo + logo).
    //     O gerador harmoniza o design novo com as cores reais da marca/logo.
    const refCount = (session.memory.refImages || []).length;
    let paletteBlock = '';
    if (refCount >= 2) {
      const palettes = [];
      for (const ref of session.memory.refImages.slice(0, 4)) {
        palettes.push(await dominantPalette(ref));
      }
      if (palettes.some((p) => p && p.length)) {
        paletteBlock = palettes
          .map((p, i) => `ref${i + 1}: ${p && p.length ? p.join(' ') : 'n/a'}`)
          .join('; ');
      }
    }

    // 3b) Nova imagem do zero: reescreve o pedido em prompt profissional estilo ChatGPT.
    //     Isso transforma pedidos vagos/absurdos em imagens de alta qualidade.
    if (cmd.replace_prompt && !isPortrait) {
      try {
        // Inclui o contexto de projeto (marca/cores/estilo) na reescrita para que a
        // nova imagem nasça já coerente com a identidade visual construída.
        const enh = await enhanceImagePrompt(cmd.new_prompt || message, {
          project: session.memory.project
        });
        if (enh.prompt) {
          finalPrompt = enh.prompt;
          if (refCount > 0) finalPrompt += '\n' + multiRefDesignRules(paletteBlock);
          session.memory.currentPrompt = enh.prompt;
          if (enh.reply) cmd.reply = enh.reply;
        }
      } catch (e) {
        console.error('Cérebro Visual: enhance de prompt falhou (usando prompt original):', e.message);
        if (refCount > 0) finalPrompt = finalPrompt + '\n' + multiRefDesignRules(paletteBlock);
      }
    }

    // 3c) Se o usuário pediu "um texto/frase" sem dizer o conteúdo, o Cérebro
    //     SUGERE uma frase elaborada (usa os fatos que lembra) e imprime na peça.
    if (cmd.replace_prompt) {
      try {
        const ownTokens = extractTextTokens(cmd.new_prompt || message);
        if (!ownTokens.length) {
          const phrase = await suggestPhraseFromRequest(cmd.new_prompt || message, session.memory.project);
          if (phrase && !finalPrompt.includes(phrase)) {
            finalPrompt = `${finalPrompt}\nInclude the exact printed text "${phrase}" clearly in the image.`;
            session.memory.currentPrompt = finalPrompt;
            cmd.reply = (cmd.reply || '') + ` Sugeri esta frase para o texto: “${phrase}” — me diga se quer alterar.`;
          }
        }
      } catch (e) {
        console.error('Cérebro: sugestão de frase falhou (seguindo sem):', e.message);
      }
    }

    // 3d) TROCA DE TEXTO EM REFERÊNCIA (ex: "muda o nome para Strategy Soluções em
    //     Elétrica embaixo do falcão, resto igual"): o cliente quer SO o texto diferente;
    //     a arte (ícone, cores, painel, LED, fundo) deve ficar IDÊNTICA à imagem base.
    const textSwapRequested =
      /(mud[ea]\s+o\s+(texto|nome)|troca[mn]?\s+o\s+(texto|nome)|alter[ae]\s+o\s+(texto|nome)|substitu[íi]r\s+o\s+(texto|nome)|escrev[ea]\s+o\s+(texto|nome)|novo\s+(texto|nome)|colocar?\s+o\s+(texto|nome)|texto\s+dizendo|com\s+o\s+nome\b|nome\s+(embaixo|abaixo|em\s+vez|no\s+lugar)|apenas\s+o\s+(texto|nome)|s[óo]\s+o\s+(texto|nome)|deix[ae]\s+o\s+resto|mantenh[ae]?\s+o\s+resto|resto\s+igual|s[óo]\s+mud[ae]\s+o\s+texto)/i.test(message);
    if (textSwapRequested && refCount > 0) {
      const KEEP_ART = '\nCRITICAL INSTRUCTION: this is a TEXT REPLACEMENT on the existing reference image. Keep the emblem/icon, colors, materials, panel, LED border, background and layout 100% IDENTICAL to the reference. Change ONLY the written text exactly as requested (match the requested text style, e.g. engraved/hollow/vazado). Do not redesign, do not move or replace the emblem, do not change the background.';
      let textSwapPrompt = cmd.new_prompt || message;
      try {
        const enh = await enhanceImagePrompt(textSwapPrompt, {
          project: session.memory.project,
          textSwap: true
        });
        if (enh.prompt) textSwapPrompt = enh.prompt;
        cmd.reply = (cmd.reply || '') + ' Entendi: mantenho a arte exatamente como está e troco somente o texto.';
      } catch (e) {
        console.error('Cérebro: enhance de troca de texto falhou (seguindo com pedido original):', e.message);
      }
      finalPrompt = textSwapPrompt + KEEP_ART;
      session.memory.currentPrompt = finalPrompt;
      if (refCount > 0) finalPrompt += '\n' + multiRefDesignRules(paletteBlock);
      cmd.replace_prompt = true;
    }

    // 4) Registrar geração + consumir crédito
    const generation = await prisma.generation.create({
      data: {
        userId: user.id,
        type: 'IMAGE',
        prompt: finalPrompt,
        status: 'PROCESSING',
        cost: 1
      }
    });
    await consumeCredit(user);

    // 5) MODO AUTOMÁTICO DE LOGO — comando simples, a IA faz tudo sozinha:
    // quando há 2+ imagens e uma delas parece ser a logo (ou o usuário falou "logo"),
    // o Cérebro descobre qual é qual, usa a OUTRA como base do design e depois:
    //   • harmoniza as cores com a paleta real da logo (feito em 3a);
    //   • remove o fundo da logo → vira PNG transparente;
    //   • sobrepõe a logo exata em um canto (nunca centralizada).
    let imageUrl = null;
    let editSource = session.memory.refImages[0] || session.memory.baseImage || undefined;
    let smartLogo = null;

    // 5a) TRANSPLANTE DE ELEMENTO (ex: "retira a taça e põe a da segunda imagem"):
    //     o usuário descreve PELA METADE — cabe ao Cérebro adivinhar que quer trocar
    //     um elemento usando a OUTRA imagem anexada, e enviar AS DUAS ao modelo.
    //     Pistas: falar em "segunda/outra imagem" OU verbo de troca/remoção com 2+ refs.
    let swapRequested = false;
    let swapThing = '';
    if (session.memory.refImages.length >= 2) {
      const m = message || '';
      const mentionsOther = /(da segunda|pela segunda|da outra|pela outra|da 2[aº]?|da foto 2|da imagem 2|segunda imagem|segunda foto|outra imagem|outra foto|das refer[êe]ncias|a segunda|a outra)/i.test(m);
      const objMatch = m.match(/(?:troca|trocar|retira|retirar|remove|remover|tira|tirar|substit|apaga|pega)\w*\s+(?:a\s+|o\s+|um\s+|uma\s+)?([\wà-úçãõéíóúâêô-]+)/i);
      const swapVerb = !!objMatch && /(troca|trocar|retira|retirar|tira|tirar|substit)/i.test(m);
      const obj = (objMatch && objMatch[1] || '').trim().toLowerCase();
      const isBrandWord = /(logo|logomarca|marca|assinatura)/i.test(obj);
      swapRequested = mentionsOther || (swapVerb && !isBrandWord);
      if (swapRequested) swapThing = isBrandWord ? '' : obj;
    }

    if (!swapRequested && !textSwapRequested && session.memory.refImages.length >= 2) {
      const logoRef = isLogoRequest && logoImageAvailable
        ? 1 // usuário falou "logo" → convenção: 2ª imagem = logo, 1ª = base
        : await logo.detectLogoRef(session.memory.refImages);
      if (logoRef >= 0 && logoRef < session.memory.refImages.length) {
        const baseRef = logoRef === 0 ? 1 : 0; // a outra imagem é o conteúdo/base
        smartLogo = {
          logoImg: session.memory.refImages[logoRef],
          baseImg: session.memory.refImages[baseRef]
        };
        editSource = smartLogo.baseImg;
      }
    }

    // Pedido que é SÓ "colocar a logo" (sem criar/refazer) → sobrepõe direto na base.
    const onlyPlace = !!smartLogo &&
      /(coloc\w* (a|minha|essa|esta)? logo|adicion\w* (a )?logo|po[õe] a logo|logo (no|em)|aplicar a logo)/i.test(message) &&
      !/(refaz\w*|recria\w*|muda\w*|faz\w* (um|o)|cria\w*|novo|nova|redesign|troca\w*|remove\w*|tira\w*)/i.test(message);

    const POS_LABEL = {
      'bottom-right': 'inferior direito', 'top-right': 'superior direito',
      'bottom-left': 'inferior esquerdo', 'top-left': 'superior esquerdo',
      top: 'topo', bottom: 'inferior (base)', left: 'lado esquerdo',
      right: 'lado direito', center: 'centro'
    };
    const cornerPosition = (msg) => {
      const p = logo.detectLogoPosition(msg);
      return p === 'center' ? 'top-left' : p; // nunca centraliza a logo sozinho
    };

    if (smartLogo && onlyPlace) {
      try {
        const pos = cornerPosition(message);
        const logoClean = (await logo.removeLogoBackground(smartLogo.logoImg)) || smartLogo.logoImg;
        imageUrl = await logo.compositeLogo(smartLogo.baseImg, logoClean, pos);
        if (imageUrl) {
          cmd.reply = `Pronto! Reconheci sua logo sozinho, recortei o fundo dela e coloquei no ${POS_LABEL[pos]}.`;
        }
      } catch (e) {
        console.error('Cérebro Visual: auto-logo (só colocar) falhou:', e.message);
      }
    }

    if (!imageUrl) {
      try {
        // Comprime a imagem de referência (foto do celular em base64 pode estourar o
        // payload da fal → 500). Reduz para ~1024px/JPEG sem perder o que importa.
        let safeRef = editSource;
        if (safeRef) {
          const comp = await generateRoutes.compressReferenceImage(safeRef, 1024, 80);
          if (comp) safeRef = comp;
        }
        // Edição de imagem anexada: passa uma INSTRUÇÃO explícita em inglês para o
        // modelo de edição (Nano Banana/Gemini) entender que é uma edição da FOTO
        // enviada, preservando o sujeito/pessoa — não uma cena nova.
        let editPrompt = finalPrompt;
        if (safeRef && !cmd.replace_prompt) {
          const delta = (cmd.prompt_delta || message || '').trim();
          const preserve = /(person|pessoa|pessoas|people|retrato|rosto|pessoa na|nela|nele)/i.test(message) || /(person)/i.test(delta)
            ? ' Keep the SAME person(s), same face, identity, pose, clothing, body and background exactly as in the source image (only apply the requested change).'
            : ' Edit this exact photo/image, keeping the main subject, composition and style as in the source image unless the user asked to change them.';
          editPrompt = `Edit the attached source image as requested: ${delta}.${preserve}`;
        }
        if (refCount > 0) editPrompt += '\n' + multiRefDesignRules(paletteBlock);
        // 👁️ VISÃO: descreve o que as imagens anexadas mostram, para o gerador saber
        // o que já existe nelas (textos, preço, nome, cores) e não inventar por cima.
        const descLines = (session.memory.refDescriptions || []).map((d) => d.caption).filter(Boolean).slice(0, 3);
        if (descLines.length) {
          editPrompt += '\nREFERENCE CONTENT (what the attached images literally show, keep/respect it): ' + descLines.join(' | ');
          finalPrompt += '\nREFERENCE CONTENT (analysed): ' + descLines.join(' | ');
        }
        // "Refazer/recriar a peça" pede um LAYOUT novo (força maior). Um simples
        // "troque a cor" deve preservar a composição (força baixa).
        const wantsRedo = /(refaz\w*|recria\w*|recreate|redesign|nova vers|novo layout|refaça|do zero|do início)/i.test(message);
        const genStrength = wantsRedo ? 0.55 : 0.3;

        // 🧑🏻 MODO RETRATO: presets de estilo aplicados à selfie.
        // 1º tenta Magnific Mystic com structure_reference (preserva o rosto com força);
        // sem chave (ou em falha), cai no nano-banana instrucional mantendo a pessoa.
        if (isPortrait && safeRef) {
          // Formato vertical (3:4) por padrão — retrato; respeita pedido explícito.
          let rw = 768, rh = 1024;
          if (cmd.aspect_ratio === '9:16') { rw = 720; rh = 1280; }
          else if (cmd.aspect_ratio === '16:9') { rw = 1344; rh = 768; }
          else if (cmd.aspect_ratio === '1:1') { rw = 1024; rh = 1024; }
          const retPrompt = `${message}\n\nKeep the SAME person: exact face, eyes, nose, mouth, hair and identity from the source photo. Do not invent another face.`;
          try {
            const msUrl = await generateRoutes.generateImageMystic(retPrompt, {
              width: rw,
              height: rh,
              resolution: '2k',
              referenceImage: safeRef,
              structureStrength: 60
            });
            if (msUrl) imageUrl = msUrl;
          } catch (e) {
            console.error('Cérebro Visual: retrato Mystic falhou (tentando nano-banana):', e.message);
          }
          if (!imageUrl) {
            imageUrl = await generateRoutes.generateImageFromProviders(
              `Apply this style to the person in the attached photo, strictly preserving their exact face, eyes and identity: ${message}`,
              { width: rw, height: rh, referenceImage: safeRef, strength: 0.75 }
            );
          }
        } else if (swapRequested) {
          // 🔀 TRANSPLANTE: manda AS DUAS imagens (base + a que tem o elemento certo)
          // e instrui uma troca LOCAL precisa — mantendo todo o resto da base intacto.
          const sourceRef = session.memory.refImages[1] || session.memory.refImages[session.memory.refImages.length - 1] || editSource;
          let safeBase = editSource;
          let safeSource = sourceRef;
          try {
            const cb = await generateRoutes.compressReferenceImage(safeBase, 1024, 80);
            if (cb) safeBase = cb;
            const cs = await generateRoutes.compressReferenceImage(safeSource, 1024, 80);
            if (cs) safeSource = cs;
          } catch (err) {
            console.error('Cérebro Visual: compressão p/ transplante falhou:', err.message);
          }
          const thing = swapThing || 'item';
          const swapEdit = [
            'The FIRST attached image is the base design/photo. The SECOND attached image contains the object the user wants to use.',
            `Replace the "${thing}" visible in the FIRST image with the "${thing}" from the SECOND image — matching its exact shape, color, material, size and lighting to fit the base scene naturally.`,
            'Keep the layout, other objects, backgrounds, texts, prices, names and logo in the FIRST image EXACTLY as they are.',
            'This is a precise LOCAL swap: do NOT recreate, redesign or reposition anything else.'
          ].join(' ');
          cmd.reply = `Entendi 🎯 — vou trocar ${swapThing ? `a(o) "${swapThing}"` : 'o elemento'} do design pela versão da segunda imagem, mantendo todo o resto igual.`;
          imageUrl = await generateRoutes.generateImageFromProviders(swapEdit, {
            width,
            height,
            referenceImage: [safeBase, safeSource],
            strength: 0.5
          });
        } else {
          imageUrl = await generateRoutes.generateImageFromProviders(editPrompt, {
            width,
            height,
            referenceImage: safeRef,
            strength: genStrength
          });
        }

        // 5x) Auto-logo pós-geração: recria o design e sobrepõe a logo EXATA (PNG,
        //     fundo removido) num canto — a IA faz tudo sozinha, sem o usuário desenhar.
        if (imageUrl && smartLogo && !onlyPlace) {
          try {
            const pos = cornerPosition(message);
            const logoClean = (await logo.removeLogoBackground(smartLogo.logoImg)) || smartLogo.logoImg;
            const withLogo = await logo.compositeLogo(imageUrl, logoClean, pos);
            if (withLogo) {
              imageUrl = withLogo;
              cmd.reply = `Pronto! Usei suas imagens de forma inteligente: recriei o design nas cores da sua marca e coloquei a logo (recortada, sem o fundo) no ${POS_LABEL[pos]}.`;
            }
          } catch (e2) {
            console.error('Cérebro Visual: auto-logo (refazer) falhou:', e2.message);
          }
        }
      } catch (e) {
        console.error('Cérebro Visual: geração falhou:', e.message);
      }
    }

    if (!imageUrl) {
      await prisma.generation.update({ where: { id: generation.id }, data: { status: 'FAILED' } });
      await refundCredits(user);
      return res.status(502).json({
        error: 'Não foi possível gerar a nova imagem agora. Tente novamente.',
        code: 'GEN_FAILED'
      });
    }

    // 5a1) AUTO-CORREÇÃO: QA rigoroso na imagem final. Se o modelo "alucinou" (mãos
    //      deformadas, texto ilegível, cortes), refaz UMA vez automaticamente com a
    //      instrução de correção, sem cobrar 2ª vez. Nunca refaz em casos determinísticos
    //      (logotipo só colocado) nem quando a falha é de estilo (QA só reprova defeitos).
    const qaDone = await vision.checkImageQuality(imageUrl);
    if (qaDone && !qaDone.ok && !onlyPlace && !isPortrait) {
      console.warn('Cérebro Visual: QA reprovou a imagem, refazendo automaticamente →', qaDone.reason);
      await refundCredits(user);
      await consumeCredit(user);
      try {
        const ref0 = session.memory.refImages[0];
        const retryRef = ref0 ? await generateRoutes.compressReferenceImage(ref0, 1024, 80) : undefined;
        const fixPrompt = `${finalPrompt}\n\nFix the flaws of the previous attempt: ${qaDone.reason}. Keep everything else identical.`;
        const retryUrl = await generateRoutes.generateImageFromProviders(fixPrompt, {
          width,
          height,
          referenceImage: retryRef,
          strength: 0.6
        });
        if (retryUrl) imageUrl = retryUrl;
      } catch (err) {
        console.error('Cérebro Visual: auto-correção falhou (mantendo imagem):', err.message);
      }
    }

    // 5b) REALCE DE QUALIDADE (Magnific Mystic — opcional, pago). Só quando o usuário
    //     pedir explicitamente "melhorar/realçar/mais detalhe" e MAGNIFIC_API_KEY existir.
    //     Re-processa a imagem final em 2K mantendo estrutura (referência = resultado).
    const wantsEnhance = /(melhorar|real[çc]ar|hiper[- ]?realista|mais detalhe|alta qualidade|ultra[- ]?realista|upscale|restaurar|dar um toque profissional)/i.test(message);
    if (imageUrl && wantsEnhance && process.env.MAGNIFIC_API_KEY) {
      try {
        const enhUrl = await generateRoutes.generateImageMystic(
          'Restore and upscale this image to ultra-high 4K resolution. Maximize sharpness and extreme clarity. Enhance every detail while strictly preserving the original identity, colors, and composition — and keep every visible text exactly as is (prices, names, words). Add hyper-realistic textures, realistic skin pores (if a person), and crisp edges. Remove all blur, noise, and compression artifacts. 4K UHD, HDR, professional studio quality, extreme detail, sharp focus.',
          {
            width,
            height,
            resolution: '4k',
            referenceImage: imageUrl,
            structureStrength: 55
          }
        );
        if (enhUrl) {
          imageUrl = enhUrl;
          cmd.reply = `${cmd.reply || 'Pronto!'} Apliquei um realce de alta qualidade (2K).`;
        }
      } catch (e) {
        console.error('Cérebro Visual: realce Mystic falhou (mantendo imagem):', e.message);
      }
    }

    // 5b2) LEGENDA PRONTA: depois de gerar a peça, entrega 3 legendas de Instagram
    //      + CTA + hashtags no próprio chat (texto barato, não quebra se falhar).
    if (imageUrl && process.env.LLM_API_KEY) {
      try {
        const caps = await generateCaptions(finalPrompt, session.memory.project);
        if (caps && caps.trim()) {
          cmd.reply = `${cmd.reply || 'Pronto!'}\n\n${caps}`;
        }
      } catch (e) {
        console.error('Legendas prontas falhou (seguindo):', e.message);
      }
    }

    // 6) Sucesso: registra na memória e devolve tudo
    await prisma.generation.update({
      where: { id: generation.id },
      data: { status: 'COMPLETED', imageUrl }
    });

    session.memory.baseImage = imageUrl;
    if (session.memory.refImages[0]) session.memory.refImages[0] = imageUrl;
    session.memory.edits.push({
      message,
      delta: cmd.prompt_delta,
      replaced: !!cmd.replace_prompt,
      reply: cmd.reply,
      ts: Date.now()
    });
    cerebro.pushHistory(session, 'assistant', cmd.reply, imageUrl);

    const credits = await prisma.user.findUnique({
      where: { id: user.id },
      select: { creditsImages: true, creditsVideos: true, creditsPurchased: true }
    });

    res.json({
      success: true,
      sessionId: session.id,
      reply: cmd.reply,
      imageUrl,
      prompt: finalPrompt,
      fromLLM: !!cmd.fromLLM,
      memory: session.memory,
      history: session.history.slice(-20),
      credits
    });
  } catch (err) {
    console.error('Erro no Cérebro Visual:', err.message);
    res.status(500).json({ error: 'Erro interno ao processar o comando.' });
  }
});

// GET /api/cerebro/memoria/:sessionId — recompõe o chat (histórico + memória)
router.get('/memoria/:sessionId', authMiddleware, async (req, res) => {
  const session = cerebro.getSession(req.user.id, req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  res.json({
    sessionId: session.id,
    memory: session.memory,
    history: session.history.slice(-20),
    updatedAt: session.updatedAt
  });
});

// POST /api/cerebro/reset/:sessionId — limpa a memória da sessão
router.post('/reset/:sessionId', authMiddleware, (req, res) => {
  const removed = cerebro.resetSession(req.user.id, req.params.sessionId);
  res.json({ success: removed });
});

// GET /api/cerebro/sessions — lista sessões do usuário (para "continuar conversa")
router.get('/sessions', authMiddleware, (req, res) => {
  const sessions = cerebro.listSessions(req.user.id).map((s) => {
    const last = [...s.history].reverse().find((h) => h.role === 'assistant');
    return {
      id: s.id,
      updatedAt: s.updatedAt,
      lastImage: last ? last.imageUrl : null,
      lastMessage: last ? last.message : null,
      messages: s.history.length,
      edits: s.memory.edits.length
    };
  });
  res.json({ sessions });
});

module.exports = router;