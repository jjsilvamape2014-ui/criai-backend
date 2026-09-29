// 🗣️ O PERSONAGEM DA IMAGEM FALA: "faz o mascote falar: bom dia, eu sou o Delta".
//
// Não é anúncio. A fala é EXATAMENTE a que o cliente escreveu:
//   1) grava a voz (mesma voz dos anúncios; masculina/feminina pelo personagem)
//   2) tenta sincronizar a boca com a voz (lipsync)
//   3) se não der (personagem de desenho às vezes não é aceito), anima o personagem
//      falando/gesticulando (image-to-video) e coloca a voz por cima, no tamanho da fala
require('./fontSetup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_BIN || 'ffmpeg';
const LIPSYNC_ENDPOINT = process.env.FAL_LIPSYNC_ENDPOINT || 'fal-ai/sync-lipsync/v3/image-to-video';

// deps: { tts(text, voice) → url/dataURL, upload(buf, mime, name) → url, falQueue, saveMedia,
//         mediaDuration, animate(imageUrl, prompt) → videoUrl, speakable(text) → text }
async function buildCharacterSpeech({ image, speech, motion, voice, deps, onStatus }) {
  const status = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fala-'));
  const toUrl = async (src, name) => {
    if (!String(src).startsWith('data:')) return src;
    const mime = String(src).slice(5, String(src).indexOf(';')) || 'application/octet-stream';
    return deps.upload(Buffer.from(String(src).split(',')[1] || '', 'base64'), mime, name);
  };
  try {
    status('Gravando a fala…');
    const audioSrc = await deps.tts(deps.speakable ? deps.speakable(speech) : speech, voice);
    const audioFile = path.join(tmp, 'fala.mp3');
    await deps.saveMedia(audioSrc, audioFile);
    const dur = await deps.mediaDuration(audioFile);
    const [imageUrl, audioUrl] = await Promise.all([toUrl(image, `personagem-${Date.now()}.png`), toUrl(audioSrc, `fala-${Date.now()}.mp3`)]);

    // 1) boca sincronizada
    status('Sincronizando a boca com a fala…');
    let method = 'lipsync';
    let videoSrc = null;
    try {
      const out = await deps.falQueue(LIPSYNC_ENDPOINT, { image_url: imageUrl, audio_url: audioUrl }, 360000);
      videoSrc = (out && out.video && out.video.url) || (out && typeof out.video === 'string' ? out.video : null);
    } catch (e) {
      console.error('fala do personagem: lipsync falhou, usando animação:', e.message);
    }

    // 2) reserva: personagem animado falando + voz por cima
    if (!videoSrc) {
      method = 'animacao';
      status('Animando o personagem falando…');
      const prompt = [
        motion || 'The character in the image talks to the camera: mouth opening and closing as if speaking, friendly small head nods and a natural hand gesture.',
        'Keep the character identical: same design, colors, letters and proportions. Static camera, background unchanged. No text added.'
      ].join(' ');
      videoSrc = await deps.animate(imageUrl, prompt);
    }
    if (!videoSrc) throw new Error('nenhum vídeo gerado');

    // 3) monta: vídeo no tamanho da fala (repete se precisar) + voz
    status('Finalizando…');
    const vFile = path.join(tmp, 'v.mp4');
    await deps.saveMedia(videoSrc, vFile);
    const total = Math.max(2.5, dur + 0.6);
    const outFile = path.join(tmp, 'final.mp4');
    await run(FFMPEG(), ['-y', '-stream_loop', '-1', '-i', vFile, '-i', audioFile,
      '-filter_complex', `[1:a]adelay=200|200,apad[a]`,
      '-map', '0:v', '-map', '[a]', '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile], { maxBuffer: 1024 * 1024 * 64 });
    const buf = fs.readFileSync(outFile);
    let videoUrl;
    try {
      videoUrl = await deps.upload(buf, 'video/mp4', `fala-${Date.now()}.mp4`);
    } catch (e) {
      videoUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }
    return { videoUrl, method, duration: total };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { buildCharacterSpeech };
