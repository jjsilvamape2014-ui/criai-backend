const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Reset mensal de créditos (valores em plans.js)
// Roda todo dia às 03:00, mas só atualiza quem está com monthlyResetDate vencido.
//   FREE:    imagens do mês + créditos de vídeo do mês
//   PREMIUM: imagens do mês (os vídeos são contados pelo limite mensal em videoQuota)
// Créditos comprados (creditsPurchased) nunca são zerados.
async function resetMonthlyCredits() {
  const plans = require('./plans');
  const now = new Date();
  const due = { OR: [{ monthlyResetDate: { lt: now } }, { monthlyResetDate: null }] };
  const next = plans.nextMonthStart(now);
  const free = await prisma.user.updateMany({
    where: { plan: 'FREE', ...due },
    data: { creditsImages: plans.FREE.images(), creditsVideos: plans.FREE.videoCredits(), monthlyResetDate: next }
  });
  const premium = await prisma.user.updateMany({
    where: { plan: 'PREMIUM', ...due },
    data: { creditsImages: plans.PREMIUM.images(), creditsVideos: 0, monthlyResetDate: next }
  });
  console.log(`[cron] Créditos mensais renovados: ${free.count} FREE, ${premium.count} PREMIUM`);
  return free.count + premium.count;
}

function startCron() {
  // A cada dia às 03:00 (horário do servidor)
  const job = cron.schedule('0 3 * * *', async () => {
    try {
      await resetMonthlyCredits();
    } catch (e) {
      console.error('[cron] Erro no reset de créditos mensais:', e.message);
    }
  });

  // Grava imediatamente no boot caso estejamos em um novo mês (resiliente a reinícios)
  cron.schedule('5 */2 * * *', async () => {
    try {
      await resetMonthlyCredits();
    } catch (e) {
      console.error('[cron] Erro no reset periódico de créditos mensais:', e.message);
    }
  });

  console.log('[cron] Agendamentos de reset mensal ativos');
  return job;
}

module.exports = { startCron, resetMonthlyCredits };