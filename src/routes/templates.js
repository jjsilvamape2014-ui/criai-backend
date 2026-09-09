const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware');

const router = express.Router();

// FREEPIK — modelos de design prontos (gratuitos). Use a chave gratuita da API:
//   https://www.freepik.com/p/api  (X-Freepik-API-Key)
// Sem FREEPIK_API_KEY configurada, retorna 501 (a UI avisa "configure antes").
const FREEPIK_API = 'https://api.freepik.com/v1/resources';

// Busca "modelos" (templates) inspirados no tema pedido, em PT, priorizando grátis.
// O usuário escolhe um modelo e o Cérebro o usa como base/estilo para o design.
router.get('/freepik', authMiddleware, async (req, res) => {
  const key = process.env.FREEPIK_API_KEY;
  if (!key) {
    return res.status(501).json({ error: 'FREEPIK_NOT_CONFIGURED' });
  }
  const q = (req.query.q || 'flyer').trim().slice(0, 60);
  const limit = Math.min(8, Math.max(1, Number(req.query.limit) || 8));
  try {
    const r = await axios.get(FREEPIK_API, {
      params: {
        locale: 'pt-BR',
        limit,
        order: '-relevance',
        'filters[term][freepik]': q,
        'filters[is_premium][freepik]': 'false'
      },
      headers: {
        'X-Freepik-API-Key': key,
        'Accept-Language': 'pt-BR'
      },
      timeout: 15000
    });
    const items = (r.data && r.data.data) || [];
    const templates = items
      .map((it) => ({
        id: it.id,
        title: it.title || '',
        thumb: (it.image && ((it.image.source && it.image.source.url) || it.image.url)) || null,
        page: it.url || (it.image && it.image.link) || null,
        download: (it.download && it.download.url) || null,
        premium: !!it.is_premium,
        attribution: !!(it.requires_attribution || it.premium === false && !it.is_premium)
      }))
      .filter((t) => !t.premium && t.thumb)
      .slice(0, limit);
    res.json({ success: true, query: q, templates });
  } catch (e) {
    console.error('Freepik falhou:', (e.response && e.response.status), (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 200)) || e.message);
    res.status(502).json({ error: 'FREEPIK_FAILED', detail: (e.response && e.response.status) || 'network' });
  }
});

module.exports = router;