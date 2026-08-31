const express = require('express');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

// Pacotes de créditos disponíveis
const CREDIT_PACKAGES = [
  { id: 'credits_50', name: 'Pacote Básico', images: 50, videos: 0, price: 900, priceFormatted: 'R$ 9,00' },
  { id: 'credits_150', name: 'Pacote Pro', images: 150, videos: 10, price: 1900, priceFormatted: 'R$ 19,00' },
  { id: 'credits_500', name: 'Pacote Ultra', images: 500, videos: 50, price: 4900, priceFormatted: 'R$ 49,00' }
];

// Listar pacotes
router.get('/packages', (req, res) => {
  res.json(CREDIT_PACKAGES);
});

// Saldo do usuário
router.get('/balance', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { creditsImages: true, creditsVideos: true, creditsPurchased: true, plan: true }
  });
  res.json(user);
});

// Adicionar créditos (usado após pagamento confirmado)
router.post('/add', authMiddleware, async (req, res) => {
  try {
    const { packageId } = req.body;
    const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);

    if (!pkg) {
      return res.status(400).json({ error: 'Pacote inválido' });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        creditsPurchased: { increment: pkg.images }
      }
    });

    res.json({
      success: true,
      added: pkg.images,
      credits: {
        images: user.creditsImages,
        videos: user.creditsVideos,
        purchased: user.creditsPurchased
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar créditos' });
  }
});

module.exports = { router, CREDIT_PACKAGES };
