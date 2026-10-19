// Registry dos 65 presets de movimento de câmera (slice 1).
// Fonte de verdade: src/data/motion-presets.json (cópia do JSON do plano,
// aplicado no banco por src/scripts/sync-motion-presets.js no boot). Ler daqui é
// síncrono e não depende do banco: o JSON muda só por deploy, o banco serve a API.
// Busca por id/slug nunca lança exceção — preset desconhecido devolve null.
const PRESETS = require('./data/motion-presets.json');

// Índice por id E por slug: o mesmo preset responde pelos dois (o front envia o id,
// a página /motion/[slug] usa o slug).
const byKey = new Map();
for (const preset of PRESETS) {
  byKey.set(preset.id, preset);
  byKey.set(preset.slug, preset);
}

// Busca por id ou slug. Chave vazia/desconhecida → null (quem chama decide o 400).
function get(key) {
  if (key === null || key === undefined || key === '') return null;
  return byKey.get(String(key)) || null;
}

// Lista completa, na ordem do arquivo.
function list() {
  return PRESETS;
}

// Agrupa por "group" preservando a ordem do arquivo: { [group]: [preset, ...] }.
// models (opcional) filtra pelos que suportam aquele modelo, ex.: "kling-v3-i2v".
function groups(models) {
  const model = String(models || '').trim();
  const out = {};
  let count = 0;
  for (const preset of PRESETS) {
    if (model && !(preset.supportedModels || []).includes(model)) continue;
    if (!out[preset.group]) out[preset.group] = [];
    out[preset.group].push(preset);
    count++;
  }
  return { groups: out, count };
}

// Monta o prompt final: o preset SÓ ADICIONA o movimento de câmera ao texto que já
// existe (estilo de anúncio escolhido / pedido do usuário) — nunca sobrescreve.
function composePrompt(basePrompt, preset) {
  const base = String(basePrompt || '').trim();
  if (!preset || !String(preset.prompt || '').trim()) return base;
  if (!base) return preset.prompt.trim();
  return `${base}. ${preset.prompt.trim()}`;
}

// Valida o motionPresetId do POST /video antes de cobrar crédito.
// Sem id → { ok: true, preset: null } (o campo é opcional). Id desconhecido →
// { ok: false, error } com mensagem em pt-BR para a rota devolver 400.
function resolve(motionPresetId) {
  if (motionPresetId === null || motionPresetId === undefined || motionPresetId === '') {
    return { ok: true, preset: null };
  }
  const preset = get(motionPresetId);
  if (!preset) {
    return {
      ok: false,
      error: `Movimento de câmera inválido: "${motionPresetId}". Escolha um movimento da lista (GET /api/motion-presets).`
    };
  }
  return { ok: true, preset };
}

module.exports = { get, list, groups, composePrompt, resolve, count: PRESETS.length };
