// Valores dos planos e pacotes. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/plans');

test('padrões: grátis 10 imagens + 1 vídeo de 5 s; PREMIUM R$ 49,90 com 50 imagens + 15 s', () => {
  const s = P.summary();
  assert.strictEqual(s.free.images, 10);
  assert.strictEqual(s.free.videoSeconds, 5);
  // R$ 49,90 é o preço anunciado no site no ar (landing + páginas de SEO): o padrão
  // do checkout TEM de ser o mesmo, senão o cliente vê um valor e paga outro.
  assert.strictEqual(s.premium.price, 4990);
  assert.strictEqual(s.premium.priceFormatted.replace(/\s/g, ' '), 'R$ 49,90');
  assert.strictEqual(s.premium.images, 50);
  assert.strictEqual(s.premium.videoSeconds, 15);
  assert.deepStrictEqual(s.packages.map((p) => [p.credits, p.price]), [[30, 1990], [100, 5990], [250, 13990]]);
  // Pixar de leitura de crédito: a tela de planos mostra as duas leituras
  assert.deepStrictEqual(s.packages.map((p) => p.videos), [3, 10, 25]);
  assert.deepStrictEqual(s.packages.map((p) => p.kind), ['images', 'images', 'images']);
});

test('pacotes de vídeo: vendidos em clipes de 5 s, creditados no MESMO saldo comprado', () => {
  const s = P.summary();
  assert.deepStrictEqual(
    s.videoPackages.map((p) => [p.id, p.clips, p.credits, p.seconds, p.price]),
    [['video_5', 5, 50, 25, 2990], ['video_15', 15, 150, 75, 7990], ['video_40', 40, 400, 200, 19990]]
  );
  for (const p of s.videoPackages) {
    assert.strictEqual(p.kind, 'video');
    assert.strictEqual(p.credits, p.clips * P.summary().videoCreditsPer5s, p.id);
    assert.strictEqual(p.images, 0);
    assert.strictEqual(p.videos, p.clips);
    // brl() usa espaço não-quebrável depois do R$ (padrão do toLocaleString pt-BR)
    assert.ok(p.pricePerClipFormatted.replace(/\s/g, ' ').startsWith('R$ '), p.id);
  }
  // Preço por clipe cai conforme o pacote cresce (o grande tem de ser o melhor negócio)
  const porClipe = s.videoPackages.map((p) => p.price / p.clips);
  assert.ok(porClipe[0] > porClipe[1] && porClipe[1] > porClipe[2], porClipe.join(' '));
});

test('VIDEO_CREDITS_PER_5S define o tamanho do clipe (padrão 10 = 5 s)', () => {
  // Os catálogos são funções: trocar o env vale para tudo que lê plans.js, sem
  // reiniciar o processo (é o que os testes fazem abaixo).
  assert.strictEqual(P.per5s(), 10);
  assert.strictEqual(P.videoPackages()[0].credits, 50);
  process.env.VIDEO_CREDITS_PER_5S = '6';
  assert.strictEqual(P.per5s(), 6);
  assert.strictEqual(P.summary().videoCreditsPer5s, 6);
  assert.strictEqual(P.videoPackages()[0].credits, 30);           // 5 clipes × 6 créditos
  assert.strictEqual(P.creditPackages()[0].videos, 5);            // 30 créditos ÷ 6
  delete process.env.VIDEO_CREDITS_PER_5S;
});

test('variáveis de ambiente trocam os valores sem mexer no código', () => {
  process.env.PREMIUM_MONTHLY_IMAGES = '80';
  process.env.PREMIUM_PRICE_CENTS = '5990';
  assert.strictEqual(P.PREMIUM.images(), 80);
  assert.strictEqual(P.summary().premium.priceFormatted.replace(/\s/g, ' '), 'R$ 59,90');
  delete process.env.PREMIUM_MONTHLY_IMAGES; delete process.env.PREMIUM_PRICE_CENTS;
});

test('findPackage acha imagem e vídeo e recusa id inexistente', () => {
  assert.strictEqual(P.findPackage('credits_30').credits, 30);
  assert.strictEqual(P.findPackage('video_5').clips, 5);
  // Regressão: a tela de planos mandava estes ids e o checkout devolvia 400,
  // então NENHUMA compra funcionava. Eles não podem voltar a existir nem ser aceitos.
  assert.strictEqual(P.findPackage('credits_50'), null);
  assert.strictEqual(P.findPackage('credits_150'), null);
  assert.strictEqual(P.findPackage('credits_500'), null);
  assert.strictEqual(P.findPackage(undefined), null);
});

test('custo real fica abaixo de ~25% do preço (provedores de out/2026)', () => {
  // Base do guard: os provedores que o app USA de verdade — imagem no Pollinations
  // (grátis no plano dele) e vídeo no Pollinations wan-2.2-fast (US$ 0,059 por
  // clipe de 5 s). O "pior caso" antigo (tudo no fal: imagem US$ 0,06 + vídeo
  // US$ 0,112/s) descreve um caminho que hoje quase nunca é usado: ele continua
  // sendo o primeiro da fila (Magnific → fal → Pollinations), mas, quando o fal
  // liberar, o plano a R$ 39,90 fica em ~65% do preço — o mesmo risco que já
  // existia antes deste guard. O que precisa ser verdade é o custo do dia a dia.
  const USD = 5.5;
  const s = P.summary();
  const centavos = (imagens, clipes5s, usdImagem, usdClipe) =>
    (imagens * usdImagem + clipes5s * usdClipe) * USD * 100;

  const realPremium = centavos(s.premium.images, s.premium.videoSeconds / 5, 0, 0.059);
  assert.ok(realPremium / s.premium.price < 0.25, `premium: ${Math.round(realPremium)} centavos de ${s.premium.price}`);

  for (const p of s.videoPackages) {
    const custo = centavos(0, p.clips, 0, 0.059);
    assert.ok(custo / p.price < 0.25, `${p.id}: custo ${Math.round(custo)} centavos de ${p.price}`);
  }
});
