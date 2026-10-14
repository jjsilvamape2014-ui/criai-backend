// Registro de "bateu no limite": cada vez que alguém recebe a resposta NO_CREDITS
// (créditos acabaram). Serve para o painel do dono responder: alguém chegou na hora
// de pagar? Tabela própria criada sob demanda (o deploy não roda migrations).
// Falhas aqui nunca derrubam o pedido do cliente: só registram no log.

let ready = null;
let prismaRef = null;

function db() {
  if (!prismaRef) { const { PrismaClient } = require('@prisma/client'); prismaRef = new PrismaClient(); }
  return prismaRef;
}

function ensure() {
  if (!ready) {
    ready = db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS limite_atingido (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      rota TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).then(() => db().$executeRawUnsafe('CREATE INDEX IF NOT EXISTS limite_atingido_quando ON limite_atingido (created_at DESC)'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function record(userId, rota) {
  if (!userId) return;
  try {
    await ensure();
    await db().$executeRawUnsafe('INSERT INTO limite_atingido (user_id, rota) VALUES ($1, $2)', String(userId), String(rota || '').slice(0, 120));
  } catch (e) {
    console.warn('[limite] não registrou:', e.message);
  }
}

// Map userId → { vezes (bateu no limite), checkout (abriu o pagamento), ultima }
async function byUserSince(since) {
  try {
    await ensure();
    const rows = await db().$queryRawUnsafe(
      "SELECT user_id, COUNT(*) FILTER (WHERE rota IS DISTINCT FROM 'checkout')::int AS vezes, COUNT(*) FILTER (WHERE rota = 'checkout')::int AS checkout, MAX(created_at) AS ultima FROM limite_atingido WHERE created_at >= $1 GROUP BY user_id",
      since
    );
    return new Map(rows.map((r) => [r.user_id, { vezes: r.vezes, checkout: r.checkout, ultima: r.ultima }]));
  } catch (e) {
    console.warn('[limite] não consegui ler:', e.message);
    return new Map();
  }
}

// Middleware: registra qualquer resposta JSON com code NO_CREDITS de um usuário logado.
function middleware(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && body.code === 'NO_CREDITS' && req.user && req.user.id) record(req.user.id, req.originalUrl);
    return json(body);
  };
  next();
}

module.exports = { record, byUserSince, middleware, _internals: { setPrisma: (p) => { prismaRef = p; ready = null; } } };
