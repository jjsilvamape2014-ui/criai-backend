-- Slice 1: registry de movimentos de câmera (65 presets) + coluna em generations.
-- Escrito à mão (não rodar `prisma migrate dev`): espelho do plano em
-- replica-video/schema.sql, seções 1 e 2, adaptado às convenções do init
-- (TEXT id sem default, TIMESTAMP(3), FK ON DELETE SET NULL ON UPDATE CASCADE).

-- CreateTable
CREATE TABLE "motion_presets" (
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

-- Estado enum-ish sem criar tipo novo (mesma escolha do plano/schema.sql)
ALTER TABLE "motion_presets" ADD CONSTRAINT "motion_presets_badge_check" CHECK ("badge" IN ('top_choice', 'new'));
ALTER TABLE "motion_presets" ADD CONSTRAINT "motion_presets_confidence_check" CHECK ("confidence" IN ('high', 'medium', 'low'));

-- CreateIndex
CREATE UNIQUE INDEX "motion_presets_slug_key" ON "motion_presets"("slug");
CREATE INDEX "motion_presets_group_position_idx" ON "motion_presets"("group", "position");
CREATE INDEX "motion_presets_enabled_position_idx" ON "motion_presets"("enabled", "position");

-- AlterTable: generations ganha a referência ao preset (opcional; SET NULL no delete)
ALTER TABLE "generations" ADD COLUMN "motion_preset_id" TEXT;

-- CreateIndex
CREATE INDEX "generations_motion_preset_id_idx" ON "generations"("motion_preset_id");

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_motion_preset_id_fkey" FOREIGN KEY ("motion_preset_id") REFERENCES "motion_presets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
