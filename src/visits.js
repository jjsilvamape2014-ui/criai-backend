// Visitas do site, para o painel do dono. Sem cookies de terceiros e sem guardar IP:
// o navegador manda um id aleatório (localStorage) + página + de onde veio.
// Tabela própria criada sob demanda. Qualquer falha aqui só vai para o log.

let ready = null;
let prismaRef = null;
function db() {
  if (!prismaRef) { const { PrismaClient } = require('@prisma/client'); prismaRef = new PrismaClient(); }
  return prismaRef;
}
function ensure() {
  if (!ready) {
    ready = db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS visitas (
      id BIGSERIAL PRIMARY KEY,
      visitor TEXT NOT NULL,
      user_id TEXT,
      path TEXT,
      origem TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).then(() => db().$executeRawUnsafe('CREATE INDEX IF NOT EXISTS visitas_quando ON visitas (created_at DESC)'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|headless|lighthouse|monitor/i;
const clean = (v, n) => String(v || '').replace(/[^\w\-./:?=&%#@+ À-ú]/g, '').slice(0, n);

// "de onde veio": utm_source > domínio do referrer > "direto"
function origemDe({ referrer, utm }) {
  if (utm) return clean(utm, 40).toLowerCase();
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (!host || /linhafacil2026\.com\.br$/.test(host)) return 'direto';
    if (/google\./.test(host)) return 'google';
    if (/instagram|l\.instagram/.test(host)) return 'instagram';
    if (/facebook|fb\.com|m\.facebook|l\.facebook/.test(host)) return 'facebook';
    if (/whatsapp|wa\.me/.test(host)) return 'whatsapp';
    if (/tiktok/.test(host)) return 'tiktok';
    return host.slice(0, 40);
  } catch (e) { return 'direto'; }
}

async function record({ visitor, userId, path, referrer, utm, ua }) {
  if (!visitor || BOT.test(String(ua || ''))) return false;
  const p = clean(path, 120) || '/';
  if (p.startsWith('/admin')) return false;
  try {
    await ensure();
    await db().$executeRawUnsafe('INSERT INTO visitas (visitor, user_id, path, origem) VALUES ($1, $2, $3, $4)',
      clean(visitor, 40), userId ? String(userId) : null, p, origemDe({ referrer, utm }));
    return true;
  } catch (e) {
    console.warn('[visitas] não registrou:', e.message);
    return false;
  }
}

// Resumo do período + "agora" (últimos 15 min). ignoreUsers: ids do dono/testes.
async function summary(since, ignoreUsers = []) {
  const vazio = { visitantes: 0, visitas: 0, agora: 0, paginas: [], origens: [], porDia: [], recentes: [] };
  try {
    await ensure();
    const ign = ignoreUsers.length ? ignoreUsers : ['-'];
    // visitantes que alguma vez logaram como dono/teste ficam fora
    const filtro = `created_at >= $1 AND visitor NOT IN (SELECT DISTINCT visitor FROM visitas WHERE user_id = ANY($2::text[]))`;
    const q = (sql) => db().$queryRawUnsafe(sql, since, ign);
    const [tot, agora, paginas, origens, porDia, recentes] = await Promise.all([
      q(`SELECT COUNT(DISTINCT visitor)::int AS v, COUNT(*)::int AS n FROM visitas WHERE ${filtro}`),
      db().$queryRawUnsafe(`SELECT COUNT(DISTINCT visitor)::int AS v FROM visitas WHERE created_at >= now() - interval '15 minutes' AND visitor NOT IN (SELECT DISTINCT visitor FROM visitas WHERE user_id = ANY($1::text[]))`, ign),
      q(`SELECT path, COUNT(*)::int AS n FROM visitas WHERE ${filtro} GROUP BY path ORDER BY n DESC LIMIT 8`),
      q(`SELECT origem, COUNT(DISTINCT visitor)::int AS v FROM visitas WHERE ${filtro} GROUP BY origem ORDER BY v DESC LIMIT 8`),
      q(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'America/Fortaleza'), 'YYYY-MM-DD') AS dia, COUNT(DISTINCT visitor)::int AS v FROM visitas WHERE ${filtro} GROUP BY 1 ORDER BY 1`),
      q(`SELECT path, origem, created_at, (user_id IS NOT NULL) AS logado FROM visitas WHERE ${filtro} ORDER BY created_at DESC LIMIT 20`),
    ]);
    return {
      visitantes: (tot[0] && tot[0].v) || 0, visitas: (tot[0] && tot[0].n) || 0, agora: (agora[0] && agora[0].v) || 0,
      paginas, origens, porDia, recentes,
    };
  } catch (e) {
    console.warn('[visitas] não consegui ler:', e.message);
    return vazio;
  }
}

module.exports = { record, summary, origemDe, _internals: { setPrisma: (p) => { prismaRef = p; ready = null; } } };
