-- ============================================================================
-- Phase 15 — Apprentissage des erreurs, versionnage du modèle, cache visuel.
-- Trois tables ajoutées, aucune table existante modifiée :
--   ModelVersion     : registre append-only des versions du moteur (§7)
--   PredictionError  : erreur mesurée de chaque prédiction réglée (§4, §5)
--   AssetCache       : visuels fournis par les sources, avec provenance (§15)
-- ============================================================================

-- CreateEnum
CREATE TYPE "ModelVersionStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'ROLLED_BACK', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "calibrationVersion" TEXT,
    "xgWeight" DOUBLE PRECISION NOT NULL,
    "outcomeSource" TEXT NOT NULL,
    "trainingCutoff" TIMESTAMP(3),
    "dataSnapshot" TEXT NOT NULL,
    "status" "ModelVersionStatus" NOT NULL DEFAULT 'CANDIDATE',
    "validation" JSONB,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictionError" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "versionId" TEXT,
    "predictedAt" TIMESTAMP(3) NOT NULL,
    "matchDate" TIMESTAMP(3) NOT NULL,
    "error1x2" DOUBLE PRECISION NOT NULL,
    "errorOver25" DOUBLE PRECISION NOT NULL,
    "errorBtts" DOUBLE PRECISION NOT NULL,
    "errorTeamHome" DOUBLE PRECISION NOT NULL,
    "errorTeamAway" DOUBLE PRECISION NOT NULL,
    "errorExactScore" DOUBLE PRECISION,
    "brier" DOUBLE PRECISION NOT NULL,
    "logLoss" DOUBLE PRECISION NOT NULL,
    "calibration" DOUBLE PRECISION NOT NULL,
    "biasHome" DOUBLE PRECISION NOT NULL,
    "biasOver25" DOUBLE PRECISION NOT NULL,
    "biasBtts" DOUBLE PRECISION NOT NULL,
    "competition" TEXT NOT NULL,
    "season" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "dataGrade" TEXT NOT NULL,
    "xgUsed" BOOLEAN NOT NULL,
    "xgWeight" DOUBLE PRECISION NOT NULL,
    "expectedGoals" DOUBLE PRECISION,
    "favouriteSide" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetCache" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastVerified" TIMESTAMP(3),
    "reachable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersion_label_key" ON "ModelVersion"("label");

-- CreateIndex
CREATE INDEX "ModelVersion_status_createdAt_idx" ON "ModelVersion"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PredictionError_predictionId_key" ON "PredictionError"("predictionId");

-- CreateIndex
CREATE INDEX "PredictionError_predictedAt_idx" ON "PredictionError"("predictedAt");

-- CreateIndex
CREATE INDEX "PredictionError_competition_idx" ON "PredictionError"("competition");

-- CreateIndex
CREATE INDEX "PredictionError_xgUsed_idx" ON "PredictionError"("xgUsed");

-- CreateIndex
CREATE INDEX "PredictionError_modelVersion_idx" ON "PredictionError"("modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCache_entityType_entityId_source_key" ON "AssetCache"("entityType", "entityId", "source");

-- CreateIndex
CREATE INDEX "AssetCache_entityType_entityId_idx" ON "AssetCache"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionError" ADD CONSTRAINT "PredictionError_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
