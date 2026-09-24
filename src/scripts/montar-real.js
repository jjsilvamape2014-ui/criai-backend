// GERA O VÍDEO FINAL com a entrevista REAL (WhatsApp Video 2026-09-23 11.25.01).
// Fluxo: transcreve (fal Whisper) → monta (abertura narrada + legenda + CTA) → MP4 horizontal.
// Uso: node src/scripts/montar-real.js

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const ENTREVISTA = process.env.ENTREVISTA_REAL || 'C:/Users/xyzge/Downloads/WhatsApp Video 2026-09-23 at 11.25.01.mp4';
const CAPA = process.env.CAPA_REAL || 'C:/Users/xyzge/Downloads/WhatsApp Video 2026-09-23 at 12.11.22.mp4';
const SAIDA = process.env.SAIDA_FINAL || 'C:/Users/xyzge/Downloads/a_palavra_em_nossa_vida_final_TV.mp4';
const PORT = 4872;

const FFMPEG = process.env.FFMPEG_BIN || (() => {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
  return fs.existsSync(p) ? p : 'ffmpeg';
})();
process.env.FFMPEG_BIN = FFMPEG;
process.env.FFPROBE_BIN = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');

function log() { console.log.apply(console, ['[REAL]'].concat(Array.prototype.slice.call(arguments))); }

function startServer() {
  const app = express();
  app.use('/api/legenda', require('../routes/legenda'));
  app.use('/api/video', require('../routes/montar'));
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(PORT, () => resolve(srv));
  });
}

const ABERTURA = {
  titulo: 'A Palavra em Nossa Vida',
  subtitulo: 'Gincana Bíblica 2026 — Colégio São José',
  convidado: 'Monsenhor Gabriel',
  chamada: 'A Palavra em Nossa Vida. Um podcast do Colégio São José, direto da Gincana Bíblica, com o senhor Monsenhor Gabriel.',
  cta: 'Obrigado por assistir! Inscreva-se e fique por dentro das próximas sessões.',
};

async function main() {
  if (!fs.existsSync(ENTREVISTA)) throw new Error('Entrevista não encontrada: ' + ENTREVISTA);
  log('Entrevista real: ' + ENTREVISTA + ' (' + (fs.statSync(ENTREVISTA).size / 1024 / 1024).toFixed(1) + ' MB)');

  const srv = await startServer();
  log('Servidor local no :' + PORT);
  const BASE = 'http://127.0.0.1:' + PORT;

  // 1) Transcrição (fal Whisper — custo zero), com retry (fila do fal pode demorar)
  log('1) Transcrevendo a entrevista (fal Whisper)…');
  let tj = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const fd = new FormData();
      fd.append('video', new Blob([fs.readFileSync(ENTREVISTA)], { type: 'video/mp4' }), 'entrevista.mp4');
      const t = await fetch(BASE + '/api/legenda/transcribe', { method: 'POST', body: fd, signal: AbortSignal.timeout(600000) });
      tj = await t.json().catch(() => ({}));
      if (t.ok && tj.segments && tj.segments.length) break;
      log('1x) tentativa ' + tentativa + ' falhou: ' + (tj.error || t.status) + ' — repetindo…');
      await new Promise((r) => setTimeout(r, 10000));
    } catch (e) {
      log('1x) tentativa ' + tentativa + ' erro: ' + e.message + ' — repetindo…');
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (!tj || !tj.segments || !tj.segments.length) throw new Error('Transcribe falhou após 3 tentativas: ' + (tj && tj.error));
  const nPalavras = Array.isArray(tj.words) ? tj.words.length : 0;
  log('1b) Transcrição OK — ' + tj.segments.length + ' blocos, ' + tj.duration.toFixed(1) + 's, ' + nPalavras + ' palavras.');
  console.log('--- SRT (primeiros 900 chars) ---\n' + tj.srt.slice(0, 900));

  // 2) Montagem (abertura com voz + legenda queimada + CTA), horizontal
  log('2) Montando vídeo final horizontal (ffmpeg)…');
  const axios = require('axios');
  const fd2 = new FormData();
  fd2.append('video', new Blob([fs.readFileSync(ENTREVISTA)], { type: 'video/mp4' }), 'entrevista.mp4');
  fd2.append('capa', new Blob([fs.readFileSync(CAPA)], { type: 'video/mp4' }), 'capa.mp4');
  fd2.append('srt', tj.srt);
  fd2.append('orientacao', 'horizontal');
  fd2.append('abertura', JSON.stringify(ABERTURA));
  const m = await axios.post(BASE + '/api/video/montar', fd2, {
    timeout: 900000, maxBodyLength: Infinity, maxContentLength: Infinity, responseType: 'arraybuffer',
  });
  if (m.status !== 200) {
    const ej = JSON.parse(Buffer.from(m.data).toString('utf8')).catch ? null : (() => { try { return JSON.parse(m.data.toString('utf8')); } catch (e) { return {}; } })();
    throw new Error('Montar: ' + (ej.error || m.status));
  }
  const buf = Buffer.from(m.data);
  fs.writeFileSync(SAIDA, buf);
  log('3) FINAL salvo em: ' + SAIDA + ' (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB)');

  // Verificação
  try {
    const probe = await promisify(execFile)(FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe'),
      ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', SAIDA]);
    log('Probe final:\n' + probe.stdout);
  } catch (e) { log('ffprobe: ' + e.message); }

  srv.close();
}

main().catch((err) => {
  console.error('[REAL] FALHOU:', err.message);
  process.exit(1);
});