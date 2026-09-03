const express = require('express');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const { authMiddleware } = require('../middleware');
const generateRoutes = require('./generate');
const { parseEditRequest, enhanceImagePrompt, replyConversation, detectIntent } = require('../llm');
const cerebro = require('../cerebro');
const logo = require('../logo');

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
}

async function refundCredits(user) {
  await prisma.user.update({
    where: { id: user.id },
    data: { creditsPurchased: { increment: 1 } }
  });
}

// POST /api/cerebro/chat — interpreta o comando e gera a nova versão da imagem
// Aceita: message, sessionId, image (principal, dataURL/string) ou images: [urls/dataURLs] (até 4)
router.post('/chat', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { sessionId, message, image, images } = req.body || {};
    const user = req.user;

    if (!message || message.trim().length < 2) {
      return res.status(400).json({ error: 'Digite o que quer mudar na imagem.' });
    }

    const totalImageCredits = user.creditsImages + user.creditsPurchased;
    if (totalImageCredits <= 0) {
      return res.status(403).json({ error: 'Créditos esgotados', code: 'NO_CREDITS', upgradeUrl: '/plans' });
    }

    const sid = typeof sessionId === 'string' && sessionId ? sessionId : cerebro.newSessionId();
    const session = cerebro.getOrCreateSession(user.id, sid);

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

    // 0) AGENTE conversacional: se o pedido é só uma conversa/dúvida (não é uma ação
    //     de criação/edição/vídeo), responde como chat normal SEM gastar crédito.
    const intent = detectIntent(message, session.memory);
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

    // 2) Registrar o pedido no histórico
    cerebro.pushHistory(session, 'user', message, null);

    // 2a) Estamos coletando resposta de uma pergunta anterior → este comando é a
    //     resposta; consumimos o estado de coleta.
    const wasCollecting = session.memory.collecting;
    const pendInfo = session.memory.pending;
    if (wasCollecting) session.memory.collecting = null;
    session.memory.pending = null;

    // Se a pergunta era para criar uma peça nova do zero, tratamos a resposta como
    // a especificação dessa peça e forçamos a geração (replace_prompt com o que o
    // usuário respondeu + identidade projetual já coletada).
    if (wasCollecting && pendInfo && pendInfo.creating) {
      const proj = session.memory.project || {};
      const ctx = [];
      if (proj.brand) ctx.push(`${proj.brand}`);
      if (proj.colors && proj.colors.length) ctx.push(`paleta: ${proj.colors.join(', ')}`);
      if (proj.style) ctx.push(`estilo: ${proj.style}`);
      if (proj.objective) ctx.push(`objetivo: ${proj.objective}`);
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
      session.memory.pending = {
        ask: cmd.ask,
        askedAt: Date.now(),
        creating: !!cmd.replace_prompt // é criação de peça nova → a resposta deve gerar
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

    // 2d) AGENTE: pedido de vídeo → interpreta e gera image-to-video a partir da imagem
    //     anexada (ou da última gerada). O Cérebro decide o movimento pelo pedido.
    const isVideoRequest = /\b(v[íi]deo|anima[çc][ãa]o|anima\w*|transforma?\s*em\s*(v[íi]deo|anima)|faz\s*um\s*(v[íi]deo|anima)|tour\s*360|360\s*graus|cena\s*em\s*movimento|imagem\s*em\s*movimento|movimenta\w*)\b/i.test(message);
    if (isVideoRequest) {
      const videoSource = session.memory.refImages[0] || session.memory.baseImage;
      if (!videoSource) {
        cerebro.pushHistory(session, 'assistant', 'Para criar um vídeo, envie antes a imagem (foto) que quer transformar em vídeo.', null);
        return res.json({ success: true, sessionId: session.id, reply: 'Para criar um vídeo, envie antes a imagem (foto) que quer transformar em vídeo.', imageUrl: null, videoUrl: null, memory: session.memory, history: session.history.slice(-20) });
      }
      if (user.creditsVideos <= 0 && user.creditsPurchased <= 0) {
        return res.status(403).json({ error: 'Créditos de vídeo esgotados. Assine o plano para gerar vídeos.', code: 'NO_CREDITS', upgradeUrl: '/plans' });
      }

      const generation = await prisma.generation.create({
        data: { userId: user.id, type: 'VIDEO', prompt: '[agente-video] ' + message.slice(0, 200), status: 'PROCESSING', cost: 1 }
      });
      const usedPurchased = user.creditsPurchased > 0;
      if (usedPurchased) {
        await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: 1 } } });
      } else {
        await prisma.user.update({ where: { id: user.id }, data: { creditsVideos: { decrement: 1 } } });
      }

      const motion = /\btour\b|\b360\b|giro|rota|circular|panoram/i.test(message) ? 'orbit' : (/andar|caminhar|andar em dire|personagem se move|ele anda/i.test(message) ? 'walk' : 'subtle');
      try {
        const videoUrl = await generateRoutes.generateVideoFal(videoSource, `create a smooth cinematic ${motion === 'orbit' ? '360-degree rotating view' : motion === 'walk' ? 'walking movement' : 'subtle lifelike motion'} of this image`, motion, {});
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
        data: usedPurchased ? { creditsPurchased: { increment: 1 } } : { creditsVideos: { increment: 1 } }
      });
      return res.status(502).json({ error: 'Não foi possível gerar o vídeo agora. Tente novamente.', code: 'GEN_FAILED' });
    }

    // 3) Compor o prompt técnico acumulado (memória fotográfica da conversa)
    let finalPrompt = cerebro.composePrompt(session.memory, cmd, message);
    const { width, height } = cerebro.aspectSizes(cmd.aspect_ratio || null);

    // 3b) Nova imagem do zero: reescreve o pedido em prompt profissional estilo ChatGPT.
    //     Isso transforma pedidos vagos/absurdos em imagens de alta qualidade.
    if (cmd.replace_prompt) {
      try {
        // Inclui o contexto de projeto (marca/cores/estilo) na reescrita para que a
        // nova imagem nasça já coerente com a identidade visual construída.
        const enh = await enhanceImagePrompt(cmd.new_prompt || message, {
          project: session.memory.project
        });
        if (enh.prompt) {
          finalPrompt = enh.prompt;
          session.memory.currentPrompt = enh.prompt;
          if (enh.reply) cmd.reply = enh.reply;
        }
      } catch (e) {
        console.error('Cérebro Visual: enhance de prompt falhou (usando prompt original):', e.message);
      }
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

    // 5) Gerar a nova versão — usa a base original (ou 1ª das até 4 referências) como
    // entrada real de image-to-image (remover pessoa, trocar cor, colocar logo, etc)
    let imageUrl = null;
    const editSource = session.memory.refImages[0] || session.memory.baseImage || undefined;

    // 5b) Logo real: se o usuário pediu logo E enviou 2+ imagens, a 2ª é a logo.
    //      Sobreposição exata — garante "exatamente" a logo do cliente.
    if (isLogoRequest && logoImageAvailable) {
      try {
        const position = logo.detectLogoPosition(message);
        imageUrl = await logo.compositeLogo(session.memory.refImages[0], session.memory.refImages[1], position);
        if (imageUrl) {
          const label = { 'bottom-right': 'inferior direito', 'top-right': 'superior direito', 'bottom-left': 'inferior esquerdo', 'top-left': 'superior esquerdo', top: 'topo', bottom: 'inferior (base)', left: 'lado esquerdo', right: 'lado direito', center: 'centro' }[position] || 'inferior direito';
          cmd.reply = `Feito! Coloquei a sua logo (exatamente a imagem que você enviou) no ${label} da foto.`;
        }
      } catch (e) {
        console.error('Cérebro Visual: composição da logo falhou:', e.message);
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
          if (session.memory.refImages[0]) session.memory.refImages[0] = safeRef;
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
        imageUrl = await generateRoutes.generateImageFromProviders(editPrompt, {
          width,
          height,
          referenceImage: safeRef,
          strength: 0.3
        });
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