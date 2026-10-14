// Convite para clientes: quem se cadastra com um código válido ganha créditos avulsos
// (não vencem). Sem mudar o banco: o uso fica numa tabela própria criada sob demanda.
//
// CONVITE_CODES="LINHAFACIL:60,OUTRO:30"  código:créditos (padrão LINHAFACIL:60)
// CONVITE_MAX=30                           máximo de usos por código (padrão 30)
// Falha aqui nunca impede o cadastro: só não dá o bônus.

let ready = null;
let prismaRef = null;
function db() {
  if (!prismaRef) { const { PrismaClient } = require('@prisma/client'); prismaRef = new PrismaClient(); }
  return prismaRef;
}
function ensure() {
  if (!ready) {
    ready = db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS convites_usados (
      user_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      credits INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function codes() {
  const raw = process.env.CONVITE_CODES === undefined ? 'LINHAFACIL:60' : process.env.CONVITE_CODES;
  const map = new Map();
  for (const part of String(raw).split(/[,;\s]+/).filter(Boolean)) {
    const [c, n] = part.split(':');
    const credits = Math.round(Number(n));
    if (c && Number.isFinite(credits) && credits > 0) map.set(c.trim().toUpperCase(), credits);
  }
  return map;
}
const maxUses = () => {
  const n = Math.round(Number(process.env.CONVITE_MAX));
  return Number.isFinite(n) && n > 0 ? n : 30;
};

// { ok, credits } ou { ok:false, reason }
async function redeem(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'sem código' };
  const credits = codes().get(code);
  if (!credits) return { ok: false, reason: 'código inválido' };
  try {
    await ensure();
    const rows = await db().$queryRawUnsafe('SELECT COUNT(*)::int AS n FROM convites_usados WHERE code = $1', code);
    if (((rows[0] && rows[0].n) || 0) >= maxUses()) return { ok: false, reason: 'convite esgotado' };
    const ins = await db().$executeRawUnsafe(
      'INSERT INTO convites_usados (user_id, code, credits) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
      String(userId), code, credits
    );
    if (!ins) return { ok: false, reason: 'já usado' };
    await db().user.update({ where: { id: userId }, data: { creditsPurchased: { increment: credits } } });
    return { ok: true, credits };
  } catch (e) {
    console.warn('[convite] não aplicou:', e.message);
    return { ok: false, reason: 'erro' };
  }
}

// Para o painel do dono: quantos usaram cada código
async function usage() {
  try {
    await ensure();
    return await db().$queryRawUnsafe('SELECT code, COUNT(*)::int AS usos, SUM(credits)::int AS creditos FROM convites_usados GROUP BY code');
  } catch (e) { return []; }
}

module.exports = { redeem, usage, codes, maxUses, _internals: { setPrisma: (p) => { prismaRef = p; ready = null; } } };
