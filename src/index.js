// Precisa vir primeiro: registra as fontes (Poppins) antes de qualquer texto renderizado pelo sharp
require('./fontSetup');
// Também antes dos módulos de vídeo: acha o ffmpeg (sistema ou pacote ffmpeg-static)
require('./ffmpegSetup');
// Um erro solto numa tarefa em segundo plano não pode derrubar o servidor inteiro
// (derrubava as conversas em memória e o site respondia 502 até reiniciar).
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (servidor segue no ar):', reason && reason.stack ? reason.stack : reason);
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const creditsRoutes = require('./routes/credits').router;
const paymentRoutes = require('./routes/payment');
const cerebroRoutes = require('./routes/cerebro');
const templatesRoutes = require('./routes/templates');
const legendaRoutes = require('./routes/legenda');
const montarRoutes = require('./routes/montar');
const motionPresetsRoutes = require('./routes/motionPresets');
const { startCron, resetMonthlyCredits } = require('./cron');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

// Confia no proxy da Railway para identificar o IP real do usuário
// (evita aviso ERR_ERL_UNEXPECTED_X_FORWARDED_FOR e rate-limit incorreto)
app.set('trust proxy', 1);

// CORS: aceita uma lista de domínios do front (separados por vírgula em FRONTEND_URL).
// Requisições sem Origin (curl, server-to-server) são aceitas.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
// O webhook do Stripe precisa do corpo CRU para conferir a assinatura. Sem isto o
// express.json lia o corpo antes e toda confirmação via webhook falhava.
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting global
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 requisições por minuto por IP
  message: { error: 'Muitas requisições. Tente novamente em breve.' }
});
app.use(limiter);

// Rotas
// registra quem recebeu "créditos acabaram" (painel do dono)
app.use(require('./limitLog').middleware);
app.use('/api/auth', authRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/cerebro', cerebroRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/legenda', legendaRoutes);
app.use('/api/video', montarRoutes);
// Registry de movimentos de câmera (65 presets, lidos do JSON — não toca o banco)
app.use('/api/motion-presets', motionPresetsRoutes);

// Health check
app.get('/api/health', async (req, res) => {
  const { CODE_REV, COMMIT, toolsStatus } = require('./version');
  res.json({ status: 'OK', timestamp: new Date().toISOString(), version: CODE_REV, commit: COMMIT, tools: await toolsStatus() });
});

// Diagnóstico de configuração (só booleans — nunca expõe chaves).
// Serve para descobrir por que a IA "ficou burra": sem FAL_KEY o app cai no modelo
// grátis do Pollinations, que não obedece o pedido nem acerta texto.
app.get('/api/diagnostics', (req, res) => {
  const has = (k) => !!process.env[k];
  const llmKey = process.env.LLM_API_KEY || '';
  res.json({
    providers: {
      fal: has('FAL_KEY'),
      stability: has('STABILITY_API_KEY'),
      magnific: has('MAGNIFIC_API_KEY'),
      freepik: has('FREEPIK_API_KEY'),
      huggingface: has('HF_API_KEY'),
      replicate: has('REPLICATE_API_TOKEN'),
      imagga: has('IMAGGA_API_KEY')
    },
    llm: {
      configured: has('LLM_API_KEY'),
      provider: llmKey.startsWith('gsk_') ? 'groq' : llmKey.startsWith('sk-') ? 'openai' : llmKey ? 'gemini' : null,
      model: process.env.LLM_MODEL || '(padrão do provider)',
      // quantas vezes o roteador entendeu / falhou desde que o servidor subiu
      router: require('./router').stats
    },
    video: require('./videoModels').describe(),
    vision: { enabled: process.env.VISION_ENABLED !== 'false' && has('FAL_KEY') },
    region: process.env.RENDER_REGION || process.env.RAILWAY_REGION || null,
    // Modo do Stripe (só rótulos): 'test' significa que ninguém consegue pagar de verdade
    billing: require('./billingStatus').section()
  });
});

// Reset mensal de créditos (também agendado automaticamente pelo cron interno).
// Estava SEM proteção: qualquer pessoa podia chamar. Agora exige a ADMIN_KEY.
app.post('/api/admin/reset-credits', async (req, res) => {
  try {
    const adminKey = (req.body && req.body.adminKey) || req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Não autorizado' });
    const usersUpdated = await resetMonthlyCredits();
    res.json({ message: 'Créditos resetados', usersUpdated });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao resetar créditos' });
  }
});

// Admin: promove um usuário para o plano PREMIUM (ilimitado). Protegido por ADMIN_KEY.
app.post('/api/admin/premium', async (req, res) => {
  try {
    const { email, adminKey } = req.body || {};
    if (!email || !adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Não autorizado' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { plan: 'PREMIUM', creditsImages: 100000, creditsVideos: 100000, creditsPurchased: 100000 }
    });
    res.json({ message: 'Usuário promovido para PREMIUM', email });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao promover usuário: ' + err.message });
  }
});

// Admin: as conversas mais recentes do Cérebro (o que cada cliente pediu e o que o app
// respondeu), para achar onde "pediu uma coisa e fez outra". Só para quem está logado com
// um e-mail de ADMIN_EMAILS (ou VIDEO_UNLIMITED_EMAILS). Sem imagens/vídeos (só se havia).
// GET /api/admin/conversas?limit=30&hours=72
app.get('/api/admin/conversas', require('./middleware').authMiddleware, async (req, res) => {
  try {
    const list = String(process.env.ADMIN_EMAILS || process.env.VIDEO_UNLIMITED_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
    if (!req.user || !list.includes(String(req.user.email || '').toLowerCase())) return res.status(403).json({ error: 'Não autorizado' });
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 72));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.key, s.user_id, s.updated_at, s.data, u.email
         FROM cerebro_sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.updated_at > NOW() - ($1 || ' hours')::interval
        ORDER BY s.updated_at DESC LIMIT $2`, String(hours), limit);
    const clip = (t, n) => String(t || '').replace(/data:[^\s"']{40,}/g, '[arquivo]').slice(0, n);
    res.json(rows.map((r) => ({
      quando: r.updated_at,
      // e-mail mascarado: dá para saber quem é sem expor o endereço inteiro
      cliente: String(r.email || r.user_id).replace(/^(.{2}).*(@.*)$/, '$1***$2'),
      marca: (r.data && r.data.memory && r.data.memory.project && r.data.memory.project.brand) || null,
      conversa: ((r.data && r.data.history) || []).slice(-24).map((h) => ({
        quem: h.role === 'user' ? 'cliente' : 'app',
        texto: clip(h.message, 700),
        imagem: !!h.imageUrl,
        video: !!h.videoUrl
      }))
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao ler conversas: ' + err.message });
  }
});

// Visitas do site (painel do dono). Público, sem login obrigatório; se vier o token,
// liga a visita à conta. Sem IP e sem cookies: id aleatório do navegador.
const trackLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: false, legacyHeaders: false });
app.post('/api/track', trackLimiter, async (req, res) => {
  res.status(204).end();
  try {
    let userId = null;
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    if (token && process.env.JWT_SECRET) {
      try { userId = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).userId || null; } catch (e) { /* token velho: visita anônima */ }
    }
    const b = req.body || {};
    await require('./visits').record({ visitor: b.v, userId, path: b.p, referrer: b.r, utm: b.u, ua: req.headers['user-agent'] });
  } catch (e) { /* nunca quebra a página */ }
});

// Admin: quem usou e quem comprou. Mesma regra de acesso de /api/admin/conversas.
// GET /api/admin/resumo?days=30
function isAdminUser(user) {
  const list = String(process.env.ADMIN_EMAILS || process.env.VIDEO_UNLIMITED_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return !!(user && list.includes(String(user.email || '').toLowerCase()));
}
app.get('/api/admin/resumo', require('./middleware').authMiddleware, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Não autorizado' });
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const mask = (e) => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
    const admins = String(process.env.ADMIN_EMAILS || process.env.VIDEO_UNLIMITED_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
    const [users, gens, pays, limites] = await Promise.all([
      prisma.user.findMany({ select: { id: true, email: true, plan: true, createdAt: true, creditsPurchased: true, creditsImages: true, creditsVideos: true } }),
      prisma.generation.findMany({ where: { createdAt: { gte: since } }, select: { userId: true, type: true, status: true, createdAt: true } }),
      prisma.payment.findMany({ select: { userId: true, amount: true, currency: true, status: true, type: true, createdAt: true } }),
      require('./limitLog').byUserSince(since)
    ]);
    const convites = await require('./invite').usage();
    const isTestE = (e) => /@(example\.(com|org|net)|test\.com|teste\.com|teste\.local|criai\.com)$/i.test(String(e || ''));
    const ignorar = users.filter((u) => admins.includes(String(u.email).toLowerCase()) || isTestE(u.email)).map((u) => u.id);
    const visitas = await require('./visits').summary(since, ignorar);
    const emailDe = new Map(users.map((u) => [u.id, u.email]));
    const byUser = new Map(users.map((u) => [u.id, { email: u.email, plan: u.plan, createdAt: u.createdAt, imagens: 0, videos: 0, falhas: 0, ultimoUso: null, pagamentos: 0, pagoCentavos: 0,
      limite: (limites.get(u.id) || {}).vezes || 0,
      // grátis sem crédito agora = na próxima tentativa já cai no "créditos acabaram"
      semCredito: u.plan === 'FREE' && (u.creditsImages || 0) + (u.creditsPurchased || 0) <= 0,
      tentouPagar: (limites.get(u.id) || {}).checkout || 0 }]));
    for (const g of gens) {
      const u = byUser.get(g.userId); if (!u) continue;
      if (g.status === 'FAILED') u.falhas++; else if (g.type === 'VIDEO') u.videos++; else u.imagens++;
      if (!u.ultimoUso || g.createdAt > u.ultimoUso) u.ultimoUso = g.createdAt;
    }
    const paid = pays.filter((p) => p.status === 'COMPLETED');
    for (const p of paid) { const u = byUser.get(p.userId); if (u) { u.pagamentos++; u.pagoCentavos += p.amount || 0; } }
    // contas criadas pelos scripts de teste (…@example.com) não são clientes
    const isTest = (e) => /@(example\.(com|org|net)|test\.com|teste\.com|teste\.local|criai\.com)$/i.test(String(e || ''));
    const todos = [...byUser.values()];
    const contasTeste = todos.filter((u) => isTest(u.email)).length;
    const clientes = todos.filter((u) => !admins.includes(String(u.email).toLowerCase()) && !isTest(u.email));
    const ativos = clientes.filter((u) => u.ultimoUso);
    res.json({
      periodoDias: days,
      contasDeTesteIgnoradas: contasTeste,
      convites,
      visitas,
      comprasRecentes: pays
        .filter((p) => p.status === 'COMPLETED' && !ignorar.includes(p.userId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((p) => ({ cliente: mask(emailDe.get(p.userId)), tipo: p.type === 'SUBSCRIPTION' ? 'Assinatura Premium' : 'Pacote de créditos', valorReais: (p.amount || 0) / 100, quando: p.createdAt })),
      cadastros: { total: clientes.length, noPeriodo: clientes.filter((u) => u.createdAt >= since).length },
      usaram: { pessoas: ativos.length, imagens: ativos.reduce((a, u) => a + u.imagens, 0), videos: ativos.reduce((a, u) => a + u.videos, 0), falhas: ativos.reduce((a, u) => a + u.falhas, 0) },
      // funil: chegou na hora de pagar? (o registro de "limite" começou a contar com este deploy)
      limite: {
        pessoasQueBateram: clientes.filter((u) => u.limite > 0).length,
        vezes: clientes.reduce((a, u) => a + u.limite, 0),
        semCreditoAgora: clientes.filter((u) => u.semCredito).length,
        abriramPagamento: clientes.filter((u) => u.tentouPagar > 0).length,
        abriramPagamentoSemConcluir: clientes.filter((u) => u.tentouPagar > 0 && u.pagamentos === 0).length
      },
      compras: {
        pessoas: clientes.filter((u) => u.pagamentos > 0).length,
        pagamentos: paid.length,
        totalReais: paid.reduce((a, p) => a + (p.amount || 0), 0) / 100,
        assinantesPremium: clientes.filter((u) => u.plan === 'PREMIUM').length,
        pendentesOuFalhos: pays.filter((p) => p.status !== 'COMPLETED').length
      },
      pessoas: clientes
        .sort((a, b) => (b.ultimoUso || b.createdAt) - (a.ultimoUso || a.createdAt))
        .slice(0, 100)
        .map((u) => ({ cliente: mask(u.email), plano: u.plan, cadastro: u.createdAt, ultimoUso: u.ultimoUso, imagens: u.imagens, videos: u.videos, falhas: u.falhas, limite: u.limite, semCredito: u.semCredito, abriuPagamento: u.tentouPagar, pagamentos: u.pagamentos, pagoReais: u.pagoCentavos / 100 }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao montar o resumo: ' + err.message });
  }
});

app.listen(PORT, () => {
  require('./sessionStore').warmup().catch(() => {});
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  startCron();
});

module.exports = { prisma };
