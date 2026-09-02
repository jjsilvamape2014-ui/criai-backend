const express = require('express');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const { authMiddleware } = require('../middleware');
const generateRoutes = require('./generate');
const { parseEditRequest } = require('../llm');
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

    // 1) Entender o que o usuário quer (LLM se houver saldo, senão heurística)
    let cmd;
    try {
      cmd = await parseEditRequest(message, session.memory);
    } catch (e) {
      console.error('Falha ao interpretar comando:', e.message);
      cmd = { reply: 'Entendi! Vou ajustar a imagem.', prompt_delta: null, replace_prompt: false, strength: 0.65, aspect_ratio: null, fromLLM: false };
    }

    // 2) Registrar o pedido no histórico
    cerebro.pushHistory(session, 'user', message, null);

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

    // 3) Compor o prompt técnico acumulado (memória fotográfica da conversa)
    const finalPrompt = cerebro.composePrompt(session.memory, cmd, message);
    const { width, height } = cerebro.aspectSizes(cmd.aspect_ratio || null);

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
        imageUrl = await logo.compositeLogo(session.memory.refImages[0], session.memory.refImages[1], logo.detectLogoPosition(message));
      } catch (e) {
        console.error('Cérebro Visual: composição da logo falhou:', e.message);
      }
    }

    if (!imageUrl) {
      try {
        imageUrl = await generateRoutes.generateImageFromProviders(finalPrompt, {
          width,
          height,
          referenceImage: editSource,
          strength: cmd.strength
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