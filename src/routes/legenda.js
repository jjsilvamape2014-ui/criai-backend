// Transcrição da entrevista → legenda sincronizada (Whisper via Groq/Groq).
// Reusa a MESMA chave do LLM (LLM_API_KEY com gsk_ do Groq) — custo ~zero.
// Recebe MP4 (multipart) → whisper-large-v3 verbose_json com timestamp por palavra
// → segmentos com quebra natural (pausa >0.55s ou ≈44 chars/linha, máx 2 linhas) → SRT.

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 450 * 1024 * 1024 } });

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_LINE = 44;

function buildSegments(words) {
  const segs = [];
  let cur = null;
  let text = '';
  const emit = (start, end, t) => {
    const clean = String(t || '').replace(/^\s+|\s+$/g, '');
    if (clean) segs.push({ start, end, text: clean });
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] || {};
    const txt = String(w.word || '')
      .replace(/[.,;:!?()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!txt) continue;
    if (!cur) cur = { start: w.start, end: w.end };
    const gap = i > 0 ? (w.start || 0) - (words[i - 1].end || w.start || 0) : 0;
    if (text && (gap > 0.55 || (text + txt).length > MAX_LINE * 2)) {
      emit(cur.start, cur.end, text);
      cur = { start: w.start, end: w.end };
      text = txt;
    } else {
      text = text ? text + ' ' + txt : txt;
      cur.end = w.end;
    }
    if (text && text.length > MAX_LINE && !text.includes('\n')) {
      const sp = text.lastIndexOf(' ');
      if (sp > 0) text = text.slice(0, sp) + '\n' + text.slice(sp + 1);
    }
  }
  if (cur && text) emit(cur.start, cur.end, text);
  return segs;
}

const padN = (n) => String(n).padStart(2, '0');
function toSRT(segs) {
  const fmt = (s) => {
    s = Math.max(0, s || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${padN(h)}:${padN(m)}:${padN(sec)},${String(ms).padStart(3, '0')}`;
  };
  return segs.map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`).join('\n');
}

router.post('/transcribe', upload.single('video'), async (req, res) => {
  try {
    const key = process.env.LLM_API_KEY || '';
    if (!key.startsWith('gsk_') || !req.file) {
      return res.status(400).json({
        error: req.file
          ? 'Legenda usa a chave Groq (LLM_API_KEY gsk_). Configure no .env.'
          : 'Envie a entrevista no campo "video".',
      });
    }
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const mimes = {
      mp4: 'video/mp4', mov: 'video/mp4', m4v: 'video/mp4', m4a: 'audio/mp4',
      mp3: 'audio/mpeg', m4a2: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac',
    };
    const mime = mimes[ext] || req.file.mimetype || 'video/mp4';

    const fd = new FormData();
    fd.append('model', 'whisper-large-v3');
    fd.append('file', new Blob([req.file.buffer], { type: mime }), `entrevista.${ext || 'mp4'}`);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    fd.append('language', 'pt');

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(240000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && (data.error.message || data.error.detail)) || JSON.stringify(data).slice(0, 250);
      return res.status(502).json({ error: `Falha na transcrição (${r.status}): ${msg}` });
    }
    const words = Array.isArray(data.words)
      ? data.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
      : null;
    if (!words || !words.length) {
      return res.status(422).json({ error: 'Whisper não devolveu palavras com tempo. Confira se há fala (use o áudio do celular, não tela preta).' });
    }
    const segs = buildSegments(words);
    res.json({
      language: data.language || 'pt',
      text: data.text || '',
      duration: data.duration || (segs.length ? segs[segs.length - 1].end : 0),
      words,
      segments: segs,
      srt: toSRT(segs),
    });
  } catch (err) {
    console.error('Transcrição erro:', err.message);
    res.status(500).json({ error: 'Erro ao transcrever: ' + err.message });
  }
});

module.exports = router;
