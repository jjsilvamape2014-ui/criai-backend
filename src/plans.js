// Planos e preços num lugar só. Tudo pode ser trocado por variável de ambiente
// sem mexer no código.
//
// Unidade: 1 crédito = 1 imagem. Vídeo usa VIDEO_CREDITS_PER_5S créditos a cada
// 5 segundos (padrão 10 → 2 créditos por segundo).
//
// Campos do usuário (sem mudar o banco):
//   creditsImages    créditos de IMAGEM do mês (renovam no dia 1)
//   creditsVideos    créditos de VÍDEO do mês do plano grátis (renovam no dia 1)
//   creditsPurchased créditos avulsos comprados (não vencem; servem para imagem e vídeo)
// O PREMIUM recebe as imagens do mês em creditsImages e os vídeos são contados
// pelo limite mensal (videoQuota), em créditos.
//
// Os PACOTES DE VÍDEO (videoPackages) são vendidos em clipes de 5 s, mas entram no
// MESMO saldo creditsPurchased: o crédito é a moeda única do app, e criar uma coluna
// separada exigiria mexer em todos os pontos de cobrança/estorno (generate, cerebro,
// vídeo falado). O preço por clipe fica abaixo do preço por clipe do PREMIUM e bem
// acima do custo real (wan-2.2-fast ≈ US$ 0,059 por clipe de 5 s ≈ R$ 0,32), com
// margem > 85%.
//
// Os catálogos são FUNÇÕES (não arrays congelados) para que uma troca de variável
// de ambiente valha em tudo que lê daqui — inclusive o resumo da tela de planos.

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : d;
};

const per5s = () => Math.max(1, num('VIDEO_CREDITS_PER_5S', 10));

const FREE = {
  images: () => num('FREE_MONTHLY_IMAGES', 10),
  videoCredits: () => num('FREE_MONTHLY_VIDEO_CREDITS', 10), // 10 = um vídeo de 5 s
};

const PREMIUM = {
  // R$ 49,90 é o preço que o site no ar anuncia (landing e as páginas de SEO) e o
  // padrão histórico do checkout. NÃO mexer sem trocar o texto dessas páginas junto,
  // senão o Stripe cobra um valor diferente do anunciado (CDC art. 30).
  priceCents: () => num('PREMIUM_PRICE_CENTS', 4990),
  images: () => num('PREMIUM_MONTHLY_IMAGES', 50),
  videoCredits: () => num('PREMIUM_VIDEO_LIMIT', 30), // 30 = 15 s de vídeo por mês
};

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Pacotes de IMAGEM (o crédito é genérico: serve para imagem e para vídeo)
function creditPackages() {
  const per5 = per5s();
  return [
    { id: 'credits_30', name: 'Pacote 30', credits: 30, price: num('PACK_30_CENTS', 1990) },
    { id: 'credits_100', name: 'Pacote 100', credits: 100, price: num('PACK_100_CENTS', 5990) },
    { id: 'credits_250', name: 'Pacote 250', credits: 250, price: num('PACK_250_CENTS', 13990) },
  ].map((p) => ({
    ...p,
    kind: 'images',
    priceFormatted: brl(p.price),
    // as duas leituras do mesmo saldo (a tela de planos mostra as duas)
    images: p.credits,
    videos: Math.floor(p.credits / per5),
  }));
}

// Pacotes de VÍDEO: cobrados por clipe de 5 s (ver comentário no topo do arquivo)
function videoPackages() {
  const per5 = per5s();
  return [
    { id: 'video_5', name: 'Pacote Vídeo 5', clips: 5, price: num('PACK_VIDEO_5_CENTS', 2990) },
    { id: 'video_15', name: 'Pacote Vídeo 15', clips: 15, price: num('PACK_VIDEO_15_CENTS', 7990) },
    { id: 'video_40', name: 'Pacote Vídeo 40', clips: 40, price: num('PACK_VIDEO_40_CENTS', 19990) },
  ].map((p) => ({
    ...p,
    kind: 'video',
    credits: p.clips * per5,
    seconds: p.clips * 5,
    priceFormatted: brl(p.price),
    pricePerClipFormatted: brl(Math.round(p.price / p.clips)),
    images: 0,
    videos: p.clips,
  }));
}

// Procura um pacote (de imagem OU de vídeo) pelo id. Devolve null se não existir —
// é o que o checkout usa para recusar pacote inválido ANTES de falar com o Stripe.
function findPackage(id) {
  if (!id) return null;
  return creditPackages().find((p) => p.id === id) || videoPackages().find((p) => p.id === id) || null;
}

function nextMonthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

// Resumo para a tela de planos (o que o cliente vê é exatamente o que o servidor aplica)
function summary() {
  const per5 = per5s();
  return {
    videoCreditsPer5s: per5,
    free: { images: FREE.images(), videoCredits: FREE.videoCredits(), videoSeconds: Math.floor(FREE.videoCredits() / per5) * 5 },
    premium: {
      price: PREMIUM.priceCents(), priceFormatted: brl(PREMIUM.priceCents()),
      images: PREMIUM.images(), videoCredits: PREMIUM.videoCredits(),
      videoSeconds: Math.floor(PREMIUM.videoCredits() / per5) * 5,
    },
    packages: creditPackages(),
    videoPackages: videoPackages(),
  };
}

module.exports = {
  FREE, PREMIUM, creditPackages, videoPackages, findPackage,
  nextMonthStart, summary, brl, per5s
};
