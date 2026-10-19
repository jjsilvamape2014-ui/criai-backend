// Testes do vídeo novo (Kling 3), do limite do PREMIUM e do plano B do roteador.
// Rodar: npm test  (não chama a fal nem a IA: só funções puras e um prisma de mentira)
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/videoModels');
const Q = require('../src/videoQuota');

// --- modelos e esquema -------------------------------------------------------
test('padrão: Kling 3 Turbo Standard (imagem e texto) com o 2.1 de reserva', () => {
  delete process.env.VIDEO_I2V_MODEL; delete process.env.VIDEO_LEGACY_MODEL;
  assert.strictEqual(V.i2vModel(), 'fal-ai/kling-video/v3/turbo/standard/image-to-video');
  assert.strictEqual(V.t2vModel(), 'fal-ai/kling-video/v3/turbo/standard/text-to-video');
  assert.strictEqual(V.legacyModel(), 'fal-ai/kling-video/v2.1/standard/image-to-video');
  assert.ok(V.isKling3(V.i2vModel()));
  assert.ok(!V.isKling3(V.legacyModel()));
});
test('VIDEO_LEGACY_MODEL=none desliga a reserva', () => {
  process.env.VIDEO_LEGACY_MODEL = 'none';
  assert.strictEqual(V.legacyModel(), null);
  delete process.env.VIDEO_LEGACY_MODEL;
});
test('duração sempre entre 3 e 15 s (o que o modelo aceita)', () => {
  assert.strictEqual(V.clampDuration(1), 3);
  assert.strictEqual(V.clampDuration(30), 15);
  assert.strictEqual(V.clampDuration('10'), 10);
  assert.strictEqual(V.clampDuration('abc'), 5);
});
test('duração pedida em português', () => {
  assert.strictEqual(V.parseDuration('faz um vídeo de 10 segundos'), 10);
  assert.strictEqual(V.parseDuration('anima por 8s'), 8);
  assert.strictEqual(V.parseDuration('vídeo de 60 seg'), 15);
  assert.strictEqual(V.parseDuration('meio minuto'), 15);
  assert.strictEqual(V.parseDuration('faz um vídeo da pizzaria'), null);
});
test('formato pedido em português', () => {
  assert.strictEqual(V.parseAspect('vídeo para o reels'), '9:16');
  assert.strictEqual(V.parseAspect('formato quadrado para o feed'), '1:1');
  assert.strictEqual(V.parseAspect('vídeo horizontal para o YouTube'), '16:9');
  assert.strictEqual(V.parseAspect('um vídeo bonito'), null);
});
test('cenas: durações inteiras, mínimo 2 s cada, soma exata, até 6 cenas', () => {
  assert.deepStrictEqual(V.splitDurations(10, 3), [4, 3, 3]);
  assert.deepStrictEqual(V.splitDurations(15, 3), [5, 5, 5]);
  assert.strictEqual(V.splitDurations(4, 3).reduce((a, b) => a + b, 0), 6); // sobe p/ 2 s por cena
  assert.strictEqual(V.splitDurations(15, 10).length, 6);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const d = V.splitDurations(12, n);
    assert.ok(d.every((x) => x >= 2 && Number.isInteger(x)));
    assert.ok(d.reduce((a, b) => a + b, 0) <= 15);
  }
});
test('créditos pela duração: 10 a cada 5 s (1 crédito ≈ 1 imagem em custo)', () => {
  delete process.env.VIDEO_CREDITS_PER_5S;
  assert.strictEqual(V.creditsFor(5), 10);
  assert.strictEqual(V.creditsFor(3), 10);
  assert.strictEqual(V.creditsFor(10), 20);
  assert.strictEqual(V.creditsFor(15), 30);
  process.env.VIDEO_CREDITS_PER_5S = '1';
  assert.strictEqual(V.creditsFor(15), 3); // dá para voltar ao antigo
  delete process.env.VIDEO_CREDITS_PER_5S;
});
test('corpo imagem→vídeo do Kling 3: uma cena usa prompt+duração; várias usam multi_prompt', () => {
  const m = V.DEFAULTS.i2v;
  const one = V.i2vBody(m, { imageUrl: 'https://x/a.png', prompt: 'slow push-in', duration: 8 });
  assert.deepStrictEqual(one, { image_url: 'https://x/a.png', prompt: 'slow push-in', duration: '8' });
  const multi = V.i2vBody(m, { imageUrl: 'https://x/a.png', shots: [{ prompt: 'a', duration: 4 }, { prompt: 'b', duration: 6 }] });
  assert.deepStrictEqual(multi.multi_prompt, [{ prompt: 'a', duration: '4' }, { prompt: 'b', duration: '6' }]);
  assert.ok(!('prompt' in multi) && !('duration' in multi)); // são exclusivos no esquema
});
test('corpo da reserva (Kling 2.1): só 5 ou 10 s, sem multi_prompt', () => {
  const b = V.i2vBody(V.DEFAULTS.legacy, { imageUrl: 'u', prompt: 'p', duration: 15 });
  assert.strictEqual(b.duration, '10');
  assert.ok(!b.multi_prompt);
});
test('texto→vídeo: formato válido ou 9:16', () => {
  assert.strictEqual(V.t2vBody({ prompt: 'p', duration: 5, aspectRatio: '1:1' }).aspect_ratio, '1:1');
  assert.strictEqual(V.t2vBody({ prompt: 'p', duration: 5, aspectRatio: '4:3' }).aspect_ratio, '9:16');
});
test('URL do vídeo na resposta da fal', () => {
  assert.strictEqual(V.videoUrlFrom({ video: { url: 'https://v.mp4' } }), 'https://v.mp4');
  assert.strictEqual(V.videoUrlFrom({ video: 'https://v.mp4' }), 'https://v.mp4');
  assert.strictEqual(V.videoUrlFrom({}), null);
});

// --- limite do PREMIUM (em créditos de vídeo) --------------------------------
const fakePrisma = (used) => ({ generation: { aggregate: async () => ({ _sum: { cost: used } }) } });
test('PREMIUM dentro do limite: não desconta, mas registra o custo real', async () => {
  delete process.env.PREMIUM_VIDEO_LIMIT;
  const g = await Q.gate(fakePrisma(0), { id: 'u', plan: 'PREMIUM', creditsPurchased: 0 }, 20);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.free, true);
  assert.strictEqual(g.cost, 20); // vai para generation.cost e conta no limite
  assert.match(g.line, /usa 20 dos 30 créditos de vídeo/);
});
test('PREMIUM sem saldo do mês e sem comprado: bloqueia com mensagem', async () => {
  const g = await Q.gate(fakePrisma(20), { id: 'u', plan: 'PREMIUM', creditsPurchased: 0 }, 30);
  assert.strictEqual(g.ok, false);
  assert.match(g.error, /usa 30 créditos e restam 10/);
});
test('PREMIUM sem saldo do mês com crédito comprado: paga com o comprado', async () => {
  const g = await Q.gate(fakePrisma(30), { id: 'u', plan: 'PREMIUM', creditsPurchased: 40 }, 10);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.chargePurchased, true);
  assert.strictEqual(g.cost, 10);
});
test('PREMIUM_VIDEO_LIMIT=0 volta a ser ilimitado', async () => {
  process.env.PREMIUM_VIDEO_LIMIT = '0';
  const g = await Q.gate(fakePrisma(999), { id: 'u', plan: 'PREMIUM' }, 30);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.free, true);
  delete process.env.PREMIUM_VIDEO_LIMIT;
});
test('FREE: custo mostrado antes; sem crédito suficiente bloqueia', async () => {
  const ok = await Q.gate(fakePrisma(0), { id: 'u', plan: 'FREE', creditsVideos: 10, creditsPurchased: 5 }, 10);
  assert.strictEqual(ok.ok, true);
  assert.match(ok.line, /usa 10 créditos \(você tem 15\)/);
  const no = await Q.gate(fakePrisma(0), { id: 'u', plan: 'FREE', creditsVideos: 10, creditsPurchased: 0 }, 30);
  assert.strictEqual(no.ok, false);
});

// --- plano B do roteador --------------------------------------------------------
test('roteador falhou: pedido explícito segue; ambíguo pergunta', () => {
  const R = require('../src/router');
  assert.strictEqual(R.needsClarification('faz um vídeo da minha pizzaria', { hasImage: false }), false);
  assert.strictEqual(R.needsClarification('cria um post de promoção', { hasImage: true }), false);
  assert.strictEqual(R.needsClarification('tira o fundo', { hasImage: true }), false);
  assert.strictEqual(R.needsClarification('deixa mais bonito', { hasImage: true }), false);
  assert.strictEqual(R.needsClarification('oi, tudo bem?', { hasImage: false }), false);
  assert.strictEqual(R.needsClarification('algo legal pro dia das crianças', { hasImage: true }), true);
  assert.strictEqual(R.needsClarification('quero algo pra minha loja', { hasImage: false }), true);
});
test('resposta à pergunta vira o pedido completo', () => {
  const R = require('../src/router');
  const opts = R.clarifyOptions(true);
  assert.deepStrictEqual(opts, ['image', 'edit', 'video']);
  assert.strictEqual(R.clarifyChoice('2', opts), 'edit');
  assert.strictEqual(R.clarifyChoice('3', opts), 'video');
  assert.strictEqual(R.clarifyChoice('quero em vídeo', R.clarifyOptions(false)), 'video');
  assert.strictEqual(R.clarifyChoice('qual o horário de vocês?', opts), null);
  // o texto somado precisa ser entendido pelas regras sem ambiguidade
  const C = require('../src/contract');
  assert.strictEqual(C.detectRequested(R.applyClarifyChoice('algo pro dia das crianças', 'video')).tipo, 'video');
  assert.strictEqual(C.detectRequested(R.applyClarifyChoice('algo pro dia das crianças', 'image')).tipo, 'imagem');
});
test('vídeo criativo (clip) é vídeo para o contrato: pediu imagem, clip vira imagem', () => {
  const C = require('../src/contract');
  assert.strictEqual(C.enforce('clip', 'cria um post para instagram da promoção').action, 'image');
  assert.strictEqual(C.enforce('clip', 'um vídeo de um astronauta surfando').corrigido, false);
});

// --- recorte da tomada única (precisa do ffmpeg instalado) ------------------------
test('tomada única é cortada nas cenas com a duração certa', async (t) => {
  const { execFileSync } = require('child_process');
  try { execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { t.skip('ffmpeg não instalado'); return; }
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const A = require('../src/adVideo')._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomada-'));
  const full = path.join(dir, 'full.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=30', '-t', '9', '-pix_fmt', 'yuv420p', full], { stdio: 'ignore' });
  const durs = V.splitDurations(9, 3);
  let at = 0;
  for (let i = 0; i < durs.length; i++) {
    const seg = path.join(dir, `s${i}.mp4`);
    await A.cutSegment(full, at, durs[i], seg);
    const d = await A.mediaDuration(seg);
    assert.ok(Math.abs(d - durs[i]) < 0.15, `cena ${i + 1}: ${d}s, esperado ${durs[i]}s`);
    at += durs[i];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- conta do dono sem limite ------------------------------------------------
test('VIDEO_UNLIMITED_EMAILS: dono não tem limite nem cobrança', async () => {
  process.env.VIDEO_UNLIMITED_EMAILS = 'dono@exemplo.com, outro@x.com';
  const g = await Q.gate(fakePrisma(999), { id: 'u', email: 'Dono@Exemplo.com', plan: 'PREMIUM', creditsPurchased: 0 }, 3);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.free, true);
  assert.strictEqual(g.cost, 0);
  const other = await Q.gate(fakePrisma(999), { id: 'v', email: 'cliente@x.com', plan: 'PREMIUM', creditsPurchased: 0 }, 1);
  assert.strictEqual(other.ok, false);
  delete process.env.VIDEO_UNLIMITED_EMAILS;
});

// --- fala do apresentador nunca é o letreiro ------------------------------------
test('apresentador: fala ausente, igual ao letreiro ou em maiúsculas → fala padrão', () => {
  const { pickVoiceLine } = require('../src/presenterAd')._internals;
  const fb = 'E o melhor: atendimento rápido e preço justo.';
  assert.strictEqual(pickVoiceLine({ caption: 'INSTALAÇÃO RÁPIDA' }, fb), fb);
  assert.strictEqual(pickVoiceLine({ voice: 'INSTALAÇÃO RÁPIDA', caption: 'INSTALAÇÃO RÁPIDA' }, fb), fb);
  assert.strictEqual(pickVoiceLine({ voice: 'Instalação rápida', caption: 'INSTALAÇÃO RÁPIDA' }, fb), fb);
  assert.strictEqual(pickVoiceLine({ voice: 'ECONOMIA E SILÊNCIO TOTAL', caption: 'x' }, fb), fb);
  const ok = 'Instalamos no mesmo dia, sem bagunça na sua casa.';
  assert.strictEqual(pickVoiceLine({ voice: ok, caption: 'INSTALAÇÃO RÁPIDA' }, fb), ok);
});

// --- anúncio segue o pedido (casos reais das conversas) -------------------------
test('estilo do anúncio: cenas/roteiro → filmado; vinheta/logo → motion', () => {
  delete process.env.AD_DEFAULT_STYLE;
  const A = require('../src/adVideo');
  assert.strictEqual(A.pickStyle('VERSÃO 15 SEGUNDOS\nCena 1 (0–3s) – Cliente saindo satisfeito do estabelecimento.'), 'photo');
  assert.strictEqual(A.pickStyle('Faz um anuncio de promoção de vendas de lanche'), 'photo');
  assert.strictEqual(A.pickStyle('faz uma vinheta animada da minha logo'), 'motion');
  assert.strictEqual(A.pickStyle('anima a minha marca para abertura do canal'), 'motion');
  assert.strictEqual(A.pickStyle('faz com apresentadora mostrando o produto'), 'presenter');
  process.env.AD_DEFAULT_STYLE = 'motion';
  assert.strictEqual(A.pickStyle('faz um anúncio da JN'), 'motion');
  delete process.env.AD_DEFAULT_STYLE;
});
test('texto de anúncio colado não vira "personagem falando"', () => {
  const C = require('../src/contract');
  const colado = '“Sua loja merece ser bem avaliada! Transforme cada cliente satisfeito em uma nova avaliação no Google. Com a plaquinha NFC + QR Code, seus clientes deixam opiniões em segundos — é rápido, prático e seguro! Apenas aproxime o celular e diga adeus à falta de avaliações.”';
  assert.strictEqual(C.detectSpeech(colado, true), null);
  assert.ok(C.detectSpeech('faz o mascote falando: bom dia, eu sou o Delta', true));
  assert.ok(C.detectSpeech('cria um video de apresentação, falando bom dia eu sou o delta', true));
});

// --- presets de movimento de câmera (slice 1) --------------------------------
test('registry de movimentos: 65 presets, busca por id E por slug, nunca lança exceção', () => {
  const M = require('../src/motionPresets');
  assert.strictEqual(M.count, 65);
  assert.strictEqual(M.list().length, 65);
  const byId = M.get('cam_zoom_in');
  const bySlug = M.get('zoom-in');
  assert.ok(byId && bySlug);
  assert.strictEqual(byId, bySlug); // mesmo objeto responde pelos dois caminhos
  // preset faltando/vazio devolve null em vez de estourar
  assert.strictEqual(M.get('preset-que-nao-existe'), null);
  assert.strictEqual(M.get(''), null);
  assert.strictEqual(M.get(null), null);
  assert.strictEqual(M.get(undefined), null);
  // agrupamento: todos os 65 entram em algum grupo, na ordem do arquivo
  const { groups, count } = M.groups();
  assert.strictEqual(count, 65);
  assert.ok(Array.isArray(groups.base) && groups.base.length > 0);
  assert.strictEqual(Object.values(groups).flat().length, 65);
  // filtro por modelo (query ?models=)
  assert.ok(M.groups('kling-v3-i2v').count <= 65);
  assert.strictEqual(M.groups('modelo-que-nao-existe').count, 0);
});
test('preset de câmera só ADICIONA o movimento: não apaga o prompt já escolhido', () => {
  const M = require('../src/motionPresets');
  const preset = M.get('zoom-in');
  const anuncio = 'Fritadeira Air Fryer 10L, Punchy marketplace ad: quick energetic push-in zoom toward the product';
  const composto = M.composePrompt(anuncio, preset);
  // o texto do anúncio/pedido sobrevive intacto como prefixo
  assert.ok(composto.startsWith(anuncio));
  assert.strictEqual(composto, `${anuncio}. ${preset.prompt}`);
  // sem preset (ou sem texto base), nada muda: mesmo comportamento de antes
  assert.strictEqual(M.composePrompt(anuncio, null), anuncio);
  assert.strictEqual(M.composePrompt('', preset), preset.prompt);
  assert.strictEqual(M.composePrompt('', null), '');
});
test('motionPresetId desconhecido → recusa com mensagem em pt-BR (rota devolve 400)', () => {
  const M = require('../src/motionPresets');
  // campo opcional: ausente segue ok sem preset
  assert.deepStrictEqual(M.resolve(undefined), { ok: true, preset: null });
  assert.deepStrictEqual(M.resolve(''), { ok: true, preset: null });
  // id ou slug válidos são aceitos
  const ok = M.resolve('cam_zoom_in');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.preset.id, 'cam_zoom_in');
  assert.strictEqual(M.resolve('zoom-in').preset.id, 'cam_zoom_in');
  // desconhecido: ok:false com a mensagem que a rota devolve em 400
  const ruim = M.resolve('voo-drone-sobre-o-cristo');
  assert.strictEqual(ruim.ok, false);
  assert.strictEqual(ruim.preset, undefined);
  assert.match(ruim.error, /Movimento de câmera inválido/);
  assert.match(ruim.error, /voo-drone-sobre-o-cristo/);
});
