// Registro de "bateu no limite" / "abriu o pagamento" para o painel do dono. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/limitLog');

function fakeDb() {
  const rows = [];
  return {
    rows,
    $executeRawUnsafe: async (sql, ...args) => { if (/^INSERT/.test(sql)) rows.push({ user_id: args[0], rota: args[1] }); },
    $queryRawUnsafe: async () => {
      const m = new Map();
      for (const r of rows) {
        const x = m.get(r.user_id) || { user_id: r.user_id, vezes: 0, checkout: 0, ultima: new Date() };
        if (r.rota === 'checkout') x.checkout++; else x.vezes++;
        m.set(r.user_id, x);
      }
      return [...m.values()];
    },
  };
}

test('middleware registra só respostas NO_CREDITS de usuário logado', async () => {
  const db = fakeDb(); L._internals.setPrisma(db);
  const run = (user, body) => new Promise((done) => {
    const res = { json: (b) => b };
    L.middleware({ user, originalUrl: '/api/cerebro/chat' }, res, () => { res.json(body); setImmediate(done); });
  });
  await run({ id: 'u1' }, { code: 'NO_CREDITS' });
  await run({ id: 'u1' }, { success: true });
  await run(null, { code: 'NO_CREDITS' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(db.rows, [{ user_id: 'u1', rota: '/api/cerebro/chat' }]);
});

test('resumo separa limite de checkout e falha não derruba nada', async () => {
  const db = fakeDb(); L._internals.setPrisma(db);
  await L.record('u1', '/api/generate/image'); await L.record('u1', '/x'); await L.record('u2', 'checkout');
  const m = await L.byUserSince(new Date(0));
  assert.strictEqual(m.get('u1').vezes, 2); assert.strictEqual(m.get('u1').checkout, 0);
  assert.strictEqual(m.get('u2').checkout, 1);
  L._internals.setPrisma({ $executeRawUnsafe: async () => { throw new Error('sem banco'); } });
  await L.record('u3', 'x'); // não lança
  assert.strictEqual((await L.byUserSince(new Date(0))).size, 0);
});
