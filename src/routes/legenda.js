// Transcrição da entrevista → legenda sincronizada (Whisper com timestamp por palavra).
// Provedores, sem chave nova:
//   1) Groq (LLM_API_KEY gsk_) → whisper-large-v3 verbose_json
//   2) fal.ai (FAL_KEY)        → fal-ai/whisper chunk_level=word (custo $0/seg)
// → segmentos com quebra natural (pausa >0.55s ou ≈44 chars/linha, máx 2 linhas) → SRT.

const express = require('express');
const multer = require('multer');
const axios = require('axios');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 450 * 1024 * 1024 } });

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_LINE = 44;

// Fallback: Whisper do fal (usa a FAL_KEY já configurada — custo $0/segundo).
// Endpoint fal-ai/whisper com chunk_level=word → chunks [{timestamp:[start,end], text}].
async function transcreverFal(buffer, mime, ext) {
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: process.env.FAL_KEY || '' });
  const url = await fal.storage.upload(new Blob([buffer], { type: mime }), { fileName: `entrevista.${ext || 'mp4'}` });

  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  const post = await axios.post('https://queue.fal.run/fal-ai/whisper', {
    audio_url: url,
    task: 'transcribe',
    chunk_level: 'word',
    language: 'pt',
  }, { headers, timeout: 60000, validateStatus: (s) => s < 500 });

  if (post.data && post.data.status_url) {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await axios.get(post.data.status_url, { headers, timeout: 20000, validateStatus: (s) => s < 500 });
      const sd = st.data || {};
      if (sd.status === 'COMPLETED') break;
      if (sd.status === 'ERROR') throw new Error('Whisper fal falhou: ' + JSON.stringify(sd).slice(0, 200));
    }
  }

  let data = null;
  if (post.data && post.data.response_url) {
    try { data = (await axios.get(post.data.response_url, { headers, timeout: 30000 })).data; } catch (e) {}
  }
  if (!data || !data.chunks) data = post.data && post.data.output ? post.data.output : null;
  if (!data || !Array.isArray(data.chunks)) throw new Error('Whisper fal não devolveu chunks.');

  // Chunks → words [{word,start,end}] (mesma forma do Groq)
  return (data.chunks || [])
    .filter((c) => c && c.text && Array.isArray(c.timestamp) && c.timestamp.length === 2)
    .map((c) => ({ word: String(c.text || '').trim(), start: c.timestamp[0], end: c.timestamp[1] }));
}

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
    if (!req.file) return res.status(400).json({ error: 'Envie a entrevista no campo "video".' });
    const key = process.env.LLM_API_KEY || '';
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const mimes = {
      mp4: 'video/mp4', mov: 'video/mp4', m4v: 'video/mp4', m4a: 'audio/mp4',
      mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac',
    };
    const mime = mimes[ext] || req.file.mimetype || 'video/mp4';

    let language = 'pt';
    let text = '';
    let words = null;

    if (key.startsWith('gsk_')) {
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
      language = data.language || 'pt';
      text = data.text || '';
      words = Array.isArray(data.words)
        ? data.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
        : null;
      if (!words || !words.length) {
        return res.status(422).json({ error: 'Whisper não devolveu palavras com tempo. Confira se há fala (use o áudio do celular, não tela preta).' });
      }
    } else if (process.env.FAL_KEY) {
      words = await transcreverFal(req.file.buffer, mime, ext);
      if (!words || !words.length) {
        return res.status(422).json({ error: 'Whisper não devolveu palavras com tempo. Confira se há fala (use o áudio do celular, não tela preta).' });
      }
      text = words.map((w) => w.word).join(' ');
    } else {
      return res.status(400).json({ error: 'Nenhum provedor de transcrição configurado (Groq gsk_ ou FAL_KEY).' });
    }

    const segs = buildSegments(words);
    res.json({
      language,
      text,
      duration: segs.length ? segs[segs.length - 1].end : 0,
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
