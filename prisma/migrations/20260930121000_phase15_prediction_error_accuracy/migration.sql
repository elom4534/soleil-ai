-- ============================================================================
-- Phase 15 — Mesure de la réussite et de la calibration.
-- Deux colonnes ajoutées à PredictionError :
--   hit             : l'issue publiée s'est-elle réalisée ? (taux de réussite)
--   pickProbability : probabilité accordée à cette issue (base de l'ECE).
-- Les lignes existantes sont recalculables depuis les prédictions : le script
-- learning-build.ts est rejouable et réécrit donc des valeurs exactes.
-- ============================================================================
ALTER TABLE "PredictionError" ADD COLUMN "hit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PredictionError" ADD COLUMN "pickProbability" DOUBLE PRECISION NOT NULL DEFAULT 0;
