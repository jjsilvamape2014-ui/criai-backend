const express = require('express');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

// Pacotes e planos: valores em plans.js (um lugar só)
const plans = require('../plans');
const { CREDIT_PACKAGES } = plans;

// Listar pacotes
router.get('/packages', (req, res) => {
  res.json(CREDIT_PACKAGES);
});

// Planos completos (grátis, PREMIUM e pacotes) — a tela de planos lê daqui
router.get('/plans', (req, res) => {
  res.json(plans.summary());
});

// Saldo do usuário
router.get('/balance', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { creditsImages: true, creditsVideos: true, creditsPurchased: true, plan: true }
  });
  res.json(user);
});

// (A rota POST /add foi removida: qualquer conta logada podia se dar créditos sem pagar.
//  Créditos só entram pelo pagamento confirmado em routes/payment.js.)

module.exports = { router, CREDIT_PACKAGES };
