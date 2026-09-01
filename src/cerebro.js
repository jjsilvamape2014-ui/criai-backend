const crypto = require('crypto');

// MemoriaDB — armazenamento em memória por usuário/sessão.
// Para o "primeiro momento" com uma réplica única na Railway basta; o estado
// também é devolvido ao frontend (GET /memoria) para recompor o chat.
const STORE = new Map(); // key: `${userId}::${sessionId}`

function keyFor(userId, sessionId) {
  return `${userId}::${sessionId}`;
}

function newSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
}

function createSession(userId, sessionId) {
  return {
    id: sessionId,
    userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    memory: {
      baseImage: null, // imagem original (dataURL/URL) fornecida pelo usuário
      currentPrompt: '', // prompt técnico acumulado da edição
      edits: [] // [{ message, delta, replaced, reply, ts }]
    },
    history: [] // [{ role, message, imageUrl, ts }]
  };
}

function getOrCreateSession(userId, sessionId) {
  const k = keyFor(userId, sessionId);
  if (!STORE.has(k)) STORE.set(k, createSession(userId, sessionId));
  const s = STORE.get(k);
  s.updatedAt = Date.now();
  return s;
}

function getSession(userId, sessionId) {
  const k = keyFor(userId, sessionId);
  return STORE.get(k) || null;
}

function resetSession(userId, sessionId) {
  return STORE.delete(keyFor(userId, sessionId));
}

function listSessions(userId) {
  const prefix = `${userId}::`;
  const out = [];
  for (const [k, s] of STORE.entries()) {
    if (k.startsWith(prefix)) out.push(s);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function pushHistory(session, role, message, imageUrl) {
  session.history.push({ role, message, imageUrl: imageUrl || null, ts: Date.now() });
  session.updatedAt = Date.now();
  return session.history;
}

// Compõe o prompt técnico acumulado a partir do comando interpretado
function composePrompt(memory, cmd, userMessage) {
  if (cmd.replace_prompt) {
    memory.currentPrompt = (cmd.new_prompt || userMessage || '').trim();
    return memory.currentPrompt;
  }
  if (!memory.currentPrompt) {
    memory.currentPrompt = (userMessage || cmd.new_prompt || '').trim();
  }
  if (cmd.prompt_delta) {
    memory.currentPrompt = `${memory.currentPrompt.replace(/,?\s*$/, '')}, ${cmd.prompt_delta}`;
  }
  return memory.currentPrompt;
}

function aspectSizes(aspect) {
  if (aspect === '16:9') return { width: 1344, height: 768 };
  if (aspect === '9:16') return { width: 768, height: 1344 };
  return { width: 1024, height: 1024 };
}

module.exports = {
  STORE,
  newSessionId,
  getOrCreateSession,
  getSession,
  resetSession,
  listSessions,
  pushHistory,
  composePrompt,
  aspectSizes
};