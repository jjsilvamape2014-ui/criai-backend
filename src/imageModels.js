// 🖼️ QUAL MODELO DESENHA CADA PEÇA (imagem criada do zero, sem imagem de referência)
//
// Antes: tudo saía do Flux Pro 1.1, que (1) erra muito texto em português e (2) só aceita
// as proporções 1:1, 16:9 e 9:16 — um post 4:5 (1080x1350) vinha 9:16 e era RECORTADO
// depois, cortando cabeça e corpo. Os logs mostravam exatamente isso ("texto errado na
// imagem", "QA reprovou… rosto e corpo recortados").
// Agora:
//   • peça com TEXTO impresso (nome, data, preço, frase) → Ideogram 3 (feito para tipografia)
//   • peça sem texto (foto, cena, produto)              → FLUX 2 Pro (tamanho exato, sem recorte)
//   • com imagem de referência continua a edição (Nano Banana), como antes
// Os dois aceitam largura × altura exatas, então o formato pedido sai sem recorte.
//
// Variáveis (opcionais): IMAGE_MODEL_TEXT (padrão "ideogram"), IMAGE_MODEL_PHOTO
// (padrão "flux2pro"). "fluxpro" em qualquer uma volta ao comportamento antigo.
// Preços (página de cada modelo no fal.ai, out/2026): Ideogram 3 BALANCED US$ 0,06 por
// imagem; FLUX 2 Pro US$ 0,03 o 1º megapixel (+ US$ 0,015 por megapixel extra).

function pickImageModel({ hasReference = false, needsText = false } = {}) {
  if (hasReference) return undefined; // edição da imagem enviada: cadeia de edição de sempre
  if (needsText) return process.env.IMAGE_MODEL_TEXT || 'ideogram';
  return process.env.IMAGE_MODEL_PHOTO || 'flux2pro';
}

// Modelos novos que, se falharem, devem tentar o Flux Pro 1.1 antes de cair na Stability
function hasFalFallback(model) {
  return !!model && model !== 'fluxpro' && model !== 'mystic';
}

module.exports = { pickImageModel, hasFalFallback };
