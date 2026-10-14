// 🎥 MODELOS DE VÍDEO (fal.ai) — um lugar só para escolher modelo, duração e formato.
//
// Antes: tudo ia para o Kling 2.1 Standard, sempre 5 s, sem escolher formato — e esse
// modelo está marcado como descontinuado no fal.ai. Agora:
//   • imagem → vídeo: Kling 3 Turbo Standard (3 a 15 s; aceita várias cenas num vídeo só)
//   • texto  → vídeo: Kling 3 Turbo Standard (sem precisar de imagem; 9:16, 1:1 ou 16:9)
//   • reserva: o Kling 2.1 antigo, se o novo falhar (enquanto a fal ainda o aceitar)
//
// Variáveis de ambiente (todas opcionais):
//   VIDEO_I2V_MODEL     endpoint de imagem→vídeo     (padrão abaixo)
//   VIDEO_T2V_MODEL     endpoint de texto→vídeo      (padrão abaixo)
//   VIDEO_LEGACY_MODEL  reserva de imagem→vídeo ("none" desliga)
//   VIDEO_CREDITS_PER_5S créditos de vídeo a cada 5 s (padrão 10: 5 s = 10, 15 s = 30)
//
// Esquemas conferidos na página de API de cada modelo no fal.ai (out/2026):
//   image-to-video: image_url, prompt | multi_prompt[{prompt,duration}], duration "3".."15"
//   text-to-video:  prompt | multi_prompt, aspect_ratio "16:9"|"9:16"|"1:1", duration "3".."15"
//   multi_prompt: 1 a 6 cenas, soma das durações até 15 s. Resposta: { video: { url } }

const DEFAULTS = {
  i2v: 'fal-ai/kling-video/v3/turbo/standard/image-to-video',
  t2v: 'fal-ai/kling-video/v3/turbo/standard/text-to-video',
  legacy: 'fal-ai/kling-video/v2.1/standard/image-to-video'
};

const MIN_S = 3;
const MAX_S = 15;
const MAX_SHOTS = 6;

function i2vModel() { return process.env.VIDEO_I2V_MODEL || DEFAULTS.i2v; }
function t2vModel() { return process.env.VIDEO_T2V_MODEL || DEFAULTS.t2v; }
function legacyModel() {
  const v = process.env.VIDEO_LEGACY_MODEL;
  if (v === 'none') return null;
  return v || DEFAULTS.legacy;
}

// Kling 3 / O3 aceitam duração de 3 a 15 s e várias cenas (multi_prompt); o 2.1 não.
function isKling3(model) {
  return /kling-video\/(v3|o3)\//.test(String(model || ''));
}

function clampDuration(n, fallback = 5) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.min(MAX_S, Math.max(MIN_S, x));
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "vídeo de 10 segundos", "10s", "15 seg", "meio minuto" → segundos (ou null se não disse)
function parseDuration(text) {
  const m = norm(text);
  if (/\bmeio minuto\b/.test(m)) return MAX_S; // o máximo do modelo; o roteiro avisa
  const r = m.match(/\b(\d{1,2})\s*(s|seg|segs|segundo|segundos)\b/);
  if (!r) return null;
  return clampDuration(Number(r[1]));
}

// Formato pedido em palavras → proporção do modelo (ou null se não disse)
function parseAspect(text) {
  const m = norm(text);
  if (/\b(9\s*[:x/]\s*16|vertical|stories|story|reels?|status|tiktok|shorts|celular em pe)\b/.test(m)) return '9:16';
  if (/\b(1\s*[:x/]\s*1|quadrad[oa]|feed)\b/.test(m)) return '1:1';
  if (/\b(16\s*[:x/]\s*9|horizontal|paisagem|youtube|widescreen|tela cheia|tv)\b/.test(m)) return '16:9';
  return null;
}

// Divide a duração total entre as cenas, em segundos inteiros (o modelo só aceita inteiros).
// Cada cena tem pelo menos 2 s; a soma é exatamente o total (máximo 15 s, até 6 cenas).
function splitDurations(total, n) {
  const shots = Math.max(1, Math.min(MAX_SHOTS, Math.round(n) || 1));
  let t = clampDuration(total);
  if (t < shots * 2) t = Math.min(MAX_S, shots * 2);
  const base = Math.floor(t / shots);
  const out = Array(shots).fill(base);
  for (let i = 0; i < t - base * shots; i++) out[i] += 1;
  return out;
}

// Créditos de vídeo pela duração: ceil(segundos / 5) × VIDEO_CREDITS_PER_5S.
// Com o padrão, um vídeo de 5 s custa 10 créditos (1 crédito ≈ 1 imagem em custo).
function creditsFor(seconds) {
  const per = Math.max(1, Math.round(Number(process.env.VIDEO_CREDITS_PER_5S) || 10));
  return Math.ceil(clampDuration(seconds) / 5) * per;
}

// Corpo da chamada de imagem→vídeo para o modelo configurado
function i2vBody(model, { imageUrl, prompt, duration, shots }) {
  if (!isKling3(model)) {
    // Kling 2.1: só 5 ou 10 s, sem cenas múltiplas
    return { prompt: String(prompt || '').slice(0, 2000), image_url: imageUrl, duration: Number(duration) > 5 ? '10' : '5', cfg_scale: 0.5 };
  }
  const body = { image_url: imageUrl };
  if (Array.isArray(shots) && shots.length > 1) {
    body.multi_prompt = shots.slice(0, MAX_SHOTS).map((s) => ({ prompt: String(s.prompt || '').slice(0, 2000), duration: String(s.duration) }));
  } else {
    body.prompt = String(prompt || (shots && shots[0] && shots[0].prompt) || '').slice(0, 2500);
    body.duration = String(clampDuration(duration));
  }
  return body;
}

function t2vBody({ prompt, duration, aspectRatio, shots }) {
  const body = { aspect_ratio: ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : '9:16' };
  if (Array.isArray(shots) && shots.length > 1) {
    body.multi_prompt = shots.slice(0, MAX_SHOTS).map((s) => ({ prompt: String(s.prompt || '').slice(0, 2000), duration: String(s.duration) }));
  } else {
    body.prompt = String(prompt || '').slice(0, 2500);
    body.duration = String(clampDuration(duration));
  }
  return body;
}

function videoUrlFrom(out) {
  const v = out && (out.video || out.data);
  if (typeof v === 'string') return v;
  return (v && v.url) || null;
}

function describe() {
  return { imageToVideo: i2vModel(), textToVideo: t2vModel(), reserva: legacyModel(), multiCena: isKling3(i2vModel()) };
}

module.exports = {
  DEFAULTS, MIN_S, MAX_S, MAX_SHOTS,
  i2vModel, t2vModel, legacyModel, isKling3,
  clampDuration, parseDuration, parseAspect, splitDurations, creditsFor,
  i2vBody, t2vBody, videoUrlFrom, describe
};
