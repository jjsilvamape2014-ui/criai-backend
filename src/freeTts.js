// 🗣️ Voz GRÁTIS de reserva: vozes neurais pt-BR do "Ler em voz alta" do Microsoft Edge
// (pacote msedge-tts). Usada quando a fal falha (ex.: saldo esgotado) ou, com
// TTS_PROVIDER=edge, como voz principal para economizar.
// Atenção: não é um serviço oficial/contratado da Microsoft — pode mudar ou parar sem
// aviso. Por isso fica como reserva, não como única opção.
const fs = require('fs');
const os = require('os');
const path = require('path');

// voz do Kokoro (fal) → voz equivalente do Edge
const VOICE_MAP = {
  pf_dora: 'pt-BR-FranciscaNeural',
  pm_alex: 'pt-BR-AntonioNeural',
  pm_santa: 'pt-BR-AntonioNeural'
};

function edgeVoice(kokoroVoice) {
  if (VOICE_MAP[kokoroVoice]) return VOICE_MAP[kokoroVoice];
  return /^pm_|male|masc/i.test(String(kokoroVoice || '')) ? 'pt-BR-AntonioNeural' : 'pt-BR-FranciscaNeural';
}

const xmlEscape = (s) => String(s || '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Devolve o áudio como dataURL (mp3), no mesmo formato que o resto do pipeline aceita.
async function synthesizeFree(text, kokoroVoice) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  let agent;
  if (process.env.HTTPS_PROXY) {
    // só em ambientes com proxy obrigatório (não é dependência do projeto)
    try { const { HttpsProxyAgent } = require('https-proxy-agent'); agent = new HttpsProxyAgent(process.env.HTTPS_PROXY); } catch (e) {}
  }
  const tts = new MsEdgeTTS(agent);
  await tts.setMetadata(edgeVoice(kokoroVoice), OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  try {
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('voz grátis: tempo esgotado')), 45000));
    const { audioFilePath } = await Promise.race([tts.toFile(dir, xmlEscape(text)), timer]);
    const buf = fs.readFileSync(audioFilePath);
    if (!buf.length) throw new Error('voz grátis: áudio vazio');
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
  } finally {
    try { tts.close && tts.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { synthesizeFree, edgeVoice };
