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
app.use(express.json({ limit: '10mb' }));

// Rate limiting global
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 requisições por minuto por IP
  message: { error: 'Muitas requisições. Tente novamente em breve.' }
});
app.use(limiter);

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/cerebro', cerebroRoutes);
app.use('/api/templates', templatesRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Reset mensal de créditos (também agendado automaticamente pelo cron interno)
app.post('/api/admin/reset-credits', async (req, res) => {
  try {
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  startCron();
});

module.exports = { prisma };
