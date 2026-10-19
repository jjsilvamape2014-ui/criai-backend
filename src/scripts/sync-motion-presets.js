// Sincroniza o schema mínimo de motion presets e mantém a tabela populada.
// Criado para o deploy da Railway, que NÃO roda migração (nixpacks sobe direto com
// `node src/boot.js`) e cujo DATABASE_URL só é alcançável de dentro da rede interna
// — ou seja, ninguém consegue aplicar a migração à mão.
//
// Absorve o antigo src/scripts/seed-motion-presets.js (um script só, sem duplicação):
// a lógica de upsert por slug vive aqui, e a proteção de recusar sem DATABASE_URL
// foi mantida — tanto no CLI quanto dentro do run().
//
// Uso via CLI: node src/scripts/sync-motion-presets.js  (recusa sem DATABASE_URL)
// Uso via boot: require('./scripts/sync-motion-presets').run()
const fs = require('fs');
const path = require('path');

// Única fonte de verdade do schema: o MESMO arquivo que o histórico do prisma tem.
// Se um dia a migração mudar, este script muda junto sem precisar de código novo.
const MIGRATION_SQL = path.join(__dirname, '..', '..', 'prisma', 'migrations', '20261018143052_add_motion_presets', 'migration.sql');
const PRESETS_JSON = path.join(__dirname, '..', 'data', 'motion-presets.json');

// SQLSTATEs que significam "já existe" — re-aplicar a migração é no-op, não falha:
// 42P06/42P07 (tabela), 42710 (objeto, ex.: índice com mesmo nome), 42701 (coluna).
const CODIGOS_JA_EXISTE = new Set(['42P06', '42710', '42P07', '42701']);

// Divide o arquivo de migração em statements executáveis.
// Regras do arquivo (asserções abaixo falham alto se violadas): sem dollar-quoting e
// sem ';' dentro de string literal — nesses casos o split ingênuo ficaria ERRADO e a
// gente prefere recusar a executar SQL quebrado em produção.
// Comentários ("--" e blocos) são descartados do statement, nunca viram SQL.
function splitStatements(sql) {
  if (sql.includes('$$')) {
    throw new Error('migration.sql contém bloco dollar-quoted — o split de statements não é seguro. Refatore a migração.');
  }
  const statements = [];
  let atual = '';
  let emString = false;
  let emLinha = false;   // comentário até o fim da linha
  let emBloco = false;   // comentário /* ... */

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prox = sql[i + 1];

    if (emLinha) {
      if (ch === '\n') { emLinha = false; atual += ch; } // quebra vira espaço entre statements
      continue;
    }
    if (emBloco) {
      if (ch === '*' && prox === '/') { emBloco = false; i++; }
      continue;
    }
    if (emString) {
      if (ch === ';') {
        throw new Error("migration.sql contém ';' dentro de string literal — o split de statements não é seguro. Refatore a migração.");
      }
      atual += ch;
      if (ch === "'") {
        if (prox === "'") { atual += prox; i++; } // aspa dupla escapada dentro da string
        else emString = false;
      }
      continue;
    }

    if (ch === '-' && prox === '-') { emLinha = true; i++; continue; }
    if (ch === '/' && prox === '*') { emBloco = true; i++; continue; }
    if (ch === "'") { emString = true; atual += ch; continue; }
    if (ch === ';') {
      const pronto = atual.trim();
      if (pronto) statements.push(pronto);
      atual = '';
      continue;
    }
    atual += ch;
  }

  if (emString) throw new Error('migration.sql terminou com string literal aberta — o split de statements não é seguro.');
  if (emBloco) throw new Error('migration.sql terminou com comentário de bloco aberto — o split de statements não é seguro.');
  const resto = atual.trim();
  if (resto) statements.push(resto);
  if (!statements.length) throw new Error('migration.sql não gerou nenhum statement — recusado.');
  return statements;
}

// Texto do erro juntando mensagem, código Prisma e meta (o SQLSTATE do Postgres
// costuma vir em err.meta.code, ex.: P2010 + meta.code = "42P07").
function textoErro(err) {
  if (!err) return '';
  const partes = [String(err.message || ''), String(err.code || '')];
  if (err.meta) {
    try { partes.push(JSON.stringify(err.meta)); } catch (e) { /* meta exótico não é o caso aqui */ }
  }
  return partes.join(' ');
}

// "já existe" (SQLSTATE acima ou mensagem equivalente) → sucesso silencioso.
// Qualquer OUTRO erro é erro de verdade e deve derrubar o deploy (boot.js → exit 1).
function jaExiste(err) {
  const texto = textoErro(err);
  const encontrado = texto.match(/\b(42P06|42710|42P07|42701)\b/i);
  if (encontrado && CODIGOS_JA_EXISTE.has(encontrado[1].toUpperCase())) return true;
  return /already exists|duplicate key/i.test(texto);
}

// Aplica a migração statement a statement. "Já existe" conta como sucesso;
// qualquer outro erro PROPAGA (quem chama decide se aborta o boot).
async function aplicarMigracao(prisma, sql) {
  const statements = splitStatements(sql);
  let aplicadas = 0;
  let ignoradas = 0;
  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      aplicadas++;
    } catch (err) {
      if (jaExiste(err)) { ignoradas++; continue; }
      throw err;
    }
  }
  return { statements: statements.length, aplicadas, ignoradas };
}

// Semeia o registry a partir do JSON — upsert por slug (idempotente, como era o
// antigo seed-motion-presets.js). Só é chamado com a tabela VAZIA.
async function semear(prisma) {
  const PRESETS = require(PRESETS_JSON);
  let semeados = 0;
  for (let i = 0; i < PRESETS.length; i++) {
    const p = PRESETS[i];
    const data = {
      slug: p.slug,
      name: p.name,
      group: p.group,
      labelPt: p.labelPt || null,
      prompt: p.prompt,
      negative: p.negative,
      supportedModels: p.supportedModels || [],
      badge: p.badge || null,
      confidence: p.confidence || 'medium',
      originalBaseModel: p.originalBaseModel || null,
      previewUrl: p.previewUrl || null,
      enabled: true,
      // posição = ordem do JSON (a UI lista nessa ordem)
      position: i
    };
    // upsert por slug: já existindo (id do JSON ou não), só atualiza
    await prisma.motionPreset.upsert({
      where: { slug: p.slug },
      update: data,
      create: { id: p.id, ...data }
    });
    semeados++;
  }
  return semeados;
}

// Sincronização completa: aplica a migração idempotente e garante que a tabela
// tenha presets. Com DATABASE_URL ausente recusa ANTES de qualquer conexão
// (mesma proteção do antigo seed: nunca toca em banco alheio).
// Aceita um prisma injetado para teste; sem injetado, cria e desconecta o seu.
async function run(prismaInjetado) {
  const inicio = Date.now();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurada — sincronização recusada (nenhum banco foi tocado).');
  }

  let prisma = prismaInjetado;
  const proprio = !prisma;
  if (!prisma) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }

  try {
    const sql = fs.readFileSync(MIGRATION_SQL, 'utf8');
    const { statements, aplicadas, ignoradas } = await aplicarMigracao(prisma, sql);

    // Seed SÓ quando a tabela está vazia: boot normal não sobrescreve linha nenhuma.
    let presets = await prisma.motionPreset.count();
    let semeados = 0;
    if (presets === 0) semeados = await semear(prisma);
    if (semeados > 0) presets = await prisma.motionPreset.count();

    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(
      `✔ Sync de motion presets: ${statements} statements da migração (${aplicadas} aplicados, ${ignoradas} já existentes), ` +
      `${presets} presets na tabela${semeados ? `, ${semeados} semeados agora` : ''}, ${segundos}s.`
    );
    return { statements, aplicadas, ignoradas, presets, semeados };
  } finally {
    if (proprio) await prisma.$disconnect();
  }
}

module.exports = { run, splitStatements, aplicarMigracao, jaExiste, semear, MIGRATION_SQL };

// Execução direta (CLI): node src/scripts/sync-motion-presets.js
if (require.main === module) {
  require('dotenv').config();
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('✗ Sincronização de motion presets falhou:', err && err.message ? err.message : err);
      if (err && err.stack) console.error(err.stack);
      process.exit(1);
    });
}
