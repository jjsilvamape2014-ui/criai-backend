// Registra as fontes do projeto (assets/fonts, ex.: Poppins) para o sharp/librsvg.
// PRECISA ser o primeiro require do index.js: o fontconfig lê a configuração
// uma única vez, no primeiro texto renderizado.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

function setupFonts() {
  if (process.env.FONTCONFIG_FILE) return;
  try {
    const conf = path.join(os.tmpdir(), 'criai-fonts.conf');
    const cache = path.join(os.tmpdir(), 'criai-fontcache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(conf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>/usr/share/fonts</dir>
  <cachedir>${cache}</cachedir>
</fontconfig>`);
    process.env.FONTCONFIG_FILE = conf;
  } catch (e) {
    console.error('fontSetup: não consegui registrar as fontes:', e.message);
  }
}

setupFonts();
module.exports = { FONT_DIR };
