// 🎬 VÍDEO PELO POLLINATIONS — a reserva barata quando a fal.ai está fora.
//
// Por que existe: o Kling 3 na fal custa US$ 0,112/s (~US$ 0,56 por 5 s). O
// mesmo tipo de clip no Pollinations sai por 0,05 pollen/5 s (wan-2.2-fast) ou
// 0,42 pollen/5 s (kling-v3.0-std), e 1 pollen = US$ 1. Ou seja: 8x mais barato
// no modelo barato. É a reserva natural quando a fal fica sem saldo.
//
// Contrato (verificado na API real em 19/10/2026):
//   POST https://gen.pollinations.ai/v1/images/generations  (JSON, aceita vídeo)
//   Authorization: Bearer <chave>
//   { model, prompt, n, image, size, duration, resolution }
//   → 200 com header `Link: <https://media.pollinations.ai/...>; rel="enclosure"`
//   → 402 quando o saldo é insuficiente (pollen de quest NÃO paga vídeo)
//
// O header Link é o que interessa: devolve a URL pública do arquivo, que é
// exatamente o que o banco guarda em generations.imageUrl.
//
// Funções puras (buildBody, urlDoLink, erroLegivel) são testadas sem rede.

const axios = require('axios');

// Sobrescrevível só para teste local (servidor falso em node:test).
function baseUrl() {
  return (process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai').replace(/\/+$/, '');
}
// Modelo mais barato com imagem de entrada: 0,01 pollen/s (0,05 por 5 s, 480p).
// Trocar sem deploy: POLLINATIONS_VIDEO_MODEL=prunaai/p-video (0,02/s, 720p).
const MODELO_PADRAO = 'alibaba/wan-2.2-fast';

function apiKey() {
  return process.env.POLLINATIONS_API_KEY || '';
}

function enabled() {
  return Boolean(apiKey());
}

function modelo(override) {
  return String(override || process.env.POLLINATIONS_VIDEO_MODEL || MODELO_PADRAO).trim();
}

// Alguns modelos têm duração fixa (wan-2.2-fast só faz 5 s): mandar `duration`
// para eles vira 400. Só envia quando o modelo aceita.
function duracaoFixa(m) {
  return /wan-2\.2-fast/i.test(m);
}

// 9:16 / 16:9 / 1:1 → tamanho em pixels. Para vídeo o provedor usa isso só
// para definir o enquadramento; a resolução real vem de `resolution`.
function tamanho(aspectRatio) {
  switch (String(aspectRatio || '').trim()) {
    case '16:9': return '1280x720';
    case '1:1': return '1024x1024';
    case '9:16': return '720x1280';
    default: return null;
  }
}

// Corpo do POST. Puro: não toca em rede nem em env além do modelo.
function buildBody({ prompt, image, duration, aspectRatio, model } = {}) {
  const m = modelo(model);
  const body = {
    model: m,
    prompt: String(prompt || '').trim().slice(0, 4000),
    n: 1
  };
  // URL pública ou data URL — o corpo é JSON, então base64 não estoura a URL.
  if (image) body.image = image;
  const size = tamanho(aspectRatio);
  if (size) body.size = size;
  if (duration && !duracaoFixa(m)) body.duration = Math.round(Number(duration));
  return body;
}

// Extrai a URL pública do header Link. Formato:
//   <https://media.pollinations.ai/abc>; rel="enclosure"
function urlDoLink(link) {
  const texto = String(link || '');
  const comRel = texto.match(/<([^>]+)>\s*;\s*rel="?enclosure"?/i);
  if (comRel) return comRel[1];
  const qualquer = texto.match(/<([^>]+)>/);
  return qualquer ? qualquer[1] : null;
}

// Alguns modelos respondem JSON com output[].url em vez do header.
function urlDoCorpo(data) {
  const saida = data && Array.isArray(data.output) ? data.output : [];
  for (const item of saida) {
    if (!item) continue;
    if (typeof item.url === 'string' && item.url) return item.url;
    if (item.image && typeof item.image.url === 'string') return item.image.url;
    if (item.video && typeof item.video.url === 'string') return item.video.url;
  }
  if (data && typeof data.url === 'string' && data.url) return data.url;
  return null;
}

// Traduz o erro do provedor para algo que o usuário entende. Em especial o 402,
// que é o caso comum (sem pollen pago) e não deve parecer bug do app.
function erroLegivel(res) {
  const data = (res && res.data) || {};
  const detalhe = (data.error && (data.error.message || data.error.code)) || data.message || '';
  const status = (res && res.status) || 0;
  if (status === 402 || /insufficient balance|needs paid pollen/i.test(detalhe)) {
    return 'Pollinations sem saldo de vídeo (é preciso pollen pago — o pollen de quest não paga vídeo).';
  }
  if (status === 401) return 'Pollinations recusou a chave (POLLINATIONS_API_KEY inválida).';
  if (status === 429) return 'Pollinations limitou a taxa — tente de novo em instantes.';
  return `Pollinations falhou (HTTP ${status})${detalhe ? ': ' + String(detalhe).slice(0, 200) : ''}`;
}

// Gera o vídeo e devolve a URL pública. Lança Error legível em qualquer falha.
async function generate({ prompt, image, duration, aspectRatio, model, timeoutMs } = {}) {
  if (!enabled()) throw new Error('Pollinations não configurado (POLLINATIONS_API_KEY ausente)');
  const corpo = buildBody({ prompt, image, duration, aspectRatio, model });
  if (!corpo.prompt) throw new Error('Pollinations: prompt vazio');

  let res;
  try {
    res = await axios.post(`${baseUrl()}/v1/images/generations`, corpo, {
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json'
      },
      // vídeo leva de 30 s a poucos minutos; o teto evita pendurar a requisição
      timeout: Math.max(60000, Number(timeoutMs) || 300000),
      validateStatus: (s) => s >= 200 && s < 300
    });
  } catch (e) {
    // O axios lança fora da faixa 2xx (inclusive o 402 de saldo). Traduz aqui,
    // senão o usuário recebe "Request failed with status code 402" em vez da
    // explicação. Sem resposta = rede/timeout, que também precisa de texto claro.
    if (e.response) throw new Error(erroLegivel(e.response));
    throw new Error('Pollinations indisponível (rede/timeout): ' + String(e.message).slice(0, 160));
  }

  const url = urlDoLink(res.headers && (res.headers.link || res.headers.Link)) || urlDoCorpo(res.data);
  if (!url) throw new Error('Pollinations respondeu sem URL de vídeo');
  return url;
}

module.exports = {
  enabled,
  modelo,
  buildBody,
  urlDoLink,
  urlDoCorpo,
  erroLegivel,
  generate,
  MODELO_PADRAO
};
