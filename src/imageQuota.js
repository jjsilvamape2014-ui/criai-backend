// 🖼️ COBRANÇA DE IMAGEM — de qual carteira sai o crédito e o que devolver na falha
//
// Bug real corrigido aqui: o POST /image cobrava de uma carteira e o catch
// devolvia sempre 1 crédito COMPRADO, mesmo quando nada foi cobrado (conta
// ilimitada) ou quando o débito saiu das imagens do mês. Ou seja, uma falha
// de geração CRIAva crédito do nada — e o plano PREMIUM, que nem cobra, virava
// impressora de crédito a cada falha.
//
// Tudo aqui é função pura (sem banco, sem rede) pra poder ser testado direto.

// Decide o que debitar antes de gerar. Devolve { p, v }:
//   p = créditos comprados a debitar
//   v = imagens do mês (créditos mensais) a debitar
// { p: 0, v: 0 } = não se cobra nada (conta ilimitada).
function cobrancaImagem({ ilimitado, creditosComprados } = {}) {
  if (ilimitado) return { p: 0, v: 0 };
  if (Number(creditosComprados) > 0) return { p: 1, v: 0 };
  return { p: 0, v: 1 };
}

// Monta o objeto de incremento do Prisma para devolver o que foi cobrado.
// Objeto vazio = nada a devolver (a rota então nem chama o update).
function estornoParaPrisma(charge) {
  const data = {};
  const p = (charge && Number(charge.p)) || 0;
  const v = (charge && Number(charge.v)) || 0;
  if (p > 0) data.creditsPurchased = { increment: p };
  if (v > 0) data.creditsImages = { increment: v };
  return data;
}

module.exports = { cobrancaImagem, estornoParaPrisma };
