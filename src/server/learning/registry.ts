/**
 * ============================================================================
 * SOLEIL — §7 et §8 (Phase 15) · Versions du modèle et promotion contrôlée
 * ============================================================================
 * Deux principes non négociables :
 *
 *  1. **Rien n'est écrasé.** Chaque version est ajoutée au registre avec ce qui
 *     l'a produite : version du modèle, version de calibrage, poids du xG,
 *     date de coupure d'entraînement, empreinte des données. On peut donc
 *     toujours répondre à « quelle version a produit cette prédiction ? ».
 *
 *  2. **Une version ne remplace l'autre que si elle fait mieux, hors
 *     échantillon.** Si le gain n'est pas établi, l'ancienne version reste en
 *     production. Si une version promue se révèle moins bonne, elle est
 *     retirée (retour à la version précédente) — sans jamais toucher aux
 *     prédictions déjà publiées, qui restent attachées à leur version.
 *
 * L'agent conversationnel n'a aucun accès à ces fonctions (§8, §18).
 */

import { prisma } from "@/lib/prisma";

export type VersionStatus = "CANDIDATE" | "ACTIVE" | "ROLLED_BACK" | "ARCHIVED";

/** Résultat d'une validation temporelle, tel qu'il justifie une décision. */
export interface ValidationSummary {
  /** Métrique de décision : Brier (multiclasse 1X2) ou Log Loss. */
  metric: "brier" | "logLoss";
  /** Période de validation — la plus récente, jamais vue à l'écriture. */
  period: string;
  n: number;
  candidate: number;
  incumbent: number;
  /** candidate − incumbent : négatif = la candidate fait mieux. */
  delta: number;
  /** Intervalle de confiance apparié à 95 %. */
  ci: [number, number];
  /** Vrai si l'intervalle exclut zéro du bon côté. */
  established: boolean;
}

export interface VersionDescriptor {
  label: string;
  modelVersion: string;
  calibrationVersion: string | null;
  xgWeight: number;
  outcomeSource: "matrix" | "consensus";
  trainingCutoff: Date | null;
  dataSnapshot: string;
  /** Résultat de validation temporelle quand il existe. */
  validation: ValidationSummary | null;
  /**
   * Note libre, stockée à côté de la validation. Sert à documenter une
   * provenance ou une limite sans inventer une validation qui n'a pas eu lieu.
   */
  note?: string;
}

export type PromotionDecision = "PROMOTE" | "KEEP";

/**
 * Règle de promotion, explicite et volontairement stricte :
 * on ne remplace la version en production que si la candidate améliore la
 * métrique ET que l'intervalle de confiance apparié exclut l'absence de gain.
 * Un gain « non établi » n'est pas un gain.
 */
export function decidePromotion(validation: ValidationSummary | null): PromotionDecision {
  if (!validation) return "KEEP";
  if (!validation.established) return "KEEP";
  if (!(validation.delta < 0)) return "KEEP";
  return "PROMOTE";
}

/** Enregistre une version dans le registre. Append-only. */
export async function registerVersion(
  descriptor: VersionDescriptor,
  options: { status?: VersionStatus; supersedesId?: string | null } = {},
) {
  return prisma.modelVersion.create({
    data: {
      label: descriptor.label,
      modelVersion: descriptor.modelVersion,
      calibrationVersion: descriptor.calibrationVersion,
      xgWeight: descriptor.xgWeight,
      outcomeSource: descriptor.outcomeSource,
      trainingCutoff: descriptor.trainingCutoff,
      dataSnapshot: descriptor.dataSnapshot,
      status: options.status ?? "CANDIDATE",
      validation: descriptor.validation
        ? JSON.parse(
            JSON.stringify({
              ...descriptor.validation,
              ...(descriptor.note ? { note: descriptor.note } : {}),
            }),
          )
        : descriptor.note
          ? JSON.parse(JSON.stringify({ note: descriptor.note }))
          : undefined,
      supersedesId: options.supersedesId ?? null,
    },
  });
}

/** Version actuellement en production. */
export async function activeVersion() {
  return prisma.modelVersion.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
}

export async function listVersions(limit = 50) {
  return prisma.modelVersion.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

/**
 * Promeut une version validée : l'ancienne devient ARCHIVED, la nouvelle
 * ACTIVE. Les prédictions passées gardent leur `modelVersion` d'origine :
 * rien n'est réétiqueté.
 */
export async function promoteVersion(versionId: string, previousId: string | null) {
  return prisma.$transaction(async (tx) => {
    if (previousId) {
      await tx.modelVersion.update({
        where: { id: previousId },
        data: { status: "ARCHIVED" },
      });
    }
    return tx.modelVersion.update({
      where: { id: versionId },
      data: { status: "ACTIVE" },
    });
  });
}

/** Retrait d'une version : retour à la version précédente. */
export async function rollbackVersion(versionId: string, restoreId: string | null, reason: string) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.modelVersion.findUnique({ where: { id: versionId } });
    const validation = (current?.validation ?? {}) as Record<string, unknown>;
    await tx.modelVersion.update({
      where: { id: versionId },
      data: {
        status: "ROLLED_BACK",
        validation: JSON.parse(
          JSON.stringify({ ...validation, rollbackReason: reason, rolledBackAt: new Date().toISOString() }),
        ),
      },
    });
    if (restoreId) {
      await tx.modelVersion.update({ where: { id: restoreId }, data: { status: "ACTIVE" } });
    }
  });
}
