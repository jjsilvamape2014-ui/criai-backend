// 💾 CONVERSAS NO BANCO (sobrevivem a atualizações e reinícios do servidor)
//
// Antes as conversas do Cérebro ficavam só na memória do servidor: cada deploy
// apagava tudo que o cliente estava fazendo. Aqui cada sessão é gravada no Postgres
// (tabela própria, criada automaticamente — não mexe nas tabelas existentes) e
// recarregada quando o cliente volta.
//   - imagens anexadas em base64 grandes NÃO são gravadas (URLs sim)
//   - gravação agrupada (1,5 s) para não escrever a cada pequena mudança
//   - qualquer falha de banco só vai para o log: o chat continua funcionando
// Desligar: SESSIONS_DB=false
const { PrismaClient } = require('@prisma/client');

let prisma = null;
let ready = null;
const timers = new Map();
const enabled = () => process.env.SESSIONS_DB !== 'false' && !!process.env.DATABASE_URL;

function db() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

function ensureTable() {
  if (!ready) {
    ready = db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS cerebro_sessions (
      key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).then(() => db().$executeRawUnsafe('CREATE INDEX IF NOT EXISTS cerebro_sessions_user ON cerebro_sessions (user_id, updated_at DESC)'))
      .then(() => true)
      .catch((e) => { console.error('sessionStore: não consegui criar a tabela:', e.message); ready = null; return false; });
  }
  return ready;
}

const BIG = 150 * 1024; // dataURL maior que isso não vai para o banco
function slim(session) {
  return JSON.parse(JSON.stringify(session, (k, v) => {
    if (typeof v === 'string' && v.startsWith('data:') && v.length > BIG) return null;
    return v;
  }));
}

async function load(key) {
  if (!enabled() || !(await ensureTable())) return null;
  try {
    const rows = await db().$queryRawUnsafe('SELECT data FROM cerebro_sessions WHERE key = $1', key);
    const s = rows && rows[0] && rows[0].data;
    if (!s) return null;
    // referências que eram base64 grandes voltam vazias: limpa as listas
    const m = s.memory || {};
    m.refImages = (m.refImages || []).filter(Boolean);
    m.refDescriptions = (m.refDescriptions || []).filter((d) => d && d.src);
    return s;
  } catch (e) {
    console.error('sessionStore: leitura falhou:', e.message);
    return null;
  }
}

function save(key, session) {
  if (!enabled() || !session) return;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    if (!(await ensureTable())) return;
    try {
      await db().$executeRawUnsafe(
        `INSERT INTO cerebro_sessions (key, user_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        key, String(session.userId), JSON.stringify(slim(session)));
    } catch (e) {
      console.error('sessionStore: gravação falhou:', e.message);
    }
  }, 1500));
}

async function remove(key) {
  if (!enabled() || !(await ensureTable())) return;
  try { await db().$executeRawUnsafe('DELETE FROM cerebro_sessions WHERE key = $1', key); } catch (e) { /* só log */ }
}

// Na subida do servidor: cria a tabela e informa quantas conversas estão guardadas
async function warmup() {
  if (!enabled()) return console.log('💾 conversas no banco: desligado');
  if (!(await ensureTable())) return;
  try {
    const r = await db().$queryRawUnsafe('SELECT COUNT(*)::int AS n FROM cerebro_sessions');
    console.log(`💾 conversas no banco: ${r[0].n} guardadas`);
  } catch (e) { console.error('sessionStore: contagem falhou:', e.message); }
}

module.exports = { load, save, remove, slim, warmup };
