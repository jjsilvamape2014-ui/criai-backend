// Sobe os 65 presets de movimento de câmera para o banco.
// Idempotente: upsert por slug — rodar quantas vezes for preciso não duplica nada.
// Fonte de verdade: src/data/motion-presets.json (cópia do plano; muda só por deploy).
// Rodar: node src/scripts/seed-motion-presets.js
require('dotenv').config();

// Sem banco configurado, recusa ANTES de qualquer conexão (nunca toca em banco alheio)
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada — seed recusado (nenhum banco foi tocado).');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const PRESETS = require('../data/motion-presets.json');

const prisma = new PrismaClient();

async function main() {
  let upserted = 0;
  for (let i = 0; i < PRESETS.length; i++) {
    const p = PRESETS[i];
    const data = {
      slug: p.slug,
      name: p.name,
      group: p.group,
      labelPt: p.labelPt || null,
      prompt: p.prompt,
      negative: p.negative,
      supportedModels: p.supportedModels || [],
      badge: p.badge || null,
      confidence: p.confidence || 'medium',
      originalBaseModel: p.originalBaseModel || null,
      previewUrl: p.previewUrl || null,
      enabled: true,
      // posição = ordem do JSON (a UI lista nessa ordem)
      position: i
    };
    // upsert por slug: já existindo (id do JSON ou não), só atualiza
    await prisma.motionPreset.upsert({
      where: { slug: p.slug },
      update: data,
      create: { id: p.id, ...data }
    });
    upserted++;
  }
  console.log(`✔ ${upserted} presets de movimento no banco (idempotente).`);
}

main()
  .catch((e) => {
    console.error('Seed de presets falhou:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
