// Montagem do vídeo profissional do podcast:
// abertura (imagem + narração TTS) + entrevista com legenda queimada + CTA final → UM MP4.
// Usa ffmpeg (instalado no Railway via nixpacks.toml) e fal Kokoro pra voz PT-BR.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const router = express.Router();

// Aceita o MP4 por upload (FormData multipart) — compatível com o celular.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 512 * 1024 * 1024 } });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function downloadFile(url, dest) {
  const r = await axios({ url, responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(dest, Buffer.from(r.data));
  return dest;
}

// SRT string → arquivo .srt temporário (com "\n\n" entre blocos)
function saveSRT(srt) {
  const p = path.join(os.tmpdir(), `legenda-${Date.now()}.srt`);
  fs.writeFileSync(p, String(srt || '').replace(/\r\n/g, '\n'));
  return p;
}

// Narração PT-BR via fal Kokoro (mesma voz do anúncio falado)
async function gerarVoz(texto) {
  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  const res = await axios.post('https://queue.fal.run/fal-ai/kokoro/brazilian-portuguese', { prompt: texto, voice: 'pf_dora' }, { headers, timeout: 60000 });
  let fin = null;
  if (res.data && res.data.status_url) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await sleep(5000);
      try {
        const pr = await axios.get(res.data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
        const pd = pr.data || {};
        if (pd.status === 'COMPLETED') { fin = pd; break; }
        if (pd.status === 'ERROR') break;
      } catch (e) {}
    }
  }
  if (!fin) throw new Error('Narração não foi gerada');
  let out = null;
  if (res.data.response_url) {
    try {
      const rr = await axios.get(res.data.response_url, { headers, timeout: 30000 });
      out = rr.data || null;
    } catch (e) {}
  }
  if (!out) out = fin.output || fin;
  const url = out && out.audio && out.audio.url ? out.audio.url : (typeof (out && out.audio) === 'string' ? out.audio : null);
  if (!url) throw new Error('Narração não foi gerada');
  return url;
}

// Cria um clipe de imagem com zoom lento (Ken Burns) + áudio opcional → MP4
async function clipeImagem(imagePath, audioPath, outPath, duracao) {
  const args = ['-y'];
  args.push('-loop', '1', '-i', imagePath);
  if (audioPath) args.push('-i', audioPath);
  args.push(
    '-filter_complex',
    'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z=1.05:fps=30:d=' + Math.round(duracao * 30) + ':x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2):s=1080x1920',
    '-t', String(duracao)
  );
  if (audioPath) args.push('-shortest');
  args.push('-r', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23');
  if (audioPath) args.push('-c:a', 'aac');
  args.push(outPath);
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 32 });
}

// Queima a legenda e padroniza pra 1080x1920 (9:16) — garante o concat com abertura/CTA.
async function queimarLegenda(videoPath, srtPath, outPath) {
  const srtSafe = String(srtPath).replace(/\\/g, '/').replace(/[':\[\]]/g, (c) => '\\' + c);
  const args = ['-y', '-i', videoPath,
    '-vf', `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='${srtSafe}':force_style='Fontsize=22,FontName=Arial,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&HAA000000,Alignment=2,MarginV=50'`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'copy', outPath];
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 32 });
}

// Card final (CTA): 1080x1920 via SVG/sharp — sem depender de fontconfig/ffmpeg drawtext.
async function gerarCard(linha1, linha2, outPath) {
  const sharp = require('sharp');
  const t1 = String(linha1 || '').slice(0, 40) || 'A Palavra em Nossa Vida';
  const t2 = String(linha2 || '').slice(0, 60);
  const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1A1210"/><stop offset="1" stop-color="#0D0A09"/>
      </linearGradient>
    </defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    <rect y="0" width="1080" height="16" fill="#E8552D"/>
    <text x="540" y="880" font-size="72" font-weight="800" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${t1}</text>
    <text x="540" y="1020" font-size="48" fill="#C9A98F" text-anchor="middle" font-family="DejaVu Sans">${t2}</text>
    <text x="540" y="1500" font-size="40" font-weight="700" fill="#E8552D" text-anchor="middle" letter-spacing="12" font-family="DejaVu Sans">P O D C A S T</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// Capa da abertura: 1080x1920, fundo terracota quente, título + subtítulo + convidado.
// Renderiza um SVG e converte pra PNG via sharp (sem depender de fonte no servidor).
async function gerarCapa(titulo, subtitulo, convidado, outPath) {
  const sharp = require('sharp');
  const fraseTitulo = String(titulo || 'A Palavra em Nossa Vida');
  const fraseSub = String(subtitulo || '');
  const fraseConvidado = String(convidado || '');
  const t1 = fraseTitulo.slice(0, 28);
  const t2 = fraseTitulo.slice(28, 56);
  const partesTitulo = [t1].concat(t2 ? [t2] : []);
  const linhasTitulo = partesTitulo
    .map((l, idx) => `<text x="540" y="${720 + idx * 110}" font-size="84" font-weight="800" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${l}</text>`)
    .join('');
  const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1A1210"/><stop offset="1" stop-color="#0D0A09"/>
      </linearGradient>
    </defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    <rect y="0" width="1080" height="16" fill="#E8552D"/>
    <text x="540" y="360" font-size="44" font-weight="600" fill="#C9A98F" text-anchor="middle" letter-spacing="18" font-family="DejaVu Sans">P O D C A S T</text>
    ${linhasTitulo}
    <line x1="440" y1="1000" x2="640" y2="1000" stroke="#E8552D" stroke-width="6"/>
    <text x="540" y="1120" font-size="52" fill="#D8C8B8" text-anchor="middle" font-family="DejaVu Sans">${fraseSub}</text>
    <text x="540" y="1380" font-size="40" font-weight="700" fill="#E8552D" text-anchor="middle" letter-spacing="10" font-family="DejaVu Sans">CONVIDADO</text>
    <text x="540" y="1470" font-size="64" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${fraseConvidado}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

router.post('/montar', upload.single('video'), async (req, res) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mont-'));
  try {
    const { entrevistaUrl, srt, abertura } = req.body || {};
    const parsed = (() => {
      try { return abertura ? JSON.parse(abertura) : {}; } catch (e) { return {}; }
    })();
    if (abertura && typeof abertura === 'object') parsed.abertura = abertura;
    const a = parsed.abertura || parsed || {};
    const titulo = a.titulo || 'A Palavra em Nossa Vida';
    const subtitulo = a.subtitulo || '';
    const convidado = a.convidado || '';
    const chamada = a.chamada || `Você está assistindo ${titulo}.`;
    const cta = a.cta || 'Inscreva-se e fique por dentro das próximas sessões!';

    if (!req.file && !entrevistaUrl) return res.status(400).json({ error: 'Envie o MP4 (campo video) ou entrevistaUrl.' });
    if (!srt || !String(srt).trim()) return res.status(400).json({ error: 'Envie o SRT da entrevista.' });

    // 1) Entrevista: via upload ou URL
    const entrevistaMp4 = path.join(tmp, 'entrevista.mp4');
    const srtFile = saveSRT(srt);
    if (req.file && req.file.path) {
      fs.copyFileSync(req.file.path, entrevistaMp4);
    } else {
      await downloadFile(entrevistaUrl, entrevistaMp4);
    }
    console.log('✓ entrevista pronta');

    // 2) Abertura: capa + narração + clipe com zoom
    const vozUrl = await gerarVoz(chamada);
    const vozMp3 = path.join(tmp, 'voz.mp3');
    await downloadFile(vozUrl, vozMp3);
    const capaPng = path.join(tmp, 'cap.png');
    await gerarCapa(titulo, subtitulo, convidado, capaPng);
    const aberturaMp4 = path.join(tmp, 'abertura.mp4');
    await clipeImagem(capaPng, vozMp3, aberturaMp4, 5);
    console.log('✓ abertura (narrada)');

    // 3) Queima a legenda na entrevista
    const entrevistaLeg = path.join(tmp, 'entrevista-leg.mp4');
    await queimarLegenda(entrevistaMp4, srtFile, entrevistaLeg);
    console.log('✓ entrevista legendada');

    // 4) CTA final
    const ctaPng = path.join(tmp, 'cta.png');
    await gerarCard(cta, titulo, ctaPng);
    const ctaMp4 = path.join(tmp, 'cta.mp4');
    await clipeImagem(ctaPng, null, ctaMp4, 4);
    console.log('✓ CTA');

    // 5) Concatena tudo
    const lista = path.join(tmp, 'lista.txt');
    fs.writeFileSync(lista, `file '${aberturaMp4}'\nfile '${entrevistaLeg}'\nfile '${ctaMp4}'\n`);
    const finalMp4 = path.join(os.tmpdir(), `podcast-${Date.now()}.mp4`);
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', lista, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-pix_fmt', 'yuv420p', finalMp4], { maxBuffer: 1024 * 1024 * 64 });

    res.download(finalMp4, 'podcast-professional.mp4', () => {
      setTimeout(() => { try { fs.unlinkSync(finalMp4); } catch (e) {} }, 5000);
    });
  } catch (err) {
    console.error('Montagem erro:', err.message);
    res.status(500).json({ error: 'Falha ao montar o vídeo: ' + err.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

module.exports = router;