// Duração (segundos) de um arquivo de áudio/vídeo.
// No Railway (nixpacks) o pacote instala o ffmpeg, mas o ffprobe pode não estar no
// PATH ("spawn ffprobe ENOENT"). Por isso: tenta o ffprobe; se não houver, usa o
// próprio ffmpeg — primeiro a linha "Duration:" do cabeçalho e, se ela não vier,
// decodifica o arquivo e lê o último "time=".
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

const toSec = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

async function stderrOf(args) {
  try {
    const r = await run(FFMPEG, args, { maxBuffer: 1024 * 1024 * 16 });
    return String(r.stderr || '');
  } catch (e) {
    // "ffmpeg -i arquivo" sem saída termina com erro, mas a informação vem no stderr
    if (e.code === 'ENOENT') throw e;
    return String(e.stderr || '');
  }
}

async function mediaDuration(file) {
  try {
    const p = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    const d = parseFloat(String(p.stdout || '').trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch (e) { /* sem ffprobe: segue com o ffmpeg */ }

  const head = await stderrOf(['-hide_banner', '-i', file]);
  const m = head.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m) {
    const d = toSec(m[1], m[2], m[3]);
    if (d > 0) return d;
  }
  const full = await stderrOf(['-hide_banner', '-nostats', '-stats', '-i', file, '-f', 'null', '-']);
  const times = [...full.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) {
    const t = times[times.length - 1];
    return toSec(t[1], t[2], t[3]);
  }
  return 0;
}

module.exports = { mediaDuration };
