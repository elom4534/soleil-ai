/**
 * ============================================================================
 * SOLEIL — §9 à §12 (Phase 15) · Section publique « matchs à venir »
 * ============================================================================
 * Règle unique : **l'interface publique de prédictions ne montre que des
 * rencontres à venir qui disposent d'une prédiction valide.** Tout le reste
 * (matchs terminés, en cours, reportés, sans prédiction, ou dont les
 * probabilités ne passent pas le contrôle de cohérence) reste dans la base
 * pour l'entraînement, le backtesting et l'analyse — mais n'est pas présenté
 * comme une prédiction.
 *
 * Séparation stricte des deux mondes :
 *
 *   base de données
 *   ├── historique (matchs joués)      → interne : apprentissage, évaluation
 *   ├── prédictions historiques        → interne : audit, erreurs
 *   └── prédictions à venir valides    → interface publique
 *
 * Cette séparation est appliquée côté serveur : aucune page ne reçoit une
 * rencontre terminée, même si l'affichage changeait demain.
 */

import type { MatchStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkPredictionView } from "@/lib/coherence";
import { toDisplay, type PredictionView } from "./presenter";
import { MATCH_INCLUDE, PREDICTION_SUMMARY, type MatchListItem } from "./queries";

/** §10 — Statuts publics exposés à l'interface. */
export type PublicMatchStatus =
  | "UPCOMING"
  | "LIVE"
  | "FINISHED"
  | "POSTPONED"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * §10 — Correspondance stricte entre les statuts de la base et les statuts
 * publics. Aucun statut n'est « interprété » : `SUSPENDED` (rencontre
 * interrompue) n'est pas une rencontre à venir, il rejoint « annulé ».
 */
export function toPublicStatus(status: MatchStatus): PublicMatchStatus {
  switch (status) {
    case "SCHEDULED":
      return "UPCOMING";
    case "LIVE":
    case "IN_PLAY":
    case "PAUSED":
      return "LIVE";
    case "FINISHED":
      return "FINISHED";
    case "POSTPONED":
      return "POSTPONED";
    case "CANCELLED":
    case "SUSPENDED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

/** Seul statut autorisé dans la liste publique des prédictions (§10). */
export const PUBLIC_PREDICTION_STATUSES: PublicMatchStatus[] = ["UPCOMING"];

export type RejectionReason =
  | "MATCH_PAS_A_VENIR"
  | "STATUT_NON_UPCOMING"
  | "DATE_INVALIDE"
  | "AUCUNE_PREDICTION"
  | "PREDICTION_NON_PUBLIEE"
  | "DONNEES_DE_PREDICTION_MANQUANTES"
  | "INCOHERENCE_DETECTEE"
  | "CONFIANCE_INSUFFISANTE";

export interface Rejection {
  matchId: string;
  reason: RejectionReason;
  detail: string;
}

/** Données minimales exigées pour afficher une prédiction (§9, point 6). */
export function missingMarketData(view: PredictionView | null): string[] {
  if (!view) return ["vue de prédiction absente"];
  const missing: string[] = [];
  if (!view.outcomes || typeof view.outcomes.home !== "number") missing.push("1X2");
  if (!Array.isArray(view.totalGoals) || view.totalGoals.length === 0) missing.push("Over/Under");
  if (!view.btts || typeof view.btts.yes !== "number") missing.push("BTTS");
  if (!view.teamGoals || view.teamGoals.length < 2) missing.push("buts par équipe");
  if (!view.exactScore?.top?.length) missing.push("scores exacts");
  return missing;
}

/**
 * Contenu chargé pour chaque candidat : le résumé d'affichage et la vue
 * persistée (`matchResult.factors`). Une seule requête pour tout le lot.
 */
const VALIDATION_SELECT = {
  ...PREDICTION_SUMMARY,
  modelVersion: true,
  matchResult: { select: { homeWinProb: true, drawProb: true, awayWinProb: true, consensusPick: true, factors: true } },
} as const;

export interface UpcomingResult {
  /** Rencontres affichables, triées par date — même forme que les autres listes. */
  matches: MatchListItem[];
  /** Rencontres écartées, avec la raison — alimente les chiffres du rapport. */
  rejected: Rejection[];
  /** Comptage par raison, pour l'audit. */
  counts: Record<RejectionReason, number>;
}

const emptyCounts = (): Record<RejectionReason, number> => ({
  MATCH_PAS_A_VENIR: 0,
  STATUT_NON_UPCOMING: 0,
  DATE_INVALIDE: 0,
  AUCUNE_PREDICTION: 0,
  PREDICTION_NON_PUBLIEE: 0,
  DONNEES_DE_PREDICTION_MANQUANTES: 0,
  INCOHERENCE_DETECTEE: 0,
  CONFIANCE_INSUFFISANTE: 0,
});

/**
 * Liste publique des prédictions à venir.
 *
 * Le filtrage est fait **côté serveur**, en trois temps :
 *   1. la requête SQL n'accepte que les rencontres programmées et futures ;
 *   2. chaque rencontre est ensuite validée une par une (statut public, date,
 *      présence d'une prédiction publiée, marchés complets, cohérence) ;
 *   3. seules les rencontres qui passent les six conditions du §9 sortent.
 *
 * Le troisième temps est volontairement redondant avec le premier : c'est ce
 * qu'exige le §12 (« avant affichage, effectuer une vérification »).
 */
/**
 * Instant de référence de la liste publique. Il est fourni par la couche
 * serveur et non calculé dans le rendu : la requête et l'affichage comparent
 * ainsi la même seconde, et un composant ne lit jamais l'horloge lui-même.
 */
export function referenceClock(): Date {
  return new Date();
}

export async function listUpcomingPredictions(options: { limit?: number; now?: Date } = {}): Promise<UpcomingResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 30;

  const rows = await prisma.match.findMany({
    where: {
      // §9 (1, 2, 4) et §12 — la rencontre doit être à venir au sens strict.
      status: { in: ["SCHEDULED"] },
      utcDate: { gt: now },
      // §9 (5) — une prédiction doit exister.
      predictions: { some: { status: "PUBLISHED" } },
    },
    include: {
      ...MATCH_INCLUDE,
      predictions: {
        where: { status: "PUBLISHED" },
        orderBy: { generatedAt: "desc" },
        take: 1,
        // Une seule requête : le résumé destiné à la carte, plus la vue
        // persistée dont dépend le contrôle de cohérence (§19). Aucune
        // requête supplémentaire par rencontre, aucun N+1.
        select: VALIDATION_SELECT,
      },
    },
    orderBy: { utcDate: "asc" },
    take: limit,
  });

  const matches: MatchListItem[] = [];
  const rejected: Rejection[] = [];
  const counts = emptyCounts();

  const reject = (matchId: string, reason: RejectionReason, detail: string) => {
    counts[reason] += 1;
    rejected.push({ matchId, reason, detail });
  };

  for (const match of rows) {
    const publicStatus = toPublicStatus(match.status);

    // §10 — seul UPCOMING est accepté.
    if (!PUBLIC_PREDICTION_STATUSES.includes(publicStatus)) {
      reject(match.id, "STATUT_NON_UPCOMING", `statut ${match.status} → ${publicStatus}`);
      continue;
    }
    // §12 — la date doit être valide et postérieure à maintenant.
    const kickoff = match.utcDate;
    if (Number.isNaN(kickoff.getTime())) {
      reject(match.id, "DATE_INVALIDE", "date de coup d'envoi illisible");
      continue;
    }
    if (kickoff.getTime() <= now.getTime()) {
      reject(match.id, "MATCH_PAS_A_VENIR", `coup d'envoi ${kickoff.toISOString()} déjà passé`);
      continue;
    }

      const prediction = match.predictions[0];
    if (!prediction) {
      reject(match.id, "AUCUNE_PREDICTION", "aucune prédiction enregistrée");
      continue;
    }
    if (prediction.status !== "PUBLISHED") {
      reject(match.id, "PREDICTION_NON_PUBLIEE", `statut de prédiction ${prediction.status}`);
      continue;
    }

    const view = toDisplay(prediction as never);

    // §9 (6) — les marchés affichés doivent avoir leurs données.
    const missing = missingMarketData(view);
    if (missing.length > 0) {
      reject(match.id, "DONNEES_DE_PREDICTION_MANQUANTES", `marchés incomplets : ${missing.join(", ")}`);
      continue;
    }

    // §19 — une prédiction incohérente n'est pas affichée.
    const coherence = checkPredictionView(view);
    if (!coherence.ok) {
      reject(
        match.id,
        "INCOHERENCE_DETECTEE",
        coherence.critical.map((v) => v.code).join(", "),
      );
      continue;
    }

    // La carte consomme le résumé ; on le renvoie tel quel, sans transformation.
    matches.push({
      ...match,
      predictions: [prediction as unknown as MatchListItem["predictions"][number]],
    });
  }

  return { matches, rejected, counts };
}

/**
 * Comptage de ce qui est masqué à l'utilisateur, par catégorie.
 * Sert au rapport §23 et à l'état vide de l'interface : l'utilisateur doit
 * comprendre *pourquoi* rien n'est affiché.
 */
export async function upcomingVisibilityReport(now = new Date()) {
  const [upcoming, finished, liveOrOther, withoutPrediction, notPublished] = await Promise.all([
    prisma.match.count({ where: { status: "SCHEDULED", utcDate: { gt: now }, predictions: { some: { status: "PUBLISHED" } } } }),
    prisma.match.count({ where: { status: "FINISHED" } }),
    prisma.match.count({ where: { status: { in: ["LIVE", "IN_PLAY", "PAUSED", "POSTPONED", "CANCELLED", "SUSPENDED"] } } }),
    prisma.match.count({ where: { status: "SCHEDULED", utcDate: { gt: now }, predictions: { none: {} } } }),
    prisma.match.count({
      where: { status: "SCHEDULED", utcDate: { gt: now }, predictions: { some: { status: "GENERATED" } } },
    }),
  ]);

  return {
    /** Candidats bruts : rencontres programmées, futures, avec prédiction publiée. */
    candidates: upcoming,
    /** Matchs terminés, conservés pour l'apprentissage mais hors interface. */
    hiddenFinished: finished,
    /** Matchs en cours, reportés, annulés : hors interface publique. */
    hiddenNonUpcoming: liveOrOther,
    /** Rencontres à venir sans aucune prédiction : jamais présentées comme telles. */
    hiddenWithoutPrediction: withoutPrediction,
    /** Rencontres à venir dont la prédiction n'a pas passé les seuils de publication. */
    hiddenNotPublished: notPublished,
  };
}
