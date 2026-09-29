// Garante ffmpeg/ffprobe para os vídeos. PRECISA vir no topo do index.js: os módulos
// de vídeo leem FFMPEG_BIN/FFPROBE_BIN quando são carregados.
//
// O nixpacks.toml pede o ffmpeg do sistema, mas em produção ele não estava no PATH
// ("spawn ffmpeg ENOENT"). Então: se o do sistema (ou o de FFMPEG_BIN) funciona, usa
// ele; se não, usa o binário que vem nos pacotes ffmpeg-static / ffprobe-static.
const { spawnSync } = require('child_process');

function works(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 8000, stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch (e) {
    return false;
  }
}

function ensure(envKey, systemName, staticPath) {
  const current = process.env[envKey] || systemName;
  if (works(current)) return current;
  try {
    const p = staticPath();
    if (p && works(p)) {
      process.env[envKey] = p;
      return p;
    }
  } catch (e) {
    console.error(`ffmpegSetup: ${systemName} do pacote indisponível:`, e.message);
  }
  console.error(`ffmpegSetup: ${systemName} não encontrado — vídeos vão falhar`);
  return null;
}

const ffmpeg = ensure('FFMPEG_BIN', 'ffmpeg', () => require('ffmpeg-static'));
const ffprobe = ensure('FFPROBE_BIN', 'ffprobe', () => require('ffprobe-static').path);
console.log(`ffmpegSetup: ffmpeg=${ffmpeg ? 'ok' : 'FALTANDO'} ffprobe=${ffprobe ? 'ok' : 'FALTANDO'}`);

module.exports = { ffmpeg, ffprobe };
