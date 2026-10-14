// Planos e preços num lugar só. Tudo pode ser trocado por variável de ambiente
// sem mexer no código.
//
// Unidade: 1 crédito = 1 imagem. Vídeo usa VIDEO_CREDITS_PER_5S créditos a cada
// 5 segundos (padrão 10 → 2 créditos por segundo). Com isso, cada crédito custa
// mais ou menos o mesmo no fal, seja imagem ou vídeo (out/2026, aproximado:
// imagem ≈ US$ 0,05–0,06; vídeo Kling 3 ≈ US$ 0,112/s → US$ 0,056 por crédito).
//
// Campos do usuário (sem mudar o banco):
//   creditsImages    créditos de IMAGEM do mês (renovam no dia 1)
//   creditsVideos    créditos de VÍDEO do mês do plano grátis (renovam no dia 1)
//   creditsPurchased créditos avulsos comprados (não vencem; servem para imagem e vídeo)
// O PREMIUM recebe as imagens do mês em creditsImages e os vídeos são contados
// pelo limite mensal (videoQuota), em créditos.

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : d;
};

const FREE = {
  images: () => num('FREE_MONTHLY_IMAGES', 10),
  videoCredits: () => num('FREE_MONTHLY_VIDEO_CREDITS', 10), // 10 = um vídeo de 5 s
};

const PREMIUM = {
  priceCents: () => num('PREMIUM_PRICE_CENTS', 4990),
  images: () => num('PREMIUM_MONTHLY_IMAGES', 50),
  videoCredits: () => num('PREMIUM_VIDEO_LIMIT', 30), // 30 = 15 s de vídeo por mês
};

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const CREDIT_PACKAGES = [
  { id: 'credits_30', name: 'Pacote 30', credits: 30, price: num('PACK_30_CENTS', 1990) },
  { id: 'credits_100', name: 'Pacote 100', credits: 100, price: num('PACK_100_CENTS', 5990) },
  { id: 'credits_250', name: 'Pacote 250', credits: 250, price: num('PACK_250_CENTS', 13990) },
].map((p) => ({
  ...p,
  priceFormatted: brl(p.price),
  // campos antigos que a tela de planos ainda lê
  images: p.credits,
  videos: 0,
}));

function nextMonthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

// Resumo para a tela de planos (o que o cliente vê é exatamente o que o servidor aplica)
function summary() {
  const per5 = Math.max(1, num('VIDEO_CREDITS_PER_5S', 10));
  return {
    videoCreditsPer5s: per5,
    free: { images: FREE.images(), videoCredits: FREE.videoCredits(), videoSeconds: Math.floor(FREE.videoCredits() / per5) * 5 },
    premium: {
      price: PREMIUM.priceCents(), priceFormatted: brl(PREMIUM.priceCents()),
      images: PREMIUM.images(), videoCredits: PREMIUM.videoCredits(),
      videoSeconds: Math.floor(PREMIUM.videoCredits() / per5) * 5,
    },
    packages: CREDIT_PACKAGES,
  };
}

module.exports = { FREE, PREMIUM, CREDIT_PACKAGES, nextMonthStart, summary, brl };
