// Estado do Stripe numa linha, para o modo do pagamento nunca mais ficar invisível.
//
// MOTIVO: a produção estava subindo com chave de TESTE (`sk_test_…`) e sem
// STRIPE_WEBHOOK_SECRET. Nesse modo o Checkout só aceita cartão de teste, então
// NENHUM cliente consegue pagar de verdade — e o sintoma visível era "o site não
// vende", que não aponta para lugar nenhum. Aqui o diagnóstico sai no boot e em
// GET /api/diagnostics (só rótulos, nunca pedaços de chave).
//
// Não confundir com erro: rodar em modo de teste é normal em desenvolvimento. O
// alerta só é grave quando NODE_ENV=production.

function modo(env = process.env) {
  const chave = String(env.STRIPE_SECRET_KEY || '');
  if (!chave) return 'missing';
  if (chave.startsWith('sk_live_')) return 'live';
  if (chave.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

// Só rótulos e booleanos — nada que permita reconstruir a chave.
function section(env = process.env) {
  const m = modo(env);
  const { returnBase } = require('./returnUrl');
  return {
    mode: m, // 'live' | 'test' | 'missing' | 'unknown'
    canCharge: m === 'live', // o Stripe recusa cobrança real em qualquer outro modo
    webhookSecret: !!env.STRIPE_WEBHOOK_SECRET,
    returnBase: returnBase(env),
  };
}

// Mensagem em pt-BR para o log do boot, ou null quando está tudo certo.
function alerta(env = process.env) {
  const m = modo(env);
  const prod = env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT;

  if (m === 'missing') {
    return prod
      ? '✗ STRIPE_SECRET_KEY não configurada: NENHUMA compra pode ser feita. Configure a chave para o checkout funcionar.'
      : null; // dev sem chave é o caso normal; não poluir o log
  }

  if (m === 'test' && prod) {
    return '⚠️ Stripe rodando com CHAVE DE TESTE em produção: o Checkout só aceita cartão de teste, ou seja, NENHUM cliente consegue pagar. ' +
      'Ative a conta no painel do Stripe, use as chaves sk_live_…/pk_live_… e registre o webhook (node src/scripts/register-webhook.js <url-do-backend>).';
  }

  if (m === 'unknown') return '⚠️ STRIPE_SECRET_KEY não parece uma chave do Stripe (não começa com sk_live_ nem sk_test_): o checkout vai falhar.';

  if (m === 'live' && !env.STRIPE_WEBHOOK_SECRET) {
    return '⚠️ Stripe em produção real sem STRIPE_WEBHOOK_SECRET: quem pagar e fechar a aba do navegador antes de voltar ao site não recebe os créditos automaticamente.';
  }

  return null;
}

module.exports = { modo, section, alerta };
