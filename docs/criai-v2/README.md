# CRIAI Anúncios v2 — contrato do pedido (versão adaptada)

Objetivo: o Cérebro não pode entregar uma coisa diferente da que o cliente pediu
(pediu imagem → veio vídeo; pediu roteiro → veio vídeo pronto; pediu anúncio sem dizer
de quê → veio anúncio genérico).

## O que foi implementado

| Parte do spec | Como ficou | Onde |
|---|---|---|
| Classificar o pedido em um tipo | `detectRequested` (código, sem IA): `imagem`, `video`, `roteiro_video`, `copy` | `src/contract.js` |
| Pedido ambíguo não gera entrega | `precheck`: pedido vazio ("faça um anúncio") sem empresa/imagem conhecida → pergunta; "vídeo, mas só a legenda" → pergunta | `src/contract.js`, `src/routes/cerebro.js` |
| Imagem nunca vira vídeo; vídeo nunca vira texto | `enforce`: corrige a ação escolhida pelo roteador de IA quando ela contradiz o pedido explícito | `src/contract.js`, `src/routes/cerebro.js` |
| Roteiro/legenda/copy | `deliverText`: entrega em texto, via JSON validado (`validateWrite`), sem renderizar e sem gastar crédito de vídeo | `src/contract.js`, `src/routes/cerebro.js` |
| Resposta sempre JSON parseável | roteador e entrega de texto validam o JSON e tentam de novo uma vez antes de desistir | `src/router.js`, `src/contract.js` |
| Validação final | feita em **código** (o tipo/forma da entrega bate com o pedido), não pela própria IA | `enforce`, `validateWrite` |
| Testes | 14 testes, incluindo os 4 casos do spec | `test/contract.test.js` (`npm test`) |

A resposta do `/api/cerebro/chat` ganhou o campo opcional `contract`
(`{ status: "precisa_clareza" | "ok", tipo, duvidas | entrega, validacao }`) quando o contrato age.

## Decisões (o que ficou diferente do spec, e por quê)

1. **Não são 6 campos obrigatórios em todo pedido.** Clientes de pequeno negócio escrevem
   pouco ("vídeo da minha pizzaria, WhatsApp tal"). Exigir objetivo, formato, público, canal,
   tom e restrições faria o app perguntar 4–6 coisas antes de qualquer entrega. Obrigatório é
   só o que não dá para deduzir: **o que anunciar**. Canal (Instagram/Reels), tom (do ramo) e
   restrições (nenhuma) têm padrão.
2. **O system prompt do Cérebro não foi substituído.** O app entrega vídeo pronto, animação de
   imagem, personagem falando e comercial com apresentador; o schema do spec (copy, anúncio,
   roteiro, imagem, campanha) não cobre isso. O contrato foi colocado **antes e depois** do
   roteador existente, sem trocá-lo.
3. **Sem etapa de "brief para aprovar" antes de todo vídeo.** Quem escolhe o botão ou descreve
   o pedido com clareza recebe o vídeo; a pergunta só aparece quando o pedido é ambíguo.
4. **`bate_com_pedido` não é autoavaliação da IA.** A mesma IA que gera tende a dizer "sim".
   A checagem é feita em código, comparando o tipo pedido com o tipo que seria entregue.
5. **Botões (opções fechadas) passam direto.** Quando o cliente escolhe "Anúncio em vídeo",
   "Animar minha imagem" etc., o tipo já é explícito.

## Riscos

- `detectRequested` usa palavras-chave: frases fora do padrão podem não ser classificadas
  (aí vale o roteador de IA, como antes). Ex.: "quero algo para o feed" não diz imagem nem vídeo.
- "Logo" e "foto" costumam ser **insumo** ("anima minha logo"); só "criar uma logo" conta como
  pedido de imagem. Um pedido como "logo animada" é tratado como vídeo.
- O pedido de imagem com tamanho (ex.: 1080x1350) é classificado corretamente, mas o gerador de
  imagem atual não garante esse tamanho exato.
- Pedido vazio + imagem anexada **não** pergunta (a imagem já diz o que anunciar).

## TODOs

- [ ] Respeitar o tamanho pedido (ex.: 1080x1350) no gerador de imagem (`routes/generate.js`).
- [ ] Botão "faz o vídeo" depois de um roteiro em texto usar `session.memory.lastScript` como base.
- [ ] Métrica: contar quantas vezes `enforce` corrigiu a ação (hoje só vai para o log com `contrato: ação corrigida`).
