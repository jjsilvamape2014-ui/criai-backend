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
const { startCron, resetMonthlyCredits } = require('./cron');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  startCron();
});

module.exports = { prisma };
