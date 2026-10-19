-- Slice 1: registry de movimentos de câmera (65 presets) + coluna em generations.
--
-- ATENÇÃO: este arquivo é aplicado mais de uma vez, sem histórico compartilhado —
-- quem o aplica é o boot do servidor (src/boot.js → src/scripts/sync-motion-presets.js),
-- porque o deploy da Railway NÃO tem passo de migração e o DATABASE_URL só resolve
-- dentro da rede interna (ninguém consegue aplicar à mão). Por isso TUDO aqui é
-- idempotente: cada instrução usa IF NOT EXISTS e re-aplicar vira no-op garantido.
--
-- Deliberadamente SEM foreign key e SEM constraints CHECK:
--   • o Postgres não tem "ADD CONSTRAINT IF NOT EXISTS" → re-aplicar quebraria o boot;
--   • a integridade do preset já é garantida pelo app (src/motionPresets.js valida o
--     id contra o registry JSON ANTES de cobrar crédito) e badge/confidence já são
--     cobertos pelos testes. A FK aqui só comprava uma classe nova de falha de deploy.
--
-- Este arquivo também não pode conter blocos dollar-quoted nem ';' dentro de string
-- literal: o sync divide o arquivo em statements por split simples, com asserções que
-- falham alto se alguém mudar essa forma.

-- CreateTable (idempotente: tabela já existe → não mexe em nada do que já está lá)
CREATE TABLE IF NOT EXISTS "motion_presets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "label_pt" TEXT,
    "prompt" TEXT NOT NULL,
    "negative" TEXT NOT NULL,
    "supported_models" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "badge" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "original_base_model" TEXT,
    "preview_url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "motion_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (IF NOT EXISTS: índice já criado com o mesmo nome → no-op, não erro)
CREATE UNIQUE INDEX IF NOT EXISTS "motion_presets_slug_key" ON "motion_presets"("slug");
CREATE INDEX IF NOT EXISTS "motion_presets_group_position_idx" ON "motion_presets"("group", "position");
CREATE INDEX IF NOT EXISTS "motion_presets_enabled_position_idx" ON "motion_presets"("enabled", "position");

-- AlterTable: generations ganha a referência ao preset (TEXT puro, sem FK — ver topo).
-- ADD COLUMN IF NOT EXISTS existe desde o Postgres 9.6 e é o que impede o erro
-- P2022 ("coluna não existe") de derrubar toda a geração de vídeo no primeiro boot.
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "motion_preset_id" TEXT;

-- CreateIndex da coluna nova (mesmo contrato idempotente dos demais)
CREATE INDEX IF NOT EXISTS "generations_motion_preset_id_idx" ON "generations"("motion_preset_id");
