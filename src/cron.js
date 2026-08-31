const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Reset mensal de créditos dos usuários FREE
// Roda todo dia às 03:00, mas só atualiza quem está com monthlyResetDate vencido.
async function resetMonthlyCredits() {
  const now = new Date();
  const updated = await prisma.user.updateMany({
    where: {
      plan: 'FREE',
      OR: [
        { monthlyResetDate: { lt: now } },
        { monthlyResetDate: null }
      ]
    },
    data: {
      creditsImages: 10,
      creditsVideos: 2,
      monthlyResetDate: new Date(now.getFullYear(), now.getMonth() + 1, 1)
    }
  });
  console.log(`[cron] Créditos mensais resetados para ${updated.count} usuários FREE`);
  return updated.count;
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