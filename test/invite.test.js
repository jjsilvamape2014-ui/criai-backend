// Convite de clientes. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/invite');

function fakeDb() {
  const used = []; const users = { u1: 0, u2: 0, u3: 0 };
  return {
    used, users,
    $executeRawUnsafe: async (sql, ...a) => {
      if (/^INSERT/.test(sql)) { if (used.find((r) => r.user_id === a[0])) return 0; used.push({ user_id: a[0], code: a[1], credits: a[2] }); return 1; }
      return 0;
    },
    $queryRawUnsafe: async (sql, code) => [{ n: used.filter((r) => r.code === code).length }],
    user: { update: async ({ where, data }) => { users[where.id] += data.creditsPurchased.increment; } },
  };
}

test('código padrão LINHAFACIL dá 60 créditos, uma vez por conta, sem diferenciar maiúsculas', async () => {
  delete process.env.CONVITE_CODES; delete process.env.CONVITE_MAX;
  const db = fakeDb(); I._internals.setPrisma(db);
  assert.deepStrictEqual(await I.redeem('u1', 'linhafacil'), { ok: true, credits: 60 });
  assert.strictEqual(db.users.u1, 60);
  assert.strictEqual((await I.redeem('u1', 'LINHAFACIL')).ok, false);
  assert.strictEqual((await I.redeem('u2', 'ERRADO')).reason, 'código inválido');
});
test('limite de usos por código', async () => {
  process.env.CONVITE_MAX = '1';
  const db = fakeDb(); I._internals.setPrisma(db);
  assert.strictEqual((await I.redeem('u1', 'LINHAFACIL')).ok, true);
  assert.strictEqual((await I.redeem('u2', 'LINHAFACIL')).reason, 'convite esgotado');
  delete process.env.CONVITE_MAX;
});
test('falha no banco não quebra o cadastro', async () => {
  I._internals.setPrisma({ $executeRawUnsafe: async () => { throw new Error('x'); } });
  assert.deepStrictEqual(await I.redeem('u3', 'LINHAFACIL'), { ok: false, reason: 'erro' });
});
