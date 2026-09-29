// 🎞️ Motor de MOTION GRAPHICS do Criativa AI
//
// Cada quadro do vídeo é um SVG gerado por código (texto real, ícones vetoriais,
// cores da marca). O sharp rasteriza o SVG e o ffmpeg junta os quadros em MP4.
// Sem Chromium, sem modelo de vídeo por IA: texto sempre correto, logo sempre fiel,
// custo quase zero por vídeo (só CPU).

require('../fontSetup');
const sharp = require('sharp');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FONT = 'Poppins, DejaVu Sans, sans-serif';

// ---------------------------------------------------------------------------
// Tempo e easing
// ---------------------------------------------------------------------------
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = {
  outCubic: (p) => 1 - Math.pow(1 - p, 3),
  inCubic: (p) => p * p * p,
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  outBack: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
};
// progresso 0→1 de uma animação que começa em `start` e dura `dur` segundos
const prog = (t, start, dur, fn = ease.outCubic) => fn(clamp((t - start) / dur));

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, p) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([lerp(A[0], B[0], p), lerp(A[1], B[1], p), lerp(A[2], B[2], p)]);
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Paleta completa a partir de UMA cor da marca
function palette(primary) {
  let p = /^#[0-9a-f]{6}$/i.test(primary || '') ? primary : '#1565D8';
  // cor muito clara (ex.: amarelo) não serve para fundo com texto branco → escurece
  if (luminance(p) > 0.45) p = mix(p, '#000000', 0.35);
  return {
    primary: p,
    dark: mix(p, '#06080F', 0.45),
    deep: mix(p, '#04060C', 0.7),
    light: mix(p, '#FFFFFF', 0.94),
    soft: mix(p, '#FFFFFF', 0.72),
    bright: mix(p, '#FFFFFF', 0.25),
    ink: mix(p, '#0A0D14', 0.8),
    white: '#FFFFFF',
    whatsapp: '#25D366',
    warmA: '#FF9A1F',
    warmB: '#D9261C'
  };
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[\u2010\u2011\u2012\u2212]/g, '-').replace(/[\u00A0\u202F\u2007]/g, ' ').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// largura aproximada (em "em") por caractere para Poppins
function textWidth(text, size, weight = 700) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === ' ') w += 0.28;
    else if (/[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(ch)) w += /[MW]/.test(ch) ? 0.9 : /[IJ]/.test(ch) ? 0.32 : 0.7;
    else if (/[0-9]/.test(ch)) w += 0.62;
    else if (/[a-záàâãéêíóôõúç]/.test(ch)) w += /[mw]/.test(ch) ? 0.86 : /[iljtf]/.test(ch) ? 0.3 : 0.58;
    else w += 0.4;
  }
  return w * size * (weight >= 700 ? 1.04 : 1);
}

function wrapLines(text, size, maxWidth, weight) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (!cur || textWidth(test, size, weight) <= maxWidth) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Diminui a fonte até caber em `maxLines` linhas
function fitText(text, { size, minSize = 28, maxWidth, maxLines = 3, weight = 800 }) {
  let s = size;
  let lines = wrapLines(text, s, maxWidth, weight);
  while ((lines.length > maxLines || lines.some((l) => textWidth(l, s, weight) > maxWidth)) && s > minSize) {
    s -= 4;
    lines = wrapLines(text, s, maxWidth, weight);
  }
  lines = lines.slice(0, maxLines);
  // equilibra as linhas (evita uma palavra sozinha na última linha)
  if (lines.length >= 2) {
    const n = lines.length;
    let lo = maxWidth * 0.5;
    let hi = maxWidth;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (wrapLines(text, s, mid, weight).length > n) lo = mid; else hi = mid;
    }
    const balanced = wrapLines(text, s, hi, weight);
    if (balanced.length === n) lines = balanced;
  }
  return { size: s, lines };
}

// Bloco de texto com linhas que sobem + aparecem em sequência
function textBlock({ lines, x, y, size, weight = 800, fill, t, start = 0, stagger = 0.12, lineGap = 1.18, anchor = 'middle', rise = 40, opacity = 1, letterSpacing = 0 }) {
  return lines.map((line, i) => {
    const p = prog(t, start + i * stagger, 0.55);
    if (p <= 0) return '';
    const dy = (1 - p) * rise;
    return `<text x="${x}" y="${(y + i * size * lineGap + dy).toFixed(1)}" font-family="${FONT}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" opacity="${(p * opacity).toFixed(3)}" letter-spacing="${letterSpacing}">${esc(line)}</text>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Aleatório determinístico (partículas iguais em todo quadro)
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------------------------------------------------------------------
// Render: quadros SVG → sharp (raw RGBA) → ffmpeg (stdin) → MP4
// ---------------------------------------------------------------------------
// frameSvg(t) devolve o SVG do instante t (segundos).
async function renderVideo({ frameSvg, duration, outPath, W = 1080, H = 1920, fps = 30, audioPath = null, batch = 6, onProgress }) {
  const total = Math.round(duration * fps);
  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0'];
  if (audioPath) args.push('-i', audioPath);
  args.push('-map', '0:v');
  if (audioPath) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '160k');
  args.push('-c:v', 'libx264', '-preset', process.env.MOTION_PRESET || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-t', duration.toFixed(3), '-movflags', '+faststart', outPath);

  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg falhou: ' + stderr.slice(-600)))));
  });
  let pipeErr = null;
  ff.stdin.on('error', (e) => { pipeErr = e; });
  const write = (buf) => new Promise((resolve, reject) => {
    if (pipeErr) return reject(pipeErr);
    if (ff.stdin.write(buf)) return resolve();
    ff.stdin.once('drain', resolve);
  });

  for (let i = 0; i < total; i += batch) {
    const idx = [];
    for (let k = i; k < Math.min(total, i + batch); k++) idx.push(k);
    const bufs = await Promise.all(idx.map((k) =>
      sharp(Buffer.from(frameSvg(k / fps)), { density: 72 }).resize(W, H).ensureAlpha().raw().toBuffer()
    ));
    for (const b of bufs) await write(b);
    if (onProgress && i % (fps * 2) === 0) onProgress(i / total);
  }
  ff.stdin.end();
  await done;
  return outPath;
}

module.exports = { clamp, lerp, ease, prog, palette, mix, luminance, esc, textWidth, wrapLines, fitText, textBlock, rng, renderVideo, FONT };
