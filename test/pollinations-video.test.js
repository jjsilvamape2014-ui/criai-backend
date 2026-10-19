// Testes das partes puras da reserva de vídeo no Pollinations.
// Sem rede: só construção de corpo, leitura de headers e tradução de erro.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/pollinationsVideo');

test('sem chave a reserva fica desligada', () => {
  const antes = process.env.POLLINATIONS_API_KEY;
  delete process.env.POLLINATIONS_API_KEY;
  assert.equal(P.enabled(), false);
  if (antes !== undefined) process.env.POLLINATIONS_API_KEY = antes;
});

test('com chave a reserva liga', () => {
  const antes = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = 'sk_teste';
  assert.equal(P.enabled(), true);
  if (antes === undefined) delete process.env.POLLINATIONS_API_KEY;
  else process.env.POLLINATIONS_API_KEY = antes;
});

test('modelo padrão é o mais barato (wan-2.2-fast)', () => {
  assert.equal(P.MODELO_PADRAO, 'alibaba/wan-2.2-fast');
  assert.equal(P.modelo(), 'alibaba/wan-2.2-fast');
  assert.equal(P.modelo('prunaai/p-video'), 'prunaai/p-video');
});

test('corpo: prompt limpo, imagem e tamanho por enquadramento', () => {
  const b = P.buildBody({ prompt: '  um gato andando  ', image: 'data:image/png;base64,AAA', aspectRatio: '9:16' });
  assert.equal(b.prompt, 'um gato andando');
  assert.equal(b.image, 'data:image/png;base64,AAA');
  assert.equal(b.size, '720x1280');
  assert.equal(b.n, 1);
});

test('corpo: enquadramentos 16:9 e 1:1', () => {
  assert.equal(P.buildBody({ prompt: 'x', aspectRatio: '16:9' }).size, '1280x720');
  assert.equal(P.buildBody({ prompt: 'x', aspectRatio: '1:1' }).size, '1024x1024');
  assert.equal(P.buildBody({ prompt: 'x', aspectRatio: '4:3' }).size, undefined);
});

test('corpo: wan-2.2-fast tem duração fixa — não manda duration', () => {
  const b = P.buildBody({ prompt: 'x', duration: 10, model: 'alibaba/wan-2.2-fast' });
  assert.equal(b.duration, undefined);
});

test('corpo: modelo de duração variável recebe duration arredondada', () => {
  const b = P.buildBody({ prompt: 'x', duration: 7.6, model: 'prunaai/p-video' });
  assert.equal(b.duration, 8);
});

test('corpo: prompt vazio continua vazio (generate recusa depois)', () => {
  assert.equal(P.buildBody({}).prompt, '');
});

test('urlDoLink: extrai a URL do header rel="enclosure"', () => {
  const l = '<https://media.pollinations.ai/abc123>; rel="enclosure", <https://x/y>; rel="next"';
  assert.equal(P.urlDoLink(l), 'https://media.pollinations.ai/abc123');
});

test('urlDoLink: sem rel, usa a primeira URL entre <>', () => {
  assert.equal(P.urlDoLink('<https://media.pollinations.ai/zzz>'), 'https://media.pollinations.ai/zzz');
});

test('urlDoLink: header vazio devolve null', () => {
  assert.equal(P.urlDoLink(''), null);
  assert.equal(P.urlDoLink(null), null);
});

test('urlDoCorpo: output[].url e fallback data.url', () => {
  assert.equal(P.urlDoCorpo({ output: [{ type: 'video', url: 'https://m/1' }] }), 'https://m/1');
  assert.equal(P.urlDoCorpo({ output: [{ video: { url: 'https://m/2' } }] }), 'https://m/2');
  assert.equal(P.urlDoCorpo({ url: 'https://m/3' }), 'https://m/3');
  assert.equal(P.urlDoCorpo({ output: [] }), null);
  assert.equal(P.urlDoCorpo(null), null);
});

test('erroLegivel: 402 explica que quest não paga vídeo', () => {
  const msg = P.erroLegivel({ status: 402, data: { error: { message: 'Insufficient balance' } } });
  assert.match(msg, /sem saldo/i);
  assert.match(msg, /pollen pago/i);
});

test('erroLegivel: 402 do modo quest também cai na explicação de saldo', () => {
  const msg = P.erroLegivel({
    status: 402,
    data: { error: { code: 'QUEST_POLLEN_ONLY', message: 'This model needs paid Pollen' } }
  });
  assert.match(msg, /sem saldo/i);
});

test('erroLegivel: 401 e 429 têm mensagens próprias', () => {
  assert.match(P.erroLegivel({ status: 401 }), /chave/i);
  assert.match(P.erroLegivel({ status: 429 }), /limite|taxa|instantes/i);
});

test('erroLegivel: outros status mantêm o detalhe do provedor', () => {
  const msg = P.erroLegivel({ status: 500, data: { message: 'boom interno' } });
  assert.match(msg, /HTTP 500/);
  assert.match(msg, /boom interno/);
});

// --- generate() com servidor falso: valida o HTTP de verdade, sem gastar pollen ---

const http = require('node:http');

function comServidor(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const porta = srv.address().port;
      const antes = {
        chave: process.env.POLLINATIONS_API_KEY,
        base: process.env.POLLINATIONS_BASE_URL
      };
      process.env.POLLINATIONS_API_KEY = 'sk_fake';
      process.env.POLLINATIONS_BASE_URL = `http://127.0.0.1:${porta}`;
      try {
        resolve(await fn(porta));
      } catch (e) {
        reject(e);
      } finally {
        srv.close();
        if (antes.chave === undefined) delete process.env.POLLINATIONS_API_KEY;
        else process.env.POLLINATIONS_API_KEY = antes.chave;
        if (antes.base === undefined) delete process.env.POLLINATIONS_BASE_URL;
        else process.env.POLLINATIONS_BASE_URL = antes.base;
      }
    });
  });
}

test('generate: POST no /v1/images/generations com Bearer e devolve a URL do Link', async () => {
  let visto = null;
  const url = await comServidor(
    (req, res) => {
      let corpo = '';
      req.on('data', (c) => (corpo += c));
      req.on('end', () => {
        visto = { metodo: req.method, caminho: req.url, auth: req.headers.authorization, corpo: JSON.parse(corpo) };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Link: '<https://media.pollinations.ai/video-abc>; rel="enclosure"'
        });
        res.end(JSON.stringify({ id: 'x', status: 'completed', output: [] }));
      });
    },
    async () => {
      const gerado = await P.generate({ prompt: 'um gato', image: 'data:image/png;base64,AAA', aspectRatio: '9:16' });
      return gerado;
    }
  );

  assert.equal(url, 'https://media.pollinations.ai/video-abc');
  assert.equal(visto.metodo, 'POST');
  assert.equal(visto.caminho, '/v1/images/generations');
  assert.equal(visto.auth, 'Bearer sk_fake');
  assert.equal(visto.corpo.model, 'alibaba/wan-2.2-fast');
  assert.equal(visto.corpo.prompt, 'um gato');
  assert.equal(visto.corpo.image, 'data:image/png;base64,AAA');
  assert.equal(visto.corpo.size, '720x1280');
});

test('generate: 402 vira mensagem de saldo, não "Request failed with status code"', async () => {
  const erro = await comServidor(
    (req, res) => {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance.' } }));
    },
    async () => {
      try {
        await P.generate({ prompt: 'x' });
        return null;
      } catch (e) {
        return e.message;
      }
    }
  );
  assert.match(erro, /sem saldo/i);
  assert.doesNotMatch(erro, /Request failed with status code/);
});

test('generate: 200 sem URL de vídeo é erro explícito', async () => {
  const erro = await comServidor(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', status: 'completed', output: [] }));
    },
    async () => {
      try {
        await P.generate({ prompt: 'x' });
        return null;
      } catch (e) {
        return e.message;
      }
    }
  );
  assert.match(erro, /sem URL de v/i);
});

