// Qual código está no ar? CODE_REV muda a cada correção importante (escrito à mão,
// não depende do ambiente); o commit vem do Railway, se ele informar.
const { execFile } = require('child_process');

const CODE_REV = '2026-09-29.35 logo-nome-certo';
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || '').slice(0, 7) || null;

function hasBinary(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function toolsStatus() {
  const [ffmpeg, ffprobe] = await Promise.all([
    hasBinary(process.env.FFMPEG_BIN || 'ffmpeg'),
    hasBinary(process.env.FFPROBE_BIN || 'ffprobe')
  ]);
  return { ffmpeg, ffprobe };
}

module.exports = { CODE_REV, COMMIT, toolsStatus };
