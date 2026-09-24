// TESTE PONTA A PONTA (local): gera MP4 de teste com narração fal,
// sobe servidor mínimo com as rotas /api/legenda e /api/video, transcreve,
// monta o vídeo profissional e salva podcast-professional.mp4.
// Uso: node src/scripts/teste-e2e.js  (roda no backend, com .env carregado)

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_BIN || (() => {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
  return fs.existsSync(p) ? p : 'ffmpeg';
})();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const PORT = 4871;

// Ambiente: expõe o ffmpeg do winget para a rota montar.js (API FFMPEG_BIN)
process.env.FFMPEG_BIN = FFMPEG;
process.env.FFPROBE_BIN = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');

function log() { console.log.apply(console, ['[E2E]'].concat(Array.prototype.slice.call(arguments))); }

async function gerarNarracaoTeste() {
  log('1) Gerando narração de teste (fal Kokoro)…');
  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  const res = await axios.post(
    'https://queue.fal.run/fal-ai/kokoro/brazilian-portuguese',
    { prompt: 'Bem-vindos à Gincana Bíblica do Colégio São José. Hoje conversamos com o senhor Monsenhor Gabriel sobre a Palavra em nossa vida.', voice: 'pf_dora' },
    { headers, timeout: 60000 }
  );
  let fin = null;
  if (res.data && res.data.status_url) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const pr = await axios.get(res.data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        if (pr.data.status === 'COMPLETED') { fin = pr.data; break; }
        if (pr.data.status === 'ERROR') break;
      } catch (e) {}
    }
  }
  if (!fin) throw new Error('Narração não veio');
  let outr = null;
  if (res.data.response_url) {
    try {
      const rr = await axios.get(res.data.response_url, { headers, timeout: 30000 });
      outr = rr.data || null;
    } catch (e) {}
  }
  if (!outr) outr = fin.output || fin;
  const audio = outr && outr.audio ? (outr.audio.url || (typeof outr.audio === 'string' ? outr.audio : null)) : null;
  if (!audio) throw new Error('Narração não veio');
  const wav = path.join(TMP, 'voz-teste.mp3');
  const r = await axios({ url: audio, responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(wav, Buffer.from(r.data));
  return wav;
}

async function gerarVideoTeste(audio) {
  log('2) Gerando MP4 de teste 12s (imagem + narração)…');
  const mp4 = path.join(TMP, 'entrevista-teste.mp4');
  // Vídeo de teste em PAISAGEM (1920x1080) p/ validar padronização 9:16 no burn
await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x2A1A12:s=1920x1080:d=14',
    '-i', audio,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-shortest', mp4,
  ], { maxBuffer: 1024 * 1024 * 32 });
  return mp4;
}

function startServer() {
  const app = express();
  app.use('/api/legenda', require('../routes/legenda'));
  app.use('/api/video', require('../routes/montar'));
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(PORT, () => resolve(srv));
  });
}

async function main() {
  const srv = await startServer();
  log('Servidor de teste no :' + PORT);
  const BASE = 'http://127.0.0.1:' + PORT;

  const audio = await gerarNarracaoTeste();
  const mp4 = await gerarVideoTeste(audio);

  log('3) POST /api/legenda/transcribe…');
  const fd = new FormData();
  fd.append('video', new Blob([fs.readFileSync(mp4)], { type: 'video/mp4' }), 'entrevista-teste.mp4');
  const t = await fetch(BASE + '/api/legenda/transcribe', { method: 'POST', body: fd });
  const tj = await t.json().catch(() => ({}));
  if (!t.ok) throw new Error('Transcribe: ' + (tj.error || t.status));
  log('3b) Transcrição OK — ' + tj.segments.length + ' blocos, ' + tj.duration + 's');
  const srtTxt = tj.srt;
  console.log(srtTxt.slice(0, 600));

  log('4) POST /api/video/montar (envia MP4 + SRT + abertura)…');
  const fd2 = new FormData();
  fd2.append('video', new Blob([fs.readFileSync(mp4)], { type: 'video/mp4' }), 'entrevista-teste.mp4');
  fd2.append('srt', srtTxt);
  fd2.append('orientacao', process.env.E2E_ORIENTACAO || 'horizontal');
  fd2.append('abertura', JSON.stringify({
    titulo: 'A Palavra em Nossa Vida',
    subtitulo: 'Gincana Bíblica 2026 — Colégio São José',
    convidado: 'Monsenhor Gabriel',
    chamada: 'A Palavra em Nossa Vida. Um podcast do Colégio São José, direto da Gincana Bíblica, com o senhor Monsenhor Gabriel.',
    cta: 'Inscreva-se e fique por dentro das próximas sessões!',
  }));
  const m = await fetch(BASE + '/api/video/montar', { method: 'POST', body: fd2 });
  if (!m.ok) {
    const ej = await m.json().catch(() => ({}));
    throw new Error('Montar: ' + (ej.error || m.status));
  }
  const buf = Buffer.from(await m.arrayBuffer());
  const out = path.join(__dirname, 'podcast-professional.mp4');
  fs.writeFileSync(out, buf);
  log('5) MP4 final salvo em: ' + out + ' (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB)');

  // Verificação rápida
  try {
    const exe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');
    const info = await promisify(execFile)(exe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', out]);
    log('Probe final:\n' + info.stdout);
  } catch (e) {
    log('ffprobe indisponível: ' + e.message);
  }

  srv.close();
}

main().catch((err) => {
  console.error('[E2E] FALHOU:', err.message);
  process.exit(1);
});