// Entrypoint de produção (nixpacks: [start] cmd = "node src/boot.js").
// Motivo: o deploy da Railway NÃO tem passo de migração e o DATABASE_URL só resolve
// dentro da rede interna — então o schema mínimo de motion presets é aplicado AQUI,
// antes de subir o servidor. O SQL é idempotente (IF NOT EXISTS), re-aplicar todo
// boot é um no-op barato, e NUNCA rodamos `prisma migrate deploy`: o histórico em
// _prisma_migrations é desconhecido (pode ter sido criado por db push) e isso
// tentaria re-rodar o init e derrubaria o deploy inteiro.
//
// Regras de segurança:
//   • Sem DATABASE_URL (dev local): avisa em pt-BR e sobe o servidor normalmente
//     (processo segue vivo, exit code 0) — nunca toca em banco.
//   • Erro real na sincronização: loga o erro COMPLETO e process.exit(1). Assim o
//     deploy falha e a Railway mantém a VERSÃO ANTIGA no ar — sem downtime, e muito
//     melhor do que subir com a coluna faltando e derrubar a geração de vídeo.
require('dotenv').config();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL não configurada — sincronização do banco pulada (dev local). Subindo o servidor assim mesmo.');
    require('./index');
    return;
  }

  try {
    const { run } = require('./scripts/sync-motion-presets');
    await run();
  } catch (err) {
    console.error('✗ Sincronização do banco falhou — deploy abortado, a versão anterior continua no ar.');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }

  // Sincronizou (ou já estava tudo no lugar): agora sim, sobe o servidor
  require('./index');
}

main().catch((err) => {
  console.error('✗ Boot falhou de forma inesperada:', err && err.stack ? err.stack : err);
  process.exit(1);
});
