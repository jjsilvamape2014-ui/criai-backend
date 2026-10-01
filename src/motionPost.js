// 🎞️ POST ANIMADO (motion): o post vira um vídeo curto para Reels/Status/feed.
//   - a foto ganha um zoom lento com leve deslize (efeito "Ken Burns")
//   - cada elemento do layout entra em sequência (faixa, título, selo de preço, contato)
//   - mesmos textos conferidos da peça (escritos por código, sempre certos)
// Tudo por código (SVG → sharp → ffmpeg): não gasta IA nem crédito de vídeo de IA.
require('./fontSetup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const E = require('./motion/engine');
const L = require('./textLayouts');

const FORMATS = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] };

async function toBuf(src) {
  if (Buffer.isBuffer(src)) return src;
  if (String(src).startsWith('data:')) return Buffer.from(String(src).split(',')[1] || '', 'base64');
  const axios = require('axios');
  return Buffer.from((await axios.get(src, { responseType: 'arraybuffer', timeout: 60000 })).data);
}

// direção do movimento varia com o pedido (não é sempre o mesmo zoom)
const MOVES = [
  { z0: 1.0, z1: 1.12, x0: 0, x1: -0.03, y0: 0, y1: -0.02 },
  { z0: 1.14, z1: 1.02, x0: -0.03, x1: 0, y0: 0, y1: 0 },
  { z0: 1.04, z1: 1.14, x0: 0.03, x1: -0.02, y0: 0.01, y1: -0.01 },
  { z0: 1.1, z1: 1.1, x0: 0.04, x1: -0.04, y0: 0, y1: 0 }
];

async function renderMotionPost({ image, texts, hex = '#1d4ed8', message = '', project = null, look = null, layout = null, format = '4:5', seconds = 7, outPath }) {
  const [W, H] = FORMATS[format] || FORMATS['4:5'];
  const pick = L.chooseLayout({ texts, message, project, look, layout });
  // foto um pouco maior que o quadro (sobra para o zoom/deslize)
  const big = await sharp(await toBuf(image)).resize(Math.round(W * 1.16), Math.round(H * 1.16), { fit: 'cover', position: 'attention' }).jpeg({ quality: 88 }).toBuffer();
  const href = `data:image/jpeg;base64,${big.toString('base64')}`;
  let h = 0;
  for (const ch of `${message}|${texts.join('|')}`) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  const mv = MOVES[h % MOVES.length];
  const frameSvg = (t) => {
    const p = E.ease.inOutCubic(Math.min(1, t / seconds));
    const z = E.lerp(mv.z0, mv.z1, p) / 1.16;
    const iw = W * 1.16 * z, ih = H * 1.16 * z;
    const x = (W - iw) / 2 + E.lerp(mv.x0, mv.x1, p) * W;
    const y = (H - ih) / 2 + E.lerp(mv.y0, mv.y1, p) * H;
    const fadeIn = Math.min(1, t / 0.35);
    const fadeOut = Math.min(1, Math.max(0, (seconds - t) / 0.4));
    const overlay = L.layoutSvg({ W, H, texts, hex, look: pick.look, layout: pick.layout, t });
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#000"/>
      <g opacity="${(fadeIn * fadeOut).toFixed(3)}">
        <image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="xMidYMid slice" xlink:href="${href}"/>
        ${overlay}
      </g>
    </svg>`;
  };
  const out = outPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-')), 'post-animado.mp4');
  await E.renderVideo({ frameSvg, duration: seconds, outPath: out, W, H });
  return { path: out, layout: pick.layout, look: pick.look };
}

module.exports = { renderMotionPost, FORMATS };
