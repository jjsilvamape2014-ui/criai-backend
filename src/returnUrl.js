// Para onde o Stripe devolve o cliente depois do pagamento.
//
// ARMADILHA QUE ISSO RESOLVE: FRONTEND_URL é uma LISTA (separada por vírgula), a
// mesma que o CORS usa em src/index.js. O checkout colava o valor cru no
// success_url e o resultado era:
//
//   https://criai-frontend-production.up.railway.app,https://ia.linhafacil2026.com.br,http://localhost:3000/dashboard?success=true...
//
// O Stripe recusa URL inválida, então /create-checkout-session respondia 500 e
// NENHUMA compra começava — nem assinatura, nem pacote. Aqui a lista é partida em
// pedaços e só uma URL vai para o Stripe.
//
// CHECKOUT_RETURN_URL, quando existir, manda em tudo (é o jeito explícito de
// escolher o domínio bonito em vez do alias .up.railway.app).

function normaliza(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function returnBase(env = process.env) {
  const explicito = normaliza(env.CHECKOUT_RETURN_URL);
  if (explicito) return explicito;

  const lista = String(env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map(normaliza)
    .filter(Boolean);

  // Preferência: primeira URL pública (nem localhost, nem loopback). É determinístico
  // — quem quiser outro domínio define CHECKOUT_RETURN_URL.
  const publica = lista.find((u) => /^https?:\/\//i.test(u) && !/localhost|127\.0\.0\.1/i.test(u));
  return publica || lista[0] || 'http://localhost:3000';
}

function checkoutUrls(env = process.env) {
  const base = returnBase(env);
  return {
    base,
    success_url: `${base}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/plans?canceled=true`,
  };
}

module.exports = { returnBase, checkoutUrls };
