// 🎟️ LIMITE MENSAL DE VÍDEO DO PLANO PREMIUM — em CRÉDITOS (não em número de vídeos)
//
// Antes contava vídeos: 20 vídeos de 15 s custavam ~US$ 34 no fal para um plano de R$ 39,99.
// Agora conta créditos (VIDEO_CREDITS_PER_5S a cada 5 s; padrão 10). O limite vem de
// plans.PREMIUM.videoCredits() (PREMIUM_VIDEO_LIMIT; padrão 30 = 15 s/mês; 0 = ilimitado).
// Soma o "cost" das gerações de VÍDEO do mês que não falharam. O mês vira no dia 1.

const plans = require('./plans');

function premiumLimit() {
  const raw = process.env.PREMIUM_VIDEO_LIMIT;
  if (raw === '0') return 0; // ilimitado
  return plans.PREMIUM.videoCredits();
}

function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// { limit, used, left } em créditos — limit 0 significa ilimitado (left = Infinity)
async function premiumUsage(prisma, userId, now = new Date()) {
  const limit = premiumLimit();
  if (!limit) return { limit: 0, used: 0, left: Infinity };
  const agg = await prisma.generation.aggregate({
    _sum: { cost: true },
    where: { userId, type: 'VIDEO', status: { not: 'FAILED' }, createdAt: { gte: monthStart(now) } }
  });
  const used = (agg && agg._sum && agg._sum.cost) || 0;
  return { limit, used, left: Math.max(0, limit - used) };
}

// Mensagem para quem estourou o limite (null se ainda pode gerar)
async function premiumBlock(prisma, user) {
  if (!user || user.plan !== 'PREMIUM') return null;
  const u = await premiumUsage(prisma, user.id);
  if (u.left > 0) return null;
  return `Você já usou os ${u.limit} créditos de vídeo do plano neste mês. O limite renova no dia 1. Se precisar de mais agora, compre um pacote de créditos.`;
}

// Texto curto de custo, mostrado ANTES de gerar ("Este vídeo usa 2 créditos…")
function costLine({ user, cost, usage }) {
  if (user && user.plan === 'PREMIUM') {
    if (!usage || !usage.limit) return '';
    return ` Plano PREMIUM: este vídeo usa ${cost} dos ${usage.left} créditos de vídeo que restam no mês.`;
  }
  const have = ((user && user.creditsVideos) || 0) + ((user && user.creditsPurchased) || 0);
  return ` Este vídeo usa ${cost} crédito${cost > 1 ? 's' : ''} (você tem ${have}).`;
}

// CTA final das mensagens de saldo insuficiente (é o que vende o pacote): fala
// em clipes de 5 s, não em linhas de banco.
function ctaPacote(c, have) {
  const per5 = plans.per5s();
  const hClipes = Math.floor(have / per5);
  const tem = have > 0
    ? `Seus ${have} créditos comprados dão para ${hClipes} vídeo${hClipes > 1 ? 's' : ''} de 5 s.`
    : 'Você tem nenhum crédito comprado.';
  return `${tem} Compre um pacote de vídeo em /plans — não vencem e também valem para imagens.`;
}

// Mensagem para quem não tem saldo de vídeo suficiente. Mostra o pedido em CLIPES
// de 5 s, porque é o que o cliente entende na hora de comprar.
function semSaldo(c, have) {
  const cClipes = Math.ceil(c / plans.per5s());
  const status = have > 0 ? 'dá para vídeos menores, mas não para este' : 'você tem nenhum';
  return `Este vídeo usa ${c} créditos${cClipes > 1 ? ` (≈ ${cClipes} vídeos de 5 s)` : ''} e ${status}. ${ctaPacote(c, have)}`;
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
    // free: não desconta nada, mas "cost" é o tamanho real (vai para generation.cost e conta no limite)
    if (usage.left >= c) return { ok: true, cost: c, free: true, chargePurchased: false, line: costLine({ user, cost: c, usage }) };
    if ((user.creditsPurchased || 0) >= c) {
      return { ok: true, cost: c, free: false, chargePurchased: true,
        line: ` Os créditos de vídeo do plano neste mês não bastam para este vídeo; ele usa ${c} crédito${c > 1 ? 's' : ''} comprado${c > 1 ? 's' : ''}.` };
    }
    return { ok: false, error: `Este vídeo usa ${c} créditos e restam ${usage.left === Infinity ? 0 : usage.left} do plano neste mês (renova no dia 1). ${ctaPacote(c, user.creditsPurchased || 0)}` };
  }
  const have = (user.creditsVideos || 0) + (user.creditsPurchased || 0);
  if (have < c) return { ok: false, error: semSaldo(c, have), have };
  return { ok: true, cost: c, free: false, chargePurchased: false, line: costLine({ user, cost: c }) };
}

module.exports = { premiumLimit, monthStart, premiumUsage, premiumBlock, costLine, ctaPacote, semSaldo, gate, isUnlimitedAccount };
