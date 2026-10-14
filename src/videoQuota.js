// 🎟️ LIMITE MENSAL DE VÍDEOS DO PLANO PREMIUM
//
// O PREMIUM tinha vídeo ilimitado. Com o modelo novo (Kling 3), cada vídeo custa mais na
// fal.ai, e um cliente que gera muito passaria a custar mais do que paga. Agora o PREMIUM
// tem um limite por mês, configurável:
//   PREMIUM_VIDEO_LIMIT  vídeos por mês (padrão 20; 0 = ilimitado, como era antes)
// Conta os vídeos do mês (tabela generations, tipo VIDEO, que não falharam) — não precisa
// de coluna nova no banco. O mês vira no dia 1, junto com o reset de créditos do cron.

function premiumLimit() {
  const raw = process.env.PREMIUM_VIDEO_LIMIT;
  if (raw === undefined || raw === '') return 20;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 ou inválido negativo = ilimitado
}

function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// { limit, used, left } — limit 0 significa ilimitado (left = Infinity)
async function premiumUsage(prisma, userId, now = new Date()) {
  const limit = premiumLimit();
  if (!limit) return { limit: 0, used: 0, left: Infinity };
  const used = await prisma.generation.count({
    where: { userId, type: 'VIDEO', status: { not: 'FAILED' }, createdAt: { gte: monthStart(now) } }
  });
  return { limit, used, left: Math.max(0, limit - used) };
}

// Mensagem para quem estourou o limite (null se ainda pode gerar)
async function premiumBlock(prisma, user) {
  if (!user || user.plan !== 'PREMIUM') return null;
  const u = await premiumUsage(prisma, user.id);
  if (u.left > 0) return null;
  return `Você já usou os ${u.limit} vídeos do plano neste mês. O limite renova no dia 1. Se precisar de mais agora, compre créditos de vídeo.`;
}

// Texto curto de custo, mostrado ANTES de gerar ("Este vídeo usa 2 créditos…")
function costLine({ user, cost, usage }) {
  if (user && user.plan === 'PREMIUM') {
    if (!usage || !usage.limit) return '';
    return ` Plano PREMIUM: este é o vídeo ${usage.used + 1} de ${usage.limit} do mês.`;
  }
  const have = ((user && user.creditsVideos) || 0) + ((user && user.creditsPurchased) || 0);
  return ` Este vídeo usa ${cost} crédito${cost > 1 ? 's' : ''} de vídeo (você tem ${have}).`;
}

// Contas sem limite e sem cobrança de vídeo (o dono testando o app): e-mails separados
// por vírgula em VIDEO_UNLIMITED_EMAILS.
function isUnlimitedAccount(user) {
  const list = String(process.env.VIDEO_UNLIMITED_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return !!(user && user.email && list.includes(String(user.email).toLowerCase()));
}

// Portão único antes de qualquer vídeo. Devolve:
//   { ok: true,  cost, free, chargePurchased, line }  → pode gerar
//   { ok: false, error }                              → não pode (mensagem pronta)
// free: PREMIUM dentro do limite (não desconta crédito).
// chargePurchased: PREMIUM acima do limite, pagando com créditos comprados.
async function gate(prisma, user, cost) {
  const c = Math.max(1, Math.round(Number(cost) || 1));
  if (isUnlimitedAccount(user)) return { ok: true, cost: 0, free: true, chargePurchased: false, line: '' };
  if (user.plan === 'PREMIUM') {
    const usage = await premiumUsage(prisma, user.id);
    if (usage.left > 0) return { ok: true, cost: 0, free: true, chargePurchased: false, line: costLine({ user, cost: c, usage }) };
    if ((user.creditsPurchased || 0) >= c) {
      return { ok: true, cost: c, free: false, chargePurchased: true,
        line: ` Os ${usage.limit} vídeos do plano neste mês acabaram; este usa ${c} crédito${c > 1 ? 's' : ''} comprado${c > 1 ? 's' : ''}.` };
    }
    return { ok: false, error: `Você já usou os ${usage.limit} vídeos do plano neste mês. O limite renova no dia 1. Se precisar de mais agora, compre créditos de vídeo.` };
  }
  const have = (user.creditsVideos || 0) + (user.creditsPurchased || 0);
  if (have < c) return { ok: false, error: null, have };
  return { ok: true, cost: c, free: false, chargePurchased: false, line: costLine({ user, cost: c }) };
}

module.exports = { premiumLimit, monthStart, premiumUsage, premiumBlock, costLine, gate, isUnlimitedAccount };
