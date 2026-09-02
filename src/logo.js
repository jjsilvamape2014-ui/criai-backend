const sharp = require('sharp');
const axios = require('axios');

// Converte dataURL (base64) ou URL em Buffer para o sharp. Retorna null se inválido.
// URLs são baixadas via axios (segue redirects) porque os links fal.media são temporários
// e o sharp sozinho falha com "Input file is missing" em URLs que redirecionam/expiraram.
async function toBuffer(source) {
  if (!source || typeof source !== 'string') return null;
  const m = source.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s);
  if (m) {
    return Buffer.from(m[2], 'base64');
  }
  if (/^https?:\/\//.test(source)) {
    const res = await axios.get(source, { responseType: 'arraybuffer', timeout: 45000 });
    if (res.data && res.data.byteLength) return Buffer.from(res.data);
    return null;
  }
  return source; // caminho de arquivo
}

// Detecta a posição desejada da logo a partir da mensagem do usuário (PT/EN)
// Retorna um identificador: top | bottom | left | right | center | top-left | top-right | bottom-left | bottom-right
function detectLogoPosition(message) {
  const m = (message || '').toLowerCase();
  const v = m.match(/(no topo|em cima|topo|acima|cima|parte de cima)/)
    ? 'top'
    : m.match(/(embaixo|em baixo|abaixo|no fundo|parte de baixo|base|rodape|na parte inferior)/)
      ? 'bottom'
      : null;
  const h = m.match(/(canto esquerdo|a esquerda|a esquerda|lado esquerdo|esquerda)/)
    ? 'left'
    : m.match(/(canto direito|a direita|a direita|lado direito|direita)/)
      ? 'right'
      : null;

  if (/(centro|meio|central|ao centro|no meio)/.test(m)) return 'center';
  if (v === 'top' && h === 'left') return 'top-left';
  if (v === 'top' && h === 'right') return 'top-right';
  if (v === 'bottom' && h === 'left') return 'bottom-left';
  if (v === 'bottom' && h === 'right') return 'bottom-right';
  if (v) return v;
  if (h) return h;
  return 'bottom-right'; // padrão
}

// Sobreposição exata da logo (imagem) sobre a foto base, mantendo a logo original.
function positionOffsets(position, baseW, baseH, logoW, logoH, margin) {
  const hCenter = (baseW - logoW) / 2;
  const hLeft = margin;
  const hRight = baseW - logoW - margin;
  const vCenter = (baseH - logoH) / 2;
  const vTop = margin;
  const vBottom = baseH - logoH - margin;

  switch (position) {
    case 'top': return { left: hCenter, top: vTop };
    case 'bottom': return { left: hCenter, top: vBottom };
    case 'left': return { left: hLeft, top: vCenter };
    case 'right': return { left: hRight, top: vCenter };
    case 'center': return { left: hCenter, top: vCenter };
    case 'top-left': return { left: hLeft, top: vTop };
    case 'top-right': return { left: hRight, top: vTop };
    case 'bottom-left': return { left: hLeft, top: vBottom };
    case 'bottom-right': return { left: hRight, top: vBottom };
    default: return { left: hRight, top: vBottom };
  }
}

// baseImage e logoImage podem ser dataURL (base64), URL ou caminho. Retorna dataURL da composição.
async function compositeLogo(baseImage, logoImage, position) {
  try {
    const baseSrc = await toBuffer(baseImage);
    const logoSrc = await toBuffer(logoImage);
    if (!baseSrc || !logoSrc) return null;

    const maxDim = 1536;
    const base = sharp(baseSrc).rotate();
    const meta = await base.metadata();
    let baseW = meta.width || 1024;
    let baseH = meta.height || 1024;

    // Limita o tamanho da base para a composição não explodir
    const scale = Math.min(1, maxDim / Math.max(baseW, baseH));
    baseW = Math.round(baseW * scale);
    baseH = Math.round(baseH * scale);
    const baseBuf = await base.resize({ width: baseW, height: baseH, fit: 'inside' }).toBuffer();

    // Logo: preserva proporção e transparência (PNG com alpha)
    const logoMeta = await sharp(logoSrc).rotate().metadata();
    const logoTargetW = Math.round(baseW * 0.32); // ~32% da largura da base
    const logoW = Math.round(logoTargetW * Math.min(1, (logoMeta.width || logoTargetW) / logoTargetW));
    const logoScaled = sharp(logoSrc)
      .rotate()
      .resize({ width: logoW, height: null, fit: 'inside' })
      .png();
    const { data: logoData, info: logoInfo } = await logoScaled.toBuffer({ resolveWithObject: true });

    const margin = Math.max(24, Math.round(baseW * 0.04));
    const { left, top } = positionOffsets(position, baseW, baseH, logoInfo.width, logoInfo.height, margin);

    const out = await sharp(baseBuf)
      .composite([{ input: logoData, left: Math.round(left), top: Math.round(top) }])
      .jpeg({ quality: 92 })
      .toBuffer();

    return `data:image/jpeg;base64,${out.toString('base64')}`;
  } catch (e) {
    console.error('compositeLogo falhou:', e.message);
    return null;
  }
}

module.exports = { compositeLogo, detectLogoPosition };