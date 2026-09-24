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

// Layout da saída: vertical (1080x1920, padrão celular) ou horizontal (1920x1080, TV/projetor).
function getLayout(orientacao) {
  const h = String(orientacao || '').toLowerCase().startsWith('h');
  if (h) {
    return {
      horizontal: true, W: 1920, H: 1080,
      barra: 20,
      // capa
      yPodcast: 130, fontPodcast: 44, lsPodcast: '26',
      yTitulo0: 330, yTituloGap: 96, fontTitulo: 88, sliceTitulo: 24,
      yLinha: 590, ySub: 680, fontSub: 46,
      yConvLabel: 830, fontConvLabel: 34, yConvNome: 910, fontConvNome: 60, lsConvLabel: '12',
      // card CTA
      yCard1: 340, fontCard1: 92, yCard2: 480, fontCard2: 58, yCardPodcast: 880, fontCardPodcast: 44, lsCardPodcast: '20',
      // legenda
      fontLeg: 46, marginV: 44,
      zoom: 1.05,
    };
  }
  return {
    horizontal: false, W: 1080, H: 1920,
    barra: 16,
    yPodcast: 360, fontPodcast: 44, lsPodcast: '18',
    yTitulo0: 720, yTituloGap: 110, fontTitulo: 84, sliceTitulo: 28,
    yLinha: 1000, ySub: 1120, fontSub: 52,
    yConvLabel: 1380, fontConvLabel: 40, yConvNome: 1470, fontConvNome: 64, lsConvLabel: '10',
    yCard1: 880, fontCard1: 72, yCard2: 1020, fontCard2: 48, yCardPodcast: 1500, fontCardPodcast: 40, lsCardPodcast: '12',
    fontLeg: 22, marginV: 50,
    zoom: 1.05,
  };
}

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
async function gerarVoz(texto, voz) {
  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  const res = await axios.post('https://queue.fal.run/fal-ai/kokoro/brazilian-portuguese', { prompt: texto, voice: voz || 'pf_dora' }, { headers, timeout: 60000 });
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
async function clipeImagem(imagePath, audioPath, outPath, duracao, L) {
  const args = ['-y'];
  args.push('-loop', '1', '-i', imagePath);
  if (audioPath) args.push('-i', audioPath);
  args.push(
    '-filter_complex',
    `scale=${L.W}:${L.H}:force_original_aspect_ratio=increase,crop=${L.W}:${L.H},zoompan=z=${L.zoom}:fps=30:d=${Math.round(duracao * 30)}:x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2):s=${L.W}x${L.H}`,
    '-t', String(duracao)
  );
  if (audioPath) args.push('-shortest');
  args.push('-r', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23');
  if (audioPath) args.push('-c:a', 'aac');
  args.push(outPath);
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 32 });
}

// Queima a legenda e padroniza pra WxH (9:16 vertical ou 16:9 horizontal) — garante o concat.
async function queimarLegenda(videoPath, srtPath, outPath, L) {
  const srtSafe = String(srtPath).replace(/\\/g, '/').replace(/[':\[\]]/g, (c) => '\\' + c);
  const args = ['-y', '-i', videoPath,
    '-vf', `scale=${L.W}:${L.H}:force_original_aspect_ratio=increase,crop=${L.W}:${L.H},subtitles='${srtSafe}':force_style='Fontsize=${L.fontLeg},FontName=Arial,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&HAA000000,Alignment=2,MarginV=${L.marginV}'`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'copy', outPath];
  await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 32 });
}

// Card final (CTA): WxH via SVG/sharp — sem depender de fontconfig/ffmpeg drawtext.
async function gerarCard(linha1, linha2, outPath, L) {
  const sharp = require('sharp');
  const t1 = String(linha1 || '').slice(0, 44) || 'A Palavra em Nossa Vida';
  const t2 = String(linha2 || '').slice(0, 64);
  const svg = `<svg width="${L.W}" height="${L.H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1A1210"/><stop offset="1" stop-color="#0D0A09"/>
      </linearGradient>
    </defs>
    <rect width="${L.W}" height="${L.H}" fill="url(#bg)"/>
    <rect y="0" width="${L.W}" height="${L.barra}" fill="#E8552D"/>
    <text x="${L.W / 2}" y="${L.yCard1}" font-size="${L.fontCard1}" font-weight="800" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${t1}</text>
    <text x="${L.W / 2}" y="${L.yCard2}" font-size="${L.fontCard2}" fill="#C9A98F" text-anchor="middle" font-family="DejaVu Sans">${t2}</text>
    <text x="${L.W / 2}" y="${L.yCardPodcast}" font-size="${L.fontCardPodcast}" font-weight="700" fill="#E8552D" text-anchor="middle" letter-spacing="${L.lsCardPodcast}" font-family="DejaVu Sans">P O D C A S T</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// Capa da abertura: WxH, fundo terracota quente, título + subtítulo + convidado.
// Renderiza um SVG e converte pra PNG via sharp (sem depender de fonte no servidor).
async function gerarCapa(titulo, subtitulo, convidado, outPath, L) {
  const sharp = require('sharp');
  const fraseTitulo = String(titulo || 'A Palavra em Nossa Vida');
  const fraseSub = String(subtitulo || '');
  const fraseConvidado = String(convidado || '');
  const t1 = fraseTitulo.slice(0, L.sliceTitulo);
  const t2 = fraseTitulo.slice(L.sliceTitulo, L.sliceTitulo * 2);
  const partesTitulo = [t1].concat(t2 ? [t2] : []);
  const linhasTitulo = partesTitulo
    .map((l, idx) => `<text x="${L.W / 2}" y="${L.yTitulo0 + idx * L.yTituloGap}" font-size="${L.fontTitulo}" font-weight="800" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${l}</text>`)
    .join('');
  const svg = `<svg width="${L.W}" height="${L.H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1A1210"/><stop offset="1" stop-color="#0D0A09"/>
      </linearGradient>
    </defs>
    <rect width="${L.W}" height="${L.H}" fill="url(#bg)"/>
    <rect y="0" width="${L.W}" height="${L.barra}" fill="#E8552D"/>
    <text x="${L.W / 2}" y="${L.yPodcast}" font-size="${L.fontPodcast}" font-weight="600" fill="#C9A98F" text-anchor="middle" letter-spacing="${L.lsPodcast}" font-family="DejaVu Sans">P O D C A S T</text>
    ${linhasTitulo}
    <line x1="${L.W / 2 - 100}" y1="${L.yLinha}" x2="${L.W / 2 + 100}" y2="${L.yLinha}" stroke="#E8552D" stroke-width="6"/>
    <text x="${L.W / 2}" y="${L.ySub}" font-size="${L.fontSub}" fill="#D8C8B8" text-anchor="middle" font-family="DejaVu Sans">${fraseSub}</text>
    <text x="${L.W / 2}" y="${L.yConvLabel}" font-size="${L.fontConvLabel}" font-weight="700" fill="#E8552D" text-anchor="middle" letter-spacing="${L.lsConvLabel}" font-family="DejaVu Sans">CONVIDADO</text>
    <text x="${L.W / 2}" y="${L.yConvNome}" font-size="${L.fontConvNome}" fill="#F5EFE6" text-anchor="middle" font-family="DejaVu Sans">${fraseConvidado}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

router.post('/montar', upload.single('video'), async (req, res) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mont-'));
  try {
    const { entrevistaUrl, srt, abertura, orientacao } = req.body || {};
    const L = getLayout(orientacao);
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
    const voz = String(req.body.voz || '').trim() || 'pf_dora';

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
    const vozUrl = await gerarVoz(chamada, voz);
    const vozMp3 = path.join(tmp, 'voz.mp3');
    await downloadFile(vozUrl, vozMp3);
    const capaPng = path.join(tmp, 'cap.png');
    await gerarCapa(titulo, subtitulo, convidado, capaPng, L);
    const aberturaMp4 = path.join(tmp, 'abertura.mp4');
    await clipeImagem(capaPng, vozMp3, aberturaMp4, 5, L);
    console.log('✓ abertura (narrada)');

    // 3) Queima a legenda na entrevista
    const entrevistaLeg = path.join(tmp, 'entrevista-leg.mp4');
    await queimarLegenda(entrevistaMp4, srtFile, entrevistaLeg, L);
    console.log('✓ entrevista legendada');

    // 4) CTA final
    const ctaPng = path.join(tmp, 'cta.png');
    await gerarCard(cta, titulo, ctaPng, L);
    const ctaMp4 = path.join(tmp, 'cta.mp4');
    await clipeImagem(ctaPng, null, ctaMp4, 4, L);
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