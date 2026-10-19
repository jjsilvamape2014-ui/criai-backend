// Testes do sync de boot (schema de motion presets).
// Rodar: npm test — NÃO toca em banco: só o parser do arquivo de migração real,
// que é o que garante que aplicar duas vezes em produção vira no-op.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { splitStatements, jaExiste } = require('../src/scripts/sync-motion-presets');

const MIGRATION = path.join(__dirname, '..', 'prisma', 'migrations', '20261018143052_add_motion_presets', 'migration.sql');

test('migração real: 6 statements idempotentes, nenhum com dollar-quoting', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  // asserção que o próprio script faz no boot — aqui cobrimos o arquivo de verdade
  assert.ok(!sql.includes('$$'), 'migration.sql não pode conter blocos dollar-quoted');

  const statements = splitStatements(sql);
  assert.strictEqual(statements.length, 6);
  for (const s of statements) {
    assert.ok(!s.includes('$$'), `statement com dollar-quoting: ${s.slice(0, 60)}`);
    assert.ok(!s.includes('--'), 'comentários não podem vazar para dentro do statement');
  }

  // cada statement tem o guarda IF NOT EXISTS — sem ele, re-aplicar derruba o boot
  assert.ok(statements[0].startsWith('CREATE TABLE IF NOT EXISTS "motion_presets"'));
  assert.ok(statements[1].startsWith('CREATE UNIQUE INDEX IF NOT EXISTS "motion_presets_slug_key"'));
  assert.ok(statements[2].startsWith('CREATE INDEX IF NOT EXISTS "motion_presets_group_position_idx"'));
  assert.ok(statements[3].startsWith('CREATE INDEX IF NOT EXISTS "motion_presets_enabled_position_idx"'));
  assert.ok(statements[4].startsWith('ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "motion_preset_id" TEXT'));
  assert.ok(statements[5].startsWith('CREATE INDEX IF NOT EXISTS "generations_motion_preset_id_idx"'));

  // nada sem forma idempotente nativa: nem FK (removida de propósito) nem CHECK
  for (const s of statements) {
    assert.ok(!/ADD CONSTRAINT/i.test(s), 'constraint não tem IF NOT EXISTS — proibido na migração');
    assert.ok(!/FOREIGN KEY/i.test(s), 'FK não tem forma guardada — proibida na migração');
    assert.ok(!/CHECK\s*\(/i.test(s), 'CHECK não tem forma guardada — proibido na migração');
  }
});

test('split falha alto se aparecer dollar-quoting (o split ingênuo ficaria errado)', () => {
  // montado sem String.replace: '$$' no replacement seria escape de '$'
  const sql = 'CREATE TABLE t (a text);\nCREATE FUNCTION f() RETURNS trigger AS begin end;\n' + '$$ corpo dollar-quoted $$\n';
  assert.ok(sql.includes('$$'));
  assert.throws(() => splitStatements(sql), /dollar-quoted/);
  // e o arquivo real, coberto no teste acima, passa: nenhum $$ em lugar nenhum
  assert.ok(!fs.readFileSync(MIGRATION, 'utf8').includes('$$'));
});

test('split falha alto se houver ";" dentro de string literal', () => {
  assert.throws(() => splitStatements("INSERT INTO t VALUES ('a;b');"), /string literal/);
  // string escapada com aspa dupla continua segura e é um statement só
  const ok = splitStatements("INSERT INTO t VALUES ('a''b');\nSELECT 1;");
  assert.strictEqual(ok.length, 2);
});

test('"já existe" (SQLSTATE ou mensagem) conta como sucesso; outro erro propaga', () => {
  // Prisma P2010 com meta.code do Postgres: o formato real de erro de SQL cru
  assert.strictEqual(jaExiste({ code: 'P2010', meta: { code: '42P07', message: 'relation "motion_presets" already exists' } }), true);
  assert.strictEqual(jaExiste({ code: 'P2010', meta: { code: '42701', message: 'column "motion_preset_id" of relation "generations" already exists' } }), true);
  assert.strictEqual(jaExiste({ code: 'P2010', meta: { code: '42710', message: 'relation "motion_presets_slug_key" already exists' } }), true);
  assert.strictEqual(jaExiste(new Error('duplicate key value violates unique constraint "motion_presets_slug_key"')), true);
  // erro de verdade NÃO pode ser engolido (senão o deploy seguiria quebrado)
  assert.strictEqual(jaExiste(new Error('permission denied for schema public')), false);
  assert.strictEqual(jaExiste({ code: 'P1001', message: "Can't reach database server" }), false);
});
