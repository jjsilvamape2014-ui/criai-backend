const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/claims');
const TC = require('../src/textCheck');

test('promessa que o cliente não fez sai da fala; o resto fica', () => {
  const out = C.cleanVoice('A JN Refrigeração instala seu ar-condicionado com garantia. Fazemos avaliação gratuita. Chame no WhatsApp.', 'vídeo da JN Refrigeração, WhatsApp');
  assert.strictEqual(out, 'Chame no WhatsApp.');
  assert.strictEqual(C.cleanVoice('Conforto imediato e economia de energia.', 'JN'), '');
  assert.deepStrictEqual(C.disallowed('nosso técnico instala em até 48h', 'JN'), ['prazo']);
  assert.deepStrictEqual(C.disallowed('Economize energia e sinta o conforto', 'JN'), ['economia']);
  assert.deepStrictEqual(C.disallowed('É a única pizza grande por menos de cinquenta reais', 'Forno Bom'), ['lider / numero 1']);
});
test('prompt sem texto não manda escrever nada', () => {
  const p = TC.textFreePrompt('Instagram post for Forno Bom pizzeria, steaming pizza, while bold text **Promoção de Terça** in black font and price **R$ 49,90** appear; warm lighting.');
  assert.ok(!/Promoção|49,90|font/.test(p));
  assert.ok(/steaming pizza/.test(p));
  assert.deepStrictEqual(TC.requiredTexts(['R$ 49,90,']), ['R$ 49,90']);
});
test('promessa que o cliente fez fica', () => {
  assert.strictEqual(C.cleanVoice('Aproveite a promoção com 20% de desconto!', 'promoção 20% de desconto'), 'Aproveite a promoção com 20% de desconto!');
  assert.deepStrictEqual(C.disallowed('Certificado de qualidade por carga', 'XYZ: certificado de qualidade por carga'), []);
});
test('texto de tela perde só o trecho', () => {
  assert.strictEqual(C.cleanText('Oferta por tempo limitado!', 'pizzaria'), 'Oferta!');
});
test('textos obrigatórios ignoram tamanho da imagem', () => {
  assert.deepStrictEqual(TC.requiredTexts(['1350', 'Black Friday', 'R$ 49,90']), ['Black Friday', 'R$ 49,90']);
});

test('"garante" e "na hora" sem o cliente dizer saem da fala', () => {
  const C = require('../src/claims');
  assert.strictEqual(C.cleanVoice('Tecnologia XYZ garante resistência. Concreto bombeado na hora! Peça já.', 'concreto usinado'), 'Peça já.');
  assert.ok(C.cleanVoice('Atendimento na hora!', 'atendimento na hora').includes('na hora'));
});

test('nome da empresa não é cortado pela IA', () => {
  const B = require('../src/brandInfo');
  assert.strictEqual(B.extendBrand('Vídeo para a XYZ Tecnologia em Concreto: concreto usinado', 'XYZ Tecnologia'), 'XYZ Tecnologia em Concreto');
  assert.strictEqual(B.extendBrand('vídeo da JN Refrigeração em Belém', 'JN Refrigeração'), 'JN Refrigeração');
  assert.strictEqual(B.extendBrand('post da Bella Napoli WhatsApp 11 9999', 'Bella Napoli'), 'Bella Napoli');
});

test('preço e telefone viram texto exato da peça', () => {
  const TC = require('../src/textCheck');
  const m = 'post da Pizzaria Bella Napoli "Pizza grande R$ 49,90" WhatsApp (11) 97777-1234';
  assert.deepStrictEqual(TC.exactTexts(m), ['(11) 97777-1234', 'R$ 49,90']);
  assert.deepStrictEqual(TC.pieceTexts(['Pizza grande R$ 49,90', '49', '11'], m), ['Pizza grande R$ 49,90', '(11) 97777-1234']);
});

test('qualidades inventadas saem (premium, aditivos, equipe qualificada)', () => {
  const C = require('../src/claims');
  assert.strictEqual(C.cleanVoice('Equipe qualificada, produtos premium e conforto total. Agende já.', 'salão'), 'Agende já.');
  assert.strictEqual(C.cleanText('Profissionais qualificados e ambiente acolhedor', 'salão'), 'ambiente acolhedor');
  assert.ok(C.cleanVoice('Nossos especialistas cuidam de você.', 'temos especialistas').includes('especialistas'));
});

test('correção só do texto: detecta e troca o título/preço/telefone certo', () => {
  const TC = require('../src/textCheck');
  assert.ok(TC.isTextOnlyFix('o preço está errado, é R$ 39,90'));
  assert.ok(TC.isTextOnlyFix('o texto é "Pizza gigante"'));
  assert.ok(!TC.isTextOnlyFix('muda o fundo para azul e o preço R$ 30,00'));
  assert.ok(!TC.isTextOnlyFix('faz um novo post R$ 10,00'));
  assert.deepStrictEqual(TC.mergePieceTexts(['Pizza grande R$ 49,90', '(11) 97777-1234'], ['R$ 39,90']), ['Pizza grande R$ 39,90', '(11) 97777-1234']);
  assert.deepStrictEqual(TC.mergePieceTexts(['Pizza grande R$ 49,90', '(11) 97777-1234'], ['Pizza gigante']), ['Pizza gigante R$ 49,90', '(11) 97777-1234']);
});

test('"Corte masculino" entre aspas é correção só de texto', () => {
  const TC = require('../src/textCheck');
  assert.ok(TC.isTextOnlyFix('o texto é "Corte masculino"'));
  assert.ok(TC.isTextOnlyFix('o texto é "Cores do Brasil"'));
  assert.ok(!TC.isTextOnlyFix('muda a cor para azul'));
});

test('promoção relâmpago, "até o fim da semana" e premium inventados saem', () => {
  const C = require('../src/claims');
  assert.strictEqual(C.cleanVoice('Bom dia! Aproveite 15 % de desconto até o fim da semana!', 'post de bom dia'), 'Bom dia!');
  assert.strictEqual(C.cleanVoice('Sabor premium por preço popular. Peça já.', 'pizzaria'), 'Peça já.');
});
