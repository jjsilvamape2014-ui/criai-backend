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
const adVideo = require('../adVideo');
const aiRouter = require('../router');

const router = express.Router();
const prisma = new PrismaClient();

// 🎬 VÍDEOS EM PRODUÇÃO: o anúncio leva de 1 a 6 min. O /chat responde na hora com
// um jobId e o front consulta /job/:id. O estado fica no BANCO (tabela generations,
// jobId = generation.id): sobrevive a reinício do servidor e funciona com mais de
// uma instância. Na memória fica só o texto do progresso (opcional).
const AD_TAG = '[anuncio-video';
const JOB_STEPS = new Map(); // generationId → { step, reply, credits, error, at }
function setStep(id, patch) {
  JOB_STEPS.set(id, { ...(JOB_STEPS.get(id) || {}), ...patch, at: Date.now() });
  for (const [k, j] of JOB_STEPS) if (Date.now() - j.at > 2 * 3600 * 1000) JOB_STEPS.delete(k);
}

// Custo por estilo, em créditos de vídeo (o comercial com apresentador usa bem mais
// IA: ~4 imagens, 4 vozes, 2 lipsync e 2 animações). Plano PREMIUM não é cobrado.
function adCost(style) {
  const raw = style === 'presenter' ? process.env.AD_PRESENTER_CREDITS || 3 : process.env.AD_VIDEO_CREDITS || 1;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Tira do comprado primeiro, depois do mensal. Devolve { p, v } para o estorno.
async function chargeVideoCredits(user, cost) {
  if (user.plan === 'PREMIUM') return { p: 0, v: 0 };
  const p = Math.min(user.creditsPurchased || 0, cost);
  const v = cost - p;
  await prisma.user.update({ where: { id: user.id }, data: { creditsPurchased: { decrement: p }, creditsVideos: { decrement: v } } });
  return { p, v };
}

async function refundVideoCredits(userId, charge) {
  if (!charge || (!charge.p && !charge.v)) return;
  await prisma.user.update({ where: { id: userId }, data: { creditsPurchased: { increment: charge.p }, creditsVideos: { increment: charge.v } } });
}

// "[anuncio-video p=1 v=2] ..." → { p, v }; formato antigo "[anuncio-video] ..." → 1 crédito mensal
function chargeFromPrompt(prompt, plan) {
  const m = String(prompt || '').match(/^\[anuncio-video p=(\d+) v=(\d+)\]/);
  if (m) return { p: Number(m[1]), v: Number(m[2]) };
  return plan === 'PREMIUM' ? { p: 0, v: 0 } : { p: 0, v: 1 };
}

// Vídeo que ficou "em produção" porque o servidor reiniciou no meio: marca como
// falho e devolve o crédito. Só mexe nos que passaram do tempo máximo (15 min),
// para não pegar um vídeo que outra instância ainda está produzindo.
async function recoverStaleAdJobs() {
  try {
    const stale = await prisma.generation.findMany({
      where: { type: 'VIDEO', status: 'PROCESSING', prompt: { startsWith: AD_TAG }, createdAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
      include: { user: { select: { plan: true } } },
      take: 50
    });
    for (const g of stale) {
      const upd = await prisma.generation.updateMany({ where: { id: g.id, status: 'PROCESSING' }, data: { status: 'FAILED' } });
      if (upd.count) await refundVideoCredits(g.userId, chargeFromPrompt(g.prompt, g.user && g.user.plan));
    }
    if (stale.length) console.log(`Cérebro: ${stale.length} vídeo(s) interrompido(s) marcados como falhos e estornados`);
  } catch (e) {
    console.error('Cérebro: recuperação de vídeos interrompidos falhou:', e.message);
  }
}
setTimeout(recoverStaleAdJobs, 20 * 1000).unref();
setInterval(recoverStaleAdJobs, 10 * 60 * 1000).unref();

// Mensagem que pede mudança no vídeo que acabou de sair (sem ser um pedido novo)
function isAdAdjustment(message) {
  const m = String(message || '');
  const aboutVideo = /(v[íi]deo|an[úu]ncio|narra[çc][ãa]o|\bvoz\b|locu[çc][ãa]o|legenda|cena|m[úu]sica|final do)/i.test(m);
  const change = /(coloc|p[õo]e|p[oô]r\b|bot[ae]|fal[ae]|falar|diz|dizer|cit[ae]|mud[ae]|troc[ae]|tir[ae]|adicion|inclu|refa[zç]|aument|diminu|corrig|arrum|ajust|nome|telefone|whats|endere[çc]o|pre[çc]o|cor\b|cores|masculin|feminin|mais |menos |sem )/i.test(m);
  return aboutVideo && change;
}

// Dispara o pipeline do anúncio em segundo plano e responde na hora com o jobId.
// O roteador reescreve o pedido; telefone e preço do cliente não podem se perder nisso
function keepFacts(request, message) {
  const digits = (x) => String(x || '').replace(/\D/g, '');
  const extra = [];
  for (const m of String(message || '').match(/\(?\d{2}\)?[\s-]*9?\d{4}[-\s.]?\d{4}/g) || []) {
    if (!digits(request).includes(digits(m).slice(-8))) extra.push(`WhatsApp ${m.trim()}`);
  }
  for (const m of String(message || '').match(/R\$\s*\d[\d.,]*/g) || []) {
    if (!String(request).includes(m.trim())) extra.push(m.trim());
  }
  return extra.length ? `${request}. ${extra.join('. ')}` : request;
}

// Troca a marca da conversa. Se for OUTRA empresa, apaga o que era da anterior
// (contato, cores, fatos, último vídeo) para nada vazar de um cliente para outro.
function switchBrand(session, brand, { keepRefs = null } = {}) {
  const { norm, isGenericBrand } = require('../brandInfo');
  if (!brand || isGenericBrand(brand)) return;
  const p = (session.memory.project = session.memory.project || {});
  const { mentions } = require('../brandInfo');
  // mesma empresa escrita de outro jeito ("JN" / "JN Refrigeração Ltda") → mantém tudo
  if (p.brand && (norm(p.brand) === norm(brand) || mentions(brand, p.brand) || mentions(p.brand, brand))) return;
  const other = !!p.brand;
  p.brand = brand;
  if (other) {
    p.facts = [];
    p.colors = [];
    session.memory.lastAdRequest = null;
    // imagens do cliente anterior (a placa não pode virar a pizza do próximo)
    const keep = new Set(keepRefs || []);
    session.memory.refImages = (session.memory.refImages || []).filter((r) => keep.has(r));
    session.memory.refDescriptions = (session.memory.refDescriptions || []).filter((d) => keep.has(d.src));
    if (!keep.has(session.memory.baseImage)) session.memory.baseImage = session.memory.refImages[0] || null;
  }
}

// Pedido genérico ("vídeo de apresentação da empresa") sem saber NADA da empresa
// (sem nome, sem fatos e sem conseguir ler as imagens) → pergunta antes de gastar crédito.
// Um vídeo com "[Nome da empresa]" ou frases vazias é pior do que uma pergunta.
function knowsNothing(request, session) {
  const mem = session.memory || {};
  const p = mem.project || {};
  if ((p.brand && !require('../brandInfo').isGenericBrand(p.brand)) || (p.facts && p.facts.length)) return false;
  if ((mem.refDescriptions || []).some((d) => d && d.caption)) return false;
  const stripped = String(request || '').replace(/\b(apresenta[çc][ãa]o|institucional|empresa|neg[óo]cio|marca|loja|logo(marca)?|nossa|nosso|minha|meu|dela|dele|sobre|essa|esse|desta|deste|dessa|desse|foto|imagem|anexo|anexada?)\b/gi, ' ');
  return adVideo.needsAdBriefing(stripped, p, false);
}

async function startAdVideoJob({ user, session, request, displayMessage, res, adjusting = false, briefed = false }) {
  if (!adjusting && !briefed && knowsNothing(request, session)) {
    const hasImg = (session.memory.refImages || []).length > 0;
    const q = (hasImg ? 'Não consegui ler o nome na imagem que você enviou. ' : '') +
      'Para o vídeo ficar com a cara da sua empresa, me diga em uma mensagem: o nome da empresa, o que ela faz (serviços ou produtos) e o WhatsApp. Se tiver, a cidade e uma promoção também.';
    session.memory.pendingAd = { request, askedAt: Date.now() };
    cerebro.pushHistory(session, 'user', displayMessage || request, null);
    cerebro.pushHistory(session, 'assistant', q, null);
    return res.json({ success: true, sessionId: session.id, reply: q, ask: [q], needInfo: true, imageUrl: null, videoUrl: null, type: 'video', memory: session.memory, history: session.history.slice(-20) });
  }
  const style = adVideo.pickStyle(request);
  const cost = user.plan === 'PREMIUM' ? 0 : adCost(style);
  if (user.plan !== 'PREMIUM' && (user.creditsVideos || 0) + (user.creditsPurchased || 0) < cost) {
    return res.status(403).json({
      error: cost > 1
        ? `O vídeo com apresentador usa ${cost} créditos de vídeo e você tem ${(user.creditsVideos || 0) + (user.creditsPurchased || 0)}.` +
          ((user.creditsVideos || 0) + (user.creditsPurchased || 0) >= adCost('motion')
            ? ' Com o que você tem dá para fazer a versão animada (com narração): é só pedir "faz a versão animada". Ou assine o plano para ter mais créditos.'
            : ' Assine o plano ou compre créditos para continuar.')
        : 'Créditos de vídeo esgotados. Assine o plano para gerar vídeos.',
      code: 'NO_CREDITS', upgradeUrl: '/plans'
    });
  }
  // guarda como falar os nomes (vale para os próximos vídeos da conversa) e o pedido,
  // para refazer quando o cliente corrigir uma pronúncia
  const pron = require('../speech').parsePronunciations(request);
  if (Object.keys(pron).length) {
    session.memory.project = session.memory.project || {};
    session.memory.project.pronunciations = { ...(session.memory.project.pronunciations || {}), ...pron };
  }
  session.memory.lastAdRequest = request;

  const charge = await chargeVideoCredits(user, cost);
  let generation;
  try {
    generation = await prisma.generation.create({
      data: { userId: user.id, type: 'VIDEO', prompt: `${AD_TAG} p=${charge.p} v=${charge.v}] ` + request.slice(0, 200), status: 'PROCESSING', cost: Math.max(1, cost) }
    });
  } catch (e) {
    await refundVideoCredits(user.id, charge).catch(() => {});
    throw e;
  }
  const jobId = generation.id;
  setStep(jobId, { step: 'Começando…' });
  // Foto do produto: só imagens de verdade (nunca um vídeo gerado antes)
  const productImage = (session.memory.refImages || []).find((u) => typeof u === 'string' && !/^data:video|\.mp4(\?|$)/i.test(u)) || null;
  const current = new Set(session.memory.refImages || []);
  const refCaptions = (session.memory.refDescriptions || []).filter((d) => current.has(d.src)).map((d) => d.caption).filter(Boolean).slice(-2);

  const presenter = style === 'presenter';
  const costNote = cost > 1 ? ` Este vídeo usa ${cost} créditos de vídeo.` : '';
  const reply = adjusting
    ? `Certo! Vou refazer o vídeo com esse ajuste. Leva de ${presenter ? '3 a 6' : '1 a 4'} minutos — pode acompanhar aqui.${costNote}`
    : presenter
    ? `Entendi: um comercial com apresentador. Vou escrever o roteiro, criar a pessoa${productImage ? ' segurando o produto da sua foto' : ''}, gravar as falas com a boca sincronizada e montar com a tela final da sua marca. Leva de 3 a 6 minutos — pode acompanhar aqui.${costNote}`
    : '🎬 Entendi: um anúncio em vídeo' + (adVideo.wantsVoice(request) ? ' com narração' : '') +
      `. Vou escrever o roteiro, ${adVideo.wantsVoice(request) ? 'gravar a voz, ' : ''}criar as cenas e montar tudo${productImage ? ' usando a imagem que você enviou' : ''}. Leva de 1 a 4 minutos — pode acompanhar aqui.${costNote}` +
      (session.memory.project && session.memory.project.brand ? `\n\nEmpresa: ${session.memory.project.brand}. Se for outra, me diga o nome que eu refaço.` : '');
  cerebro.pushHistory(session, 'user', displayMessage || request, null);
  cerebro.pushHistory(session, 'assistant', reply, null);

  (async () => {
    try {
      const out = await adVideo.buildAd({
        request,
        project: session.memory.project,
        images: session.memory.refImages || [],
        refCaptions,
        deps: {
          generateImageFromProviders: generateRoutes.generateImageFromProviders,
          generateVideoFromProviders: generateRoutes.generateVideoFromProviders,
          compressReferenceImage: generateRoutes.compressReferenceImage
        },
        onStatus: (t) => setStep(jobId, { step: t })
      });
      const scenesTxt = out.scenes.map((s, i) => `${i + 1}. ${s.caption}`).join('\n');
      const styleName = { motion: 'animado', photo: 'com fotos', presenter: 'com apresentador' }[out.style] || '';
      const done = `Pronto! Seu anúncio ${styleName} (${out.format}) está aqui.` +
        (out.notes && out.notes.length ? `\n\nAntes de publicar:\n${out.notes.map((n) => `• ${n}`).join('\n')}` : '') +
        (out.narration ? `\n\n🎙️ Narração:\n“${out.narration}”` : '') +
        `\n\n🎞️ Cenas:\n${scenesTxt}` +
        (out.style === 'presenter'
          ? '\n\nQuer trocar para apresentador homem/mulher, mudar as falas ou mostrar outro produto (envie a foto)? É só pedir. Se algum nome saiu com a pronúncia errada, diga como se fala (ex.: "XYZ, pronuncia xis ípsilon zê").'
          : out.style === 'motion'
          ? '\n\nQuer outra cor, voz masculina, ou uma versão com fotos realistas ("faz com fotos")? É só pedir. Dica: envie sua LOGO que ela entra no final do vídeo.'
          : '\n\nQuer mudar o texto da narração, a voz (masculina/feminina) ou o formato (horizontal/quadrado)? É só pedir.');
      if (out.brand) {
        session.memory.project = session.memory.project || {};
        if (!session.memory.project.brand) session.memory.project.brand = out.brand; // próximos pedidos já sabem
      }
      cerebro.pushHistory(session, 'assistant', done, null);
      session.history[session.history.length - 1].videoUrl = out.videoUrl; // renderiza como <video> ao reabrir
      await prisma.generation.update({ where: { id: jobId }, data: { status: 'COMPLETED', imageUrl: out.videoUrl } });
      const credits = await prisma.user.findUnique({ where: { id: user.id }, select: { creditsImages: true, creditsVideos: true, creditsPurchased: true } });
      setStep(jobId, { reply: done, credits, debug: out.debug || null });
    } catch (e) {
      console.error('Cérebro: anúncio em vídeo falhou:', e.stack || e.message);
      // mostra a etapa que falhou (sem chaves/URLs), para dar para diagnosticar sem os logs
      const detail = String(e.message || '').replace(/https?:\/\/\S+/g, '[url]').replace(/Key\s+\S+/gi, 'Key ***').slice(0, 160);
      // conta da fal sem saldo/bloqueada: o cliente não deve ver isso — mensagem educada
      const outOfBalance = /exhausted balance|user is locked|top up your balance|HTTP 402/i.test(String(e.message || ''));
      if (outOfBalance) console.error('⚠️ FAL SEM SALDO — recarregue em fal.ai/dashboard/billing');
      const { CODE_REV } = require('../version');
      setStep(jobId, { error: outOfBalance
        ? 'Nosso estúdio de vídeo está em manutenção por alguns instantes. Seu crédito foi devolvido — tente de novo em alguns minutos.'
        : `Não consegui montar o anúncio agora. Seu crédito foi devolvido — tente novamente.${detail ? ` (Detalhe técnico: ${detail} · versão ${CODE_REV})` : ''}` });
      try {
        const upd = await prisma.generation.updateMany({ where: { id: jobId, status: 'PROCESSING' }, data: { status: 'FAILED' } });
        if (upd.count) await refundVideoCredits(user.id, charge);
      } catch (e2) {}
    }
  })();

  return res.json({
    success: true,
    sessionId: session.id,
    reply,
    jobId,
    type: 'video_job',
    imageUrl: null,
    videoUrl: null,
    memory: session.memory,
    history: session.history.slice(-20)
  });
}

// A IA de vídeo só aceita imagens de proporção "normal" e tamanho mínimo. Logo larga
// (faixa) ou transparente falhava: aqui a imagem vai para uma tela aceita — fundo sólido,
// proporção entre 9:16 e 16:9 (larga demais → quadrado), lado menor >= 720 px.
async function prepareForVideo(src) {
  const sharp = require('sharp');
  const input = String(src).startsWith('data:')
    ? Buffer.from(String(src).split(',')[1] || '', 'base64')
    : Buffer.from((await require('axios').get(src, { responseType: 'arraybuffer', timeout: 30000 })).data);
  const base = sharp(input, { limitInputPixels: false }).rotate();
  const { width: w = 1024, height: h = 1024 } = await base.metadata();
  const flat = await base.flatten({ background: '#ffffff' }).toBuffer();
  const r = w / h;
  if (r >= 0.5625 && r <= 1.7778) {
    // proporção aceita: garante lado menor >= 720 e maior <= 1920
    const k = Math.min(Math.max(1, 720 / Math.min(w, h)), 1920 / Math.max(w, h));
    return sharp(flat).resize(Math.round(w * k), Math.round(h * k), { fit: 'fill' }).jpeg({ quality: 92 }).toBuffer();
  }
  // larga ou alta demais (ex.: logo em faixa): centraliza numa tela quadrada, fundo = cor do canto
  // estica a própria borda da imagem (sem retângulo visível de "cor parecida")
  const inner = await sharp(flat).resize(864, 864, { fit: 'inside' }).toBuffer();
  const m = await sharp(inner).metadata();
  const padX = Math.round((1080 - m.width) / 2), padY = Math.round((1080 - m.height) / 2);
  return sharp(inner)
    .extend({ left: padX, right: 1080 - m.width - padX, top: padY, bottom: 1080 - m.height - padY, extendWith: 'copy' })
    .jpeg({ quality: 92 }).toBuffer();
}

const hasImgEarly = (session) => (session.memory.refImages || []).length > 0;

// 🔤 LOGO: sem perguntas desnecessárias (nome e cor vêm do pedido) e com o nome sempre certo.
async function makeLogo({ user, session, message, display, res }) {
  const LM = require('../logoMaker');
  const name = LM.extractName(message);
  const quick = (text, extra = {}) => {
    cerebro.pushHistory(session, 'user', display || message, null);
    cerebro.pushHistory(session, 'assistant', text, null);
    return res.json({ success: true, sessionId: session.id, reply: text, imageUrl: null, videoUrl: null, type: 'chat', memory: session.memory, history: session.history.slice(-20), ...extra });
  };
  if (!name) {
    session.memory.pendingLogo = { message, at: Date.now() };
    return quick('Qual nome vai escrito na logo? (exatamente como deve aparecer, com acentos)', { ask: ['Qual nome vai escrito na logo?'], needInfo: true });
  }
  if (user.plan !== 'PREMIUM' && (user.creditsImages || 0) + (user.creditsPurchased || 0) <= 0) {
    return res.status(403).json({ error: 'Seus créditos de imagem acabaram. Assine o plano para criar mais.', code: 'NO_CREDITS', upgradeUrl: '/plans' });
  }
  const color = LM.extractColor(message) || { name: 'azul', hex: '#1d4ed8' };
  const charged = await consumeCredit(user);
  try {
    const A = adVideo._internals;
    const biz = LM.businessOf(message, name);
    const icon = biz ? LM.iconFor(biz) : null;
    const png = await LM.composeLogo({ name, hex: color.hex, icon });
    const imageUrl = await A.uploadToFal(png, 'image/png', `logo-${Date.now()}.png`).catch(() => `data:image/png;base64,${png.toString('base64')}`);
    await prisma.generation.create({ data: { userId: user.id, type: 'IMAGE', prompt: `[logo] ${name} ${color.name}`, status: 'COMPLETED', imageUrl, cost: 1 } }).catch(() => {});
    session.memory.project = session.memory.project || {};
    if (!session.memory.project.brand) session.memory.project.brand = name;
    session.memory.lastLogo = { message, at: Date.now() };
    const reply = `Pronto! Logo da ${name} em ${color.name}. O nome foi escrito com fonte profissional, então sai exatamente como você digitou.` +
      `${icon ? '' : ' Usei um monograma com as iniciais — se me disser o ramo da empresa (ex.: "é uma loja de roupas"), eu coloco um símbolo do ramo.'}\n\nQuer outra cor? É só pedir (ex.: "faz em verde").`;
    cerebro.pushHistory(session, 'user', display || message, null);
    cerebro.pushHistory(session, 'assistant', reply, imageUrl);
    const credits = await prisma.user.findUnique({ where: { id: user.id }, select: { creditsImages: true, creditsVideos: true, creditsPurchased: true } });
    return res.json({ success: true, sessionId: session.id, reply, imageUrl, type: 'image', memory: session.memory, history: session.history.slice(-20), credits });
  } catch (e) {
    console.error('Cérebro: logo falhou:', e.message);
    if (charged) await refundCredits(user).catch(() => {});
    return quick('Não consegui criar a logo agora. Seu crédito foi devolvido — tente de novo.');
  }
}

// ✍️ ENTREGA EM TEXTO (roteiro de vídeo, legenda, copy): JSON validado pelo contrato,
// sem renderizar e sem gastar crédito de vídeo.
async function deliverText({ user, session, message, tipo, res }) {
  const contract = require('../contract');
  const { callLLM } = require('../llm');
  cerebro.pushHistory(session, 'user', message, null);
  const current = new Set(session.memory.refImages || []);
  const captions = (session.memory.refDescriptions || []).filter((d) => current.has(d.src)).map((d) => d.caption).filter(Boolean).slice(-2);
  const w = await contract.writeText({ message, tipo, project: session.memory.project, callLLM, captions }).catch(() => null);
  const reply = w ? contract.formatText(w) : 'Não consegui escrever agora. Tente de novo em instantes.';
  if (w && tipo === 'roteiro_video') session.memory.lastScript = { request: message, text: reply };
  cerebro.pushHistory(session, 'assistant', reply, null);
  return res.json({ success: true, sessionId: session.id, reply, contract: w ? { status: 'ok', ...w } : { status: 'erro' }, imageUrl: null, videoUrl: null, type: 'chat', memory: session.memory, history: session.history.slice(-20) });
}

// 🌀 ANIMAR A IMAGEM: o cliente quer que algo DA IMAGEM se mexa ("a barriga do mascote
// girando como uma betoneira"). Não é anúncio: é image-to-video (Kling) da própria imagem,
// com um prompt de movimento preciso escrito pela IA. Custa 1 crédito de vídeo.
async function startAnimateJob({ user, session, message, motion, res }) {
  const cost = user.plan === 'PREMIUM' ? 0 : adCost('motion');
  if (user.plan !== 'PREMIUM' && (user.creditsVideos || 0) + (user.creditsPurchased || 0) < cost) {
    return res.status(403).json({ error: 'Créditos de vídeo esgotados. Assine o plano para animar imagens.', code: 'NO_CREDITS', upgradeUrl: '/plans' });
  }
  const image = (session.memory.refImages || [])[session.memory.refImages.length - 1];
  const prompt = [
    motion || `Animate exactly what the user asked: ${message}.`,
    'Keep the character/object identical to the image: same design, colors, text and proportions. Only the described part moves. Static camera. No new objects, no text added.'
  ].join(' ');
  const charge = await chargeVideoCredits(user, cost);
  let generation;
  try {
    generation = await prisma.generation.create({
      data: { userId: user.id, type: 'VIDEO', prompt: `${AD_TAG} p=${charge.p} v=${charge.v}] [animar] ` + String(message).slice(0, 180), status: 'PROCESSING', cost: Math.max(1, cost) }
    });
  } catch (e) {
    await refundVideoCredits(user.id, charge).catch(() => {});
    throw e;
  }
  const jobId = generation.id;
  const reply = '🌀 Entendi: vou animar a sua imagem com esse movimento, sem mudar o resto. Leva de 1 a 3 minutos — pode acompanhar aqui.';
  setStep(jobId, { step: 'Animando a sua imagem…' });
  cerebro.pushHistory(session, 'user', message, null);
  cerebro.pushHistory(session, 'assistant', reply, null);

  (async () => {
    try {
      const A = adVideo._internals;
      setStep(jobId, { step: 'Preparando a imagem…' });
      const buf = await prepareForVideo(image);
      const src = await A.uploadToFal(buf, 'image/jpeg', `animar-${Date.now()}.jpg`)
        .catch(() => `data:image/jpeg;base64,${buf.toString('base64')}`);
      setStep(jobId, { step: 'Animando a sua imagem (1 a 3 minutos)…' });
      const videoUrl = await generateRoutes.generateVideoFromProviders(src, prompt, 'custom', {});
      const done = 'Pronto! Sua imagem animada está aqui (5 segundos).\n\nSe o movimento não saiu como você imaginou, me diga o que mudar (ex.: "gira mais devagar", "só a barriga, os braços parados").';
      cerebro.pushHistory(session, 'assistant', done, null);
      session.history[session.history.length - 1].videoUrl = videoUrl;
      await prisma.generation.update({ where: { id: jobId }, data: { status: 'COMPLETED', imageUrl: videoUrl } });
      const credits = await prisma.user.findUnique({ where: { id: user.id }, select: { creditsImages: true, creditsVideos: true, creditsPurchased: true } });
      setStep(jobId, { reply: done, credits, debug: { motion: prompt } });
    } catch (e) {
      console.error('Cérebro: animar imagem falhou:', e.message);
      const outOfBalance = /exhausted balance|user is locked|top up your balance|HTTP 402|status code 403/i.test(String(e.message || ''));
      setStep(jobId, { error: outOfBalance
        ? 'Nosso estúdio de vídeo está em manutenção por alguns instantes. Seu crédito foi devolvido — tente de novo em alguns minutos.'
        : `Não consegui animar a imagem agora. Seu crédito foi devolvido — tente novamente. (Detalhe técnico: ${String(e.message || '').replace(/https?:\/\/\S+/g, '[url]').replace(/Key\s+\S+/gi, 'Key ***').slice(0, 160)})` });
      try {
        const upd = await prisma.generation.updateMany({ where: { id: jobId, status: 'PROCESSING' }, data: { status: 'FAILED' } });
        if (upd.count) await refundVideoCredits(user.id, charge);
      } catch (e2) {}
    }
  })();

  return res.json({ success: true, sessionId: session.id, reply, jobId, type: 'video_job', imageUrl: null, videoUrl: null, memory: session.memory, history: session.history.slice(-20) });
}

// 🗣️ PERSONAGEM FALANDO: a imagem anexada fala exatamente a frase do cliente.
// Usa lipsync (se aceitar o personagem) ou animação + voz. Custa 1 crédito de vídeo.
async function startSpeakJob({ user, session, message, speech, voice, res }) {
  const cost = user.plan === 'PREMIUM' ? 0 : adCost('motion');
  if (user.plan !== 'PREMIUM' && (user.creditsVideos || 0) + (user.creditsPurchased || 0) < cost) {
    return res.status(403).json({ error: 'Créditos de vídeo esgotados. Assine o plano para fazer o personagem falar.', code: 'NO_CREDITS', upgradeUrl: '/plans' });
  }
  const image = session.memory.refImages[session.memory.refImages.length - 1];
  const text = String(speech || '').replace(/^\s*(faz|faça|faca|deixa|coloca|cria)[^:]{0,80}:\s*/i, '').trim().slice(0, 400) || String(message).slice(0, 400);
  const charge = await chargeVideoCredits(user, cost);
  let generation;
  try {
    generation = await prisma.generation.create({
      data: { userId: user.id, type: 'VIDEO', prompt: `${AD_TAG} p=${charge.p} v=${charge.v}] [falar] ` + text.slice(0, 180), status: 'PROCESSING', cost: Math.max(1, cost) }
    });
  } catch (e) {
    await refundVideoCredits(user.id, charge).catch(() => {});
    throw e;
  }
  const jobId = generation.id;
  const reply = `🗣️ Entendi: o personagem da imagem vai falar “${text}”. Leva de 2 a 5 minutos — pode acompanhar aqui.`;
  setStep(jobId, { step: 'Gravando a fala…' });
  cerebro.pushHistory(session, 'user', message, null);
  cerebro.pushHistory(session, 'assistant', reply, null);

  (async () => {
    try {
      const A = adVideo._internals;
      const { speakable } = require('../speech');
      const pron = (session.memory.project && session.memory.project.pronunciations) || {};
      const out = await require('../characterSpeak').buildCharacterSpeech({
        image, speech: text, voice,
        deps: {
          tts: A.generateNarration, upload: A.uploadToFal, falQueue: A.falQueue, saveMedia: A.saveMedia, mediaDuration: A.mediaDuration,
          speakable: (t) => speakable(t, { pronunciations: pron }),
          animate: (img, prompt) => generateRoutes.generateVideoFromProviders(img, prompt, 'custom', {})
        },
        onStatus: (t) => setStep(jobId, { step: t })
      });
      const done = `Pronto! O personagem falando (${Math.round(out.duration)} segundos).` +
        (out.method === 'lipsync' ? '' : '\n\nObs.: a boca do personagem se mexe, mas não acompanha cada sílaba (personagem de desenho).') +
        '\n\nQuer mudar a fala, a voz (masculina/feminina) ou a pronúncia de algum nome? É só pedir.';
      cerebro.pushHistory(session, 'assistant', done, null);
      session.history[session.history.length - 1].videoUrl = out.videoUrl;
      await prisma.generation.update({ where: { id: jobId }, data: { status: 'COMPLETED', imageUrl: out.videoUrl } });
      const credits = await prisma.user.findUnique({ where: { id: user.id }, select: { creditsImages: true, creditsVideos: true, creditsPurchased: true } });
      setStep(jobId, { reply: done, credits, debug: { method: out.method, speech: text } });
    } catch (e) {
      console.error('Cérebro: personagem falando falhou:', e.message);
      setStep(jobId, { error: 'Não consegui fazer o personagem falar agora. Seu crédito foi devolvido — tente novamente.' });
      try {
        const upd = await prisma.generation.updateMany({ where: { id: jobId, status: 'PROCESSING' }, data: { status: 'FAILED' } });
        if (upd.count) await refundVideoCredits(user.id, charge);
      } catch (e2) {}
    }
  })();

  return res.json({ success: true, sessionId: session.id, reply, jobId, type: 'video_job', imageUrl: null, videoUrl: null, memory: session.memory, history: session.history.slice(-20) });
}

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

// POST /api/cerebro/route-check — o que o Cérebro FARIA com uma frase (sem gerar nada,
// sem gastar crédito): contrato + roteador de IA + correção. Para testar entendimento.
router.post('/route-check', authMiddleware, async (req, res) => {
  try {
    const message = String((req.body && req.body.message) || '').slice(0, 500);
    const hasImage = !!(req.body && req.body.hasImage);
    const contract = require('../contract');
    const fake = { memory: { project: {}, refImages: hasImage ? ['data:image/png;base64,'] : [], refDescriptions: hasImage && req.body.caption ? [{ src: 'data:image/png;base64,', caption: String(req.body.caption) }] : [] }, history: [] };
    const sp = contract.detectSpeech(message, hasImage);
    if (sp) return res.json({ message, final: 'speak', fala: sp.fala });
    const pre = contract.precheck({ message, knowsBusiness: false, hasImage });
    const requested = contract.detectRequested(message);
    const route = pre ? null : await aiRouter.routeMessage({ message, session: fake });
    const fix = route ? contract.enforce(route.action, message) : null;
    res.json({ message, precheck: pre, requested, router: route && { action: route.action, style: route.style, request: route.request }, final: pre ? 'perguntar' : (requested.tipo === 'roteiro_video' || requested.tipo === 'copy') ? 'texto' : fix ? fix.action : (route ? route.action : 'regras-antigas'), corrigido: !!(fix && fix.corrigido) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cerebro/vision-check — diagnóstico da leitura de imagens (fal e Groq), sem expor chaves
router.post('/vision-check', authMiddleware, async (req, res) => {
  try {
    const img = req.body && req.body.image;
    if (!img || typeof img !== 'string') return res.status(400).json({ error: 'envie image (dataURL)' });
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : []);
    res.json(await vision.diagnoseVision(img, { falEndpoints: arr(req.body.falEndpoints), groqModels: arr(req.body.groqModels) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cerebro/chat — interpreta o comando e gera a nova versão da imagem
// Aceita: message, sessionId, image (principal, dataURL/string) ou images: [urls/dataURLs] (até 4)
router.post('/chat', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { sessionId, image, images, portrait } = req.body || {};
    let message = (req.body || {}).message;
    const user = req.user;

    if (!message || message.trim().length < 2) {
      return res.status(400).json({ error: 'Digite o que quer mudar na imagem.' });
    }

    // Modo RETRATO: presets de estilo (neo-noir, capa de álbum etc.) aplicados numa
    // selfie mantendo o rosto. Vem por flag do app OU quando o texto é um preset.
    const isPortrait = !!(portrait || /(uploaded selfie|uploaded person|original reference image|the picture provided)/i.test(message || ''));

    const sid = typeof sessionId === 'string' && sessionId ? sessionId : cerebro.newSessionId();
    await cerebro.hydrate(user.id, sid).catch(() => null); // conversa salva no banco (sobrevive a deploys)
    const session = cerebro.getOrCreateSession(user.id, sid);

    // 🗂️ MEMÓRIA DE LONGO PRAZO: hidrata o projeto com o que o usuário já decidiu
    // em conversas anteriores (marca, cores, fatos). Tudo que ele repete nunca mais
    // precisa ser reexplicado — vale para qualquer sessão.
    const longMem = cerebro.loadUserMemory(user.id);
    if (longMem && !session.memory.onlyFromDisk) {
      const proj = session.memory.project;
      if (!proj.brand && longMem.brand && !require('../brandInfo').isGenericBrand(longMem.brand)) proj.brand = longMem.brand;
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

    // (O atalho antigo "como funciona" foi removido: ele interceptava pedidos como
    //  "vídeo explicando como funciona" e "cria imagem de…" com um texto pronto.
    //  Dúvidas de verdade agora são respondidas pelo roteador de IA.)

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
        const newCaps = [];
        for (const ref of pending) {
          const caption = await vision.describeReference(ref);
          if (caption) {
            newCaps.push(caption);
            session.memory.refDescriptions.push({ src: ref, caption });
            if (session.memory.refDescriptions.length > 8) {
              session.memory.refDescriptions = session.memory.refDescriptions.slice(-8);
            }
          }
        }
        // 🏷️ Logo NOVA de outra empresa → troca a marca (quem faz vídeo para vários clientes
        //    não pode receber o nome do cliente anterior)
        const logoCaps = newCaps.filter((c) => require('../adVideo').captionIsLogo(c));
        if (logoCaps.length) {
          const found = await require('../brandInfo').resolveBrand({ project: null, request: '', refCaptions: logoCaps }).catch(() => null);
          if (found) switchBrand(session, found, { keepRefs: pending });
        }
      }
    }

    // 🎬 ANÚNCIO EM VÍDEO (com voz): tem prioridade sobre TODO o fluxo de imagem.
    //    Antes, "vídeo de anúncio com voz" caía no gerador de imagem (que desenhava a
    //    palavra "voz"). Se o Cérebro perguntou algo antes, a intenção original fica
    //    guardada em memory.pendingAd e a resposta do usuário completa o briefing.
    // 🎛️ OPÇÃO ESCOLHIDA NA TELA: o cliente disse o que quer — nada de adivinhar.
    const MODES = ['anuncio', 'apresentador', 'animar', 'falar'];
    const mode = MODES.includes(req.body && req.body.mode) ? req.body.mode : null;
    if (mode) {
      session.memory.pendingAd = null;
      const f = (req.body && req.body.fields) || {};
      const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const empresa = clean(f.empresa, 60);
      const whatsapp = clean(f.whatsapp, 30);
      const hasImg = (session.memory.refImages || []).length > 0;
      const quick = (text) => {
        cerebro.pushHistory(session, 'user', message, null);
        cerebro.pushHistory(session, 'assistant', text, null);
        return res.json({ success: true, sessionId: session.id, reply: text, imageUrl: null, videoUrl: null, type: 'chat', memory: session.memory, history: session.history.slice(-20) });
      };
      if (empresa) switchBrand(session, empresa, { keepRefs: refsFromClient });
      if (mode === 'animar' || mode === 'falar') {
        if (!hasImg) return quick('Anexe a imagem (mascote, personagem, logo ou produto) para eu ' + (mode === 'falar' ? 'fazer ela falar.' : 'animar.'));
        if (mode === 'falar') return startSpeakJob({ user, session, message, speech: message, voice: f.voz === 'feminina' ? 'pf_dora' : 'pm_alex', res });
        const current = new Set(session.memory.refImages || []);
        const caps = (session.memory.refDescriptions || []).filter((d) => current.has(d.src)).map((d) => d.caption).filter(Boolean);
        return startAnimateJob({ user, session, message, motion: await aiRouter.motionPrompt(message, caps), res });
      }
      // anúncio: o pedido é montado com os campos; o estilo é o escolhido na tela
      const neutral = (t) => String(t).replace(/\bapresentand(o|a)\b/gi, 'mostrando').replace(/\bapresente\b/gi, 'mostre').replace(/\b(apresentador(a)?|avatar|influencer)\b/gi, '');
      let request = `Vídeo de anúncio${empresa ? ` da ${empresa}` : ''}: ${mode === 'apresentador' ? message : neutral(message)}${whatsapp ? `. WhatsApp ${whatsapp}` : ''}`;
      if (mode === 'apresentador') request += f.voz === 'masculina' ? ' (com apresentador homem)' : ' (com apresentadora)';
      return startAdVideoJob({ user, session, request, displayMessage: message, res, briefed: !!(empresa || whatsapp) });
    }

    // 🔤 Resposta à pergunta "qual nome vai na logo?"
    // 🔤 Ajuste da última logo: "é uma loja de roupas" (ramo → símbolo) ou "faz em verde" (cor)
    if (session.memory.lastLogo && !hasImgEarly(session) && message.split(/\s+/).length <= 12) {
      const LM = require('../logoMaker');
      const saysBiz = LM.businessOf(message, '') && /(^|\s)([ée]\s+(uma?|o|a)|ramo|trabalh\w*|somos|vend\w*)(\s|$)/i.test(message);
      const saysColor = LM.extractColor(message) && /\b(cor|em|faz|muda|troca|deixa|quero)\b/i.test(message);
      if (saysBiz || saysColor) {
        const base = session.memory.lastLogo.message.replace(saysColor ? new RegExp(`\\b(na cor|em|cor)?\\s*${(LM.extractColor(session.memory.lastLogo.message) || {}).name || '#none#'}\\b`, 'i') : /$^/, '');
        return makeLogo({ user, session, message: `${base.trim()}. ${message}`, display: message, res });
      }
    }
    if (session.memory.pendingLogo) {
      const orig = session.memory.pendingLogo.message;
      session.memory.pendingLogo = null;
      return makeLogo({ user, session, message: `${orig} com o nome "${message.replace(/["“”]/g, '').trim()}"`, display: message, res });
    }
    // 📜 Resposta a uma pergunta do contrato ("vídeo pronto ou só o texto?")
    if (session.memory.pendingContract) {
      const original = session.memory.pendingContract.message;
      session.memory.pendingContract = null;
      if (/\b(texto|legenda|roteiro|copy|escrito)\b/i.test(message) && !/\bv[íi]deo pronto\b/i.test(message)) {
        return deliverText({ user, session, message: original, tipo: /roteiro/i.test(original) ? 'roteiro_video' : 'copy', res });
      }
      const clean = original.replace(/,?\s*(mas\s+)?(me\s+)?(entregue\s+|mande\s+|quero\s+)?(s[óo]|apenas|somente)\s+(a\s+|o\s+)?(legenda|legendas|texto|copy|roteiro)[^.,]*/gi, '');
      return startAdVideoJob({ user, session, request: clean, displayMessage: message, res, briefed: true });
    }
    // quem respondeu "quero imagem" à pergunta do anúncio não pode cair no vídeo
    if (session.memory.pendingAd && /\b(imagem|post|arte|banner|flyer)\b/i.test(message) && !/\bv[íi]deo\b/i.test(message)) {
      message = `${session.memory.pendingAd.request}. ${message}`;
      session.memory.pendingAd = null;
    }
    if (session.memory.pendingAd) {
      const original = session.memory.pendingAd.request;
      session.memory.pendingAd = null;
      const dismissive = /(n[ãa]o sei|tanto faz|voc[êe] escolhe|vc escolhe|voc[êe] decide|faz do seu jeito)/i.test(message);
      const request = dismissive ? original : `${original}. Detalhes do cliente: ${message}`;
      return startAdVideoJob({ user, session, request, displayMessage: message, res, briefed: true });
    }
    // 🗣️ "…falando bom dia, eu sou o Delta" com imagem anexada → o personagem fala (não é anúncio)
    const sp = require('../contract').detectSpeech(message, (session.memory.refImages || []).length > 0);
    if (sp) return startSpeakJob({ user, session, message, speech: sp.fala, voice: sp.feminina ? 'pf_dora' : 'pm_alex', res });
    // 🧭 A IA entende a mensagem antes de agir (conversa + textos das imagens + último vídeo).
    //    Se ela não responder (sem chave/erro), seguem as regras por palavra-chave abaixo.
    const contract = require('../contract');
    const projNow = session.memory.project || {};
    const hasImgNow = (session.memory.refImages || []).length > 0;
    const pre = contract.precheck({ message, knowsBusiness: !!(projNow.brand || (projNow.facts || []).length), hasImage: hasImgNow });
    if (pre) {
      const q = pre.duvidas.join('\n');
      if (pre.tipo === 'roteiro_video' && /v[íi]deo/i.test(message)) session.memory.pendingContract = { message, at: Date.now() };
      else session.memory.pendingAd = { request: message, askedAt: Date.now() };
      cerebro.pushHistory(session, 'user', message, null);
      cerebro.pushHistory(session, 'assistant', q, null);
      return res.json({ success: true, sessionId: session.id, reply: q, ask: pre.duvidas, needInfo: true, contract: pre, imageUrl: null, videoUrl: null, type: 'chat', memory: session.memory, history: session.history.slice(-20) });
    }
    // roteiro/legenda/texto: entrega TEXTO (não renderiza vídeo nem gasta crédito de vídeo)
    const requested = contract.detectRequested(message).tipo;
    const adjustingLast = !!session.memory.lastAdRequest && /\b(refa[zç]\w*|muda|mude|troca|troque|ajusta|ajuste|corrig\w*)\b/i.test(message);
    if ((requested === 'roteiro_video' || requested === 'copy') && !adjustingLast) {
      return deliverText({ user, session, message, tipo: requested, res });
    }

    // 🔤 CRIAR LOGO: nome e cor do pedido, símbolo pela IA (sem texto), nome escrito por código
    if (require('../logoMaker').isLogoRequest(message) && !hasImgNow) {
      return makeLogo({ user, session, message, display: message, res });
    }

    const route = await aiRouter.routeMessage({ message, session });
    if (route) {
      // o tipo pedido manda: imagem nunca vira vídeo, vídeo nunca vira imagem/resposta
      const fix = contract.enforce(route.action, message);
      if (fix.corrigido) {
        console.warn('contrato: ação corrigida', route.action, '→', fix.action, '|', fix.motivo);
        if (fix.action === 'write') return deliverText({ user, session, message, tipo: requested || 'copy', res });
        route.action = fix.action;
        if (fix.action === 'video' && !route.request) route.request = message;
      }
      if (route.brand) {
        session.memory.project = session.memory.project || {};
        // escreveu o nome de OUTRA empresa na mensagem → troca; senão só preenche se estava vazio
        if (!session.memory.project.brand) session.memory.project.brand = route.brand;
        else if (require('../brandInfo').mentions(message, route.brand)) switchBrand(session, route.brand);
      }
      const reply = (text, extra = {}) => {
        cerebro.pushHistory(session, 'user', message, null);
        cerebro.pushHistory(session, 'assistant', text, null);
        return res.json({ success: true, sessionId: session.id, reply: text, imageUrl: null, videoUrl: null, type: 'chat', memory: session.memory, history: session.history.slice(-20), ...extra });
      };
      if (route.action === 'answer' && route.reply) return reply(route.reply);
      // apresentador custa mais: só quando o CLIENTE pediu pessoa/apresentador (a IA não decide sozinha)
      const askedPerson = /(apresentador|apresentadora|pessoa|avatar|influencer|garot[oa][- ]propaganda|algu[ée]m falando|\bugc\b)/i.test(message);
      if (route.style === 'presenter' && !askedPerson) route.style = '';
      // o pedido reescrito pela IA não pode ativar o apresentador por acaso ("vídeo apresentando a JN")
      if (!askedPerson && route.request) {
        route.request = route.request
          .replace(/\bapresentand(o|a)\b/gi, 'mostrando')
          .replace(/\bapresente\b/gi, 'mostre')
          .replace(/\b(apresentador(a)?|avatar|influencer|garot[oa][- ]propaganda|algu[ée]m falando|\bugc)\b/gi, '')
          .replace(/pessoa (real )?(falando|mostrando|apresentando)/gi, '');
      }
      if (route.style === 'photo' && !/(foto|realista)/i.test(message)) route.style = '';
      if (route.action === 'speak') {
        if (!(session.memory.refImages || []).length) return reply('Para o personagem falar, anexe a imagem dele e escreva a fala. Ex.: "faz ele falar: bom dia, eu sou o Delta".');
        return startSpeakJob({ user, session, message, speech: route.speech || message, voice: route.gender === 'female' ? 'pf_dora' : 'pm_alex', res });
      }
      if (route.action === 'animate') {
        if (!(session.memory.refImages || []).length) return reply('Para eu animar, anexe a imagem (o mascote, a logo ou o produto) e me diga o movimento. Ex.: "deixa a barriga do mascote girando como uma betoneira".');
        return startAnimateJob({ user, session, message, motion: route.motion, res });
      }
      if (route.action === 'adjust_video' && session.memory.lastAdRequest) {
        const request = `${aiRouter.requestWithStyle(session.memory.lastAdRequest, route.style)}. Ajuste pedido pelo cliente no vídeo anterior: ${message}`;
        return startAdVideoJob({ user, session, request, displayMessage: message, res, adjusting: true });
      }
      if (route.action === 'video' || (route.action === 'adjust_video' && !session.memory.lastAdRequest)) {
        return startAdVideoJob({ user, session, request: keepFacts(aiRouter.requestWithStyle(route.request || message, route.style), message), displayMessage: message, res });
      }
      if (route.action === 'ask' && route.question) {
        if (/(v[íi]deo|an[úu]ncio|comercial|reels)/i.test(`${message} ${route.request}`)) {
          session.memory.pendingAd = { request: route.request || message, askedAt: Date.now() };
        }
        return reply(route.question, { ask: [route.question], needInfo: true });
      }
      // action 'image' (ou algo incompleto): segue o fluxo de imagem, já sabendo a marca
    }

    // Correção de pronúncia depois de um vídeo ("XYZ se pronuncia xis ípsilon zê") → refaz o último
    if (session.memory.lastAdRequest && !adVideo.isAdVideoRequest(message)) {
      const pron = require('../speech').parsePronunciations(message);
      const adText = `${session.memory.lastAdRequest} ${(session.memory.project && session.memory.project.brand) || ''}`.toLowerCase();
      // só é correção se o nome corrigido está no anúncio (evita "como se fala isso?")
      for (const k of Object.keys(pron)) if (!adText.includes(k.toLowerCase())) delete pron[k];
      if (Object.keys(pron).length) {
        session.memory.project = session.memory.project || {};
        session.memory.project.pronunciations = { ...(session.memory.project.pronunciations || {}), ...pron };
        return startAdVideoJob({ user, session, request: session.memory.lastAdRequest, displayMessage: message, res });
      }
    }
    // Ajuste do último vídeo: o cliente comenta o vídeo em vez de fazer um pedido novo
    // ("consegue falar o nome da empresa no vídeo?", "muda a cor", "põe o telefone")
    if (session.memory.lastAdRequest && !adVideo.isAdVideoRequest(message) && isAdAdjustment(message)) {
      const request = `${session.memory.lastAdRequest}. Ajuste pedido pelo cliente no vídeo anterior: ${message}`;
      return startAdVideoJob({ user, session, request, displayMessage: message, res, adjusting: true });
    }
    if (adVideo.isAdVideoRequest(message)) {
      const hasImg = (session.memory.refImages || []).length > 0;
      if (adVideo.needsAdBriefing(message, session.memory.project, hasImg)) {
        const q = '🎬 Bora fazer o anúncio! Me diga em uma mensagem: o que é o produto/empresa, a oferta ou preço (se tiver) e o contato (WhatsApp, endereço). Se preferir, envie também uma foto do produto.';
        session.memory.pendingAd = { request: message, askedAt: Date.now() };
        cerebro.pushHistory(session, 'user', message, null);
        cerebro.pushHistory(session, 'assistant', q, null);
        return res.json({ success: true, sessionId: session.id, reply: q, ask: [q], needInfo: true, imageUrl: null, videoUrl: null, type: 'video', memory: session.memory, history: session.history.slice(-20) });
      }
      return startAdVideoJob({ user, session, request: message, res });
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
      // Só pergunta o NOME, e só se o pedido não trouxer nenhum (aspas ou nome próprio).
      // Tipo da peça e cores NÃO são perguntados: têm padrão (post quadrado, cores do ramo).
      // (Antes a pergunta do tipo saía justamente quando o cliente JÁ tinha dito "post".)
      void wantsObjStrong;
      const hasName = /["“”']/.test(message) || /\b[A-ZÀ-Ú][\wÀ-ú]+(?:\s+[A-ZÀ-Ú][\wÀ-ú]+)+/.test(message.replace(/^\s*\S+/, ''));
      if (wantsBrandStrong && !projStrong.brand && !hasName && !askedStrong.includes('brand')) qStrong.push({ field: 'brand', q: 'Qual é o nome/marca que deve aparecer na peça?' });
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
      if (up.brand && !require('../brandInfo').isGenericBrand(up.brand)) proj.brand = up.brand;
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
          // Não troca a foto de referência pelo vídeo: a próxima edição continua
          // partindo da imagem (um .mp4 como "imagem" quebrava as edições seguintes).
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

    // 5a2) CONFERÊNCIA DO TEXTO: lê o texto da imagem pronta e compara (em código) com o
    //      que o cliente pediu. Errado → refaz 1x reforçando o texto; ainda errado → gera
    //      SEM texto e escreve o texto por código (sempre certo). Sem cobrar a mais.
    try {
      const TC = require('../textCheck');
      const mustText = TC.requiredTexts(extractTextTokens(message));
      if (imageUrl && mustText.length && !onlyPlace && !isPortrait) {
        let r = await TC.verify(imageUrl, mustText);
        if (r && !r.ok) {
          console.warn('Cérebro Visual: texto errado na imagem →', r.missing.join(' | '), '| lido:', r.seen.slice(0, 80));
          const list = mustText.map((t) => `"${t}"`).join(', ');
          const retry = await generateRoutes.generateImageFromProviders(
            `${finalPrompt}\nThe image MUST contain exactly these printed texts, spelled letter by letter with correct accents: ${list}. No other words.`,
            { width, height }).catch(() => null);
          const r2 = retry ? await TC.verify(retry, mustText) : null;
          if (retry && r2 && r2.ok) {
            imageUrl = retry;
          } else {
            // imagem SEM texto (até 2 tentativas, conferidas pela visão)
            let clean = null;
            for (let k = 0; k < 2 && !clean; k++) {
              const c = await generateRoutes.generateImageFromProviders(TC.textFreePrompt(finalPrompt), { width, height }).catch(() => null);
              if (!c) continue;
              const seen = await TC.transcribe(c).catch(() => null);
              if (seen === null || !seen.replace(/[^\p{L}\d]/gu, '').length) clean = c;
              else console.warn('Cérebro Visual: imagem "sem texto" veio com texto:', seen.slice(0, 60));
            }
            const colors = (session.memory.project && session.memory.project.colors) || [];
            const hex = (require('../logoMaker').extractColor(`${message} ${colors.join(' ')}`) || {}).hex;
            const png = await TC.overlayText(clean || retry || imageUrl, mustText, hex ? { hex } : {});
            imageUrl = await adVideo._internals.uploadToFal(png, 'image/png', `peca-${Date.now()}.png`).catch(() => `data:image/png;base64,${png.toString('base64')}`);
            cmd.reply = `${cmd.reply || 'Pronto!'} Conferi o texto da imagem: a IA tinha escrito errado, então eu mesmo escrevi ${list} com a grafia exata.`;
          }
        }
      }
    } catch (e) {
      console.error('Cérebro Visual: conferência de texto falhou (seguindo):', e.message);
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
        const C = require('../claims');
        const capsRaw = await generateCaptions(finalPrompt, session.memory.project);
        const caps = capsRaw && capsRaw.split('\n').map((l) => C.cleanVoice(l, C.sourceOf({ request: message, project: session.memory.project }))).join('\n');
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

// GET /api/cerebro/job/:jobId — progresso do anúncio em vídeo
router.get('/job/:jobId', authMiddleware, async (req, res) => {
  try {
    const gen = await prisma.generation.findUnique({ where: { id: String(req.params.jobId) } });
    if (!gen || gen.userId !== req.user.id || !String(gen.prompt).startsWith(AD_TAG)) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    const mem = JOB_STEPS.get(gen.id) || {};
    if (gen.status === 'COMPLETED') {
      return res.json({ status: 'done', reply: mem.reply || 'Pronto! Seu vídeo está aqui.', videoUrl: gen.imageUrl, credits: mem.credits || null, debug: mem.debug || null });
    }
    if (gen.status === 'FAILED') {
      return res.json({ status: 'error', error: mem.error || 'Não consegui montar o vídeo. Seu crédito foi devolvido — tente novamente.' });
    }
    return res.json({ status: 'running', step: mem.step || 'Produzindo o vídeo…' });
  } catch (e) {
    console.error('Cérebro: consulta de vídeo falhou:', e.message);
    return res.status(500).json({ error: 'Não consegui consultar o vídeo agora.' });
  }
});

// GET /api/cerebro/memoria/:sessionId — recompõe o chat (histórico + memória)
router.get('/memoria/:sessionId', authMiddleware, async (req, res) => {
  await cerebro.hydrate(req.user.id, req.params.sessionId).catch(() => null);
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