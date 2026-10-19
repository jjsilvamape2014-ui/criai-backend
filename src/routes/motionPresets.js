const express = require('express');
const { authMiddleware } = require('../middleware');
const motionPresets = require('../motionPresets');

const router = express.Router();

// Lista o registry de movimentos de câmera agrupado (65 presets).
// GET /api/motion-presets?models=kling-v3-i2v  →  { success, groups, count }
router.get('/', authMiddleware, (req, res) => {
  try {
    const { groups, count } = motionPresets.groups(req.query.models);
    res.json({ success: true, groups, count });
  } catch (err) {
    console.error('motion-presets falhou:', err.message);
    res.status(500).json({ error: 'Erro ao listar os movimentos de câmera' });
  }
});

module.exports = router;
