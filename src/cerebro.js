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
      refImages: [], // até 4 imagens de referência anexadas na conversa
      currentPrompt: '', // prompt técnico acumulado da edição
      edits: [], // [{ message, delta, replaced, reply, ts }]
      project: {
        brand: '', // nome da marca (ex: "XYZ Tecnologia")
        colors: [], // cores da identidade visual (ex: ["azul escuro", "vermelho", "cinza"])
        style: '', // estilo visual (ex: "profissional", "industrial", "institucional")
        objective: '', // objetivo da peça (ex: "post LinkedIn", "banner site", "recrutamento")
        constraints: [], // restrições que persistem (ex: ["sem preto", "usar 20 MPa"])
        typography: '' // tipografia/linguagem visual (ex: "sans-serif moderna")
      }
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
// Inclui contexto do projeto (marca, cores, estilo, restrições) para manter coerência visual
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

  // Aplica contexto do projeto se houver (mantém coerência visual entre versões)
  const proj = memory.project || {};
  const ctx = [];
  if (proj.brand) ctx.push(`brand: ${proj.brand}`);
  if (proj.colors && proj.colors.length) ctx.push(`colors: ${proj.colors.join(', ')}`);
  if (proj.style) ctx.push(`style: ${proj.style}`);
  if (proj.objective) ctx.push(`purpose: ${proj.objective}`);
  if (proj.constraints && proj.constraints.length) ctx.push(`constraints: ${proj.constraints.join('; ')}`);
  if (proj.typography) ctx.push(`typography: ${proj.typography}`);

  // Prefixa contexto do projeto (uma vez) no início do prompt
  if (ctx.length && !memory.currentPrompt.startsWith('[')) {
    memory.currentPrompt = `[Project: ${ctx.join(' | ')}] ${memory.currentPrompt}`;
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