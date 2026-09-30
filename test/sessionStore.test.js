const test = require('node:test');
const assert = require('node:assert');
const SS = require('../src/sessionStore');

test('slim tira base64 grande e mantém URLs e textos', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(200 * 1024);
  const s = SS.slim({ id: 'x', memory: { refImages: [big, 'https://x/y.png'], project: { brand: 'JN' } }, history: [{ message: 'oi', imageUrl: big }] });
  assert.deepStrictEqual(s.memory.refImages, [null, 'https://x/y.png']);
  assert.strictEqual(s.history[0].imageUrl, null);
  assert.strictEqual(s.memory.project.brand, 'JN');
});
test('sem DATABASE_URL não tenta gravar nem ler', async () => {
  const old = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  assert.strictEqual(await SS.load('a::b'), null);
  SS.save('a::b', { userId: 'a' });
  if (old) process.env.DATABASE_URL = old;
});
