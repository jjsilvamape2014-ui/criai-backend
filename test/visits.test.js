// Visitas para o painel do dono. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/visits');

test('de onde veio: utm, redes, google, direto', () => {
  assert.strictEqual(V.origemDe({ utm: 'Instagram_Bio' }), 'instagram_bio');
  assert.strictEqual(V.origemDe({ referrer: 'https://l.instagram.com/?u=x' }), 'instagram');
  assert.strictEqual(V.origemDe({ referrer: 'https://www.google.com.br/' }), 'google');
  assert.strictEqual(V.origemDe({ referrer: 'https://ia.linhafacil2026.com.br/plans' }), 'direto');
  assert.strictEqual(V.origemDe({ referrer: '' }), 'direto');
});
test('robôs, painel e visita sem id não são gravados', async () => {
  const rows = []; V._internals.setPrisma({ $executeRawUnsafe: async (sql, ...a) => { if (/^INSERT/.test(sql)) rows.push(a); } });
  assert.strictEqual(await V.record({ visitor: 'a', path: '/', ua: 'Googlebot/2.1' }), false);
  assert.strictEqual(await V.record({ visitor: 'a', path: '/admin', ua: 'Mozilla' }), false);
  assert.strictEqual(await V.record({ visitor: '', path: '/', ua: 'Mozilla' }), false);
  assert.strictEqual(await V.record({ visitor: 'abc', path: '/plans', ua: 'Mozilla', utm: 'whatsapp' }), true);
  assert.deepStrictEqual(rows, [['abc', null, '/plans', 'whatsapp']]);
});
