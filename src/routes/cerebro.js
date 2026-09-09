const express = require('express');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const { authMiddleware } = require('../middleware');
const generateRoutes = require('./generate');
const { parseEditRequest, enhanceImagePrompt, replyConversation, detectIntent } = require('../llm');
const cerebro = require('../cerebro');
const logo = require('../logo');
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
    const { sessionId, message, image, images } = req.body || {};
    const user = req.user;

    if (!message || message.trim().length < 2) {
      return res.status(400).json({ error: 'Digite o que quer mudar na imagem.' });
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
    const noRefForStrong = !(session.memory.refImages && session.memory.refImages.length > 0);
    if (intent === 'create' && noRefForStrong && !session.memory.collecting) {
      const projStrong = session.memory.project || {};
      const wantsBrandStrong = /(logo|logomarca|marca|identidade|assinatura)/i.test(message);
      const wantsObjStrong = /(banner|post|an[úu]cio|capa|cartaz|flyer|panfleto|p[ôo]ster|folder|comercial|campanha|publicidade|material|cart[ãa]o|impulso|story|logo|imagem|arte|arte final)/i.test(message) || /\b(para|destinado|voltado)\b/i.test(message);
      const qStrong = [];
      if (wantsBrandStrong && !projStrong.brand) qStrong.push('Qual é o nome/marca que deve aparecer na peça?');
      if (wantsObjStrong && !projStrong.objective) qStrong.push('Qual o objetivo/tipo da peça (ex: post p/ Instagram, banner, capa, cartaz, anúncio...)?');
      if (!(projStrong.colors && projStrong.colors.length)) qStrong.push('Quais cores devo usar (cores da sua marca ou preferência)?');
      if (qStrong.length) {
        const asksStrong = qStrong.slice(0, 2);
        cerebro.pushHistory(session, 'user', message, null);
        session.memory.pending = { ask: asksStrong, askedAt: Date.now(), creating: true };
        session.memory.collecting = true;
        const replyStrong = asksStrong.join('\n');
        cerebro.pushHistory(session, 'assistant', replyStrong, null);
        return res.json({
          success: true,
          sessionId: session.id,
          reply: replyStrong,
          ask: asksStrong,
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
    if (cmd.replace_prompt) {
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

    if (session.memory.refImages.length >= 2) {
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
        // "Refazer/recriar a peça" pede um LAYOUT novo (força maior). Um simples
        // "troque a cor" deve preservar a composição (força baixa).
        const wantsRedo = /(refaz\w*|recria\w*|recreate|redesign|nova vers|novo layout|refaça|do zero|do início)/i.test(message);
        const genStrength = wantsRedo ? 0.55 : 0.3;
        imageUrl = await generateRoutes.generateImageFromProviders(editPrompt, {
          width,
          height,
          referenceImage: safeRef,
          strength: genStrength
        });

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