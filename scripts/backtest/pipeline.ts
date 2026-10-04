/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Pipeline d'évaluation
 * ============================================================================
 * Reproduit la chaîne du moteur (`generatePrediction`) en laissant UNE seule
 * pièce interchangeable : le modèle xG.
 *
 * Objectif : les Modèles A et B doivent recevoir exactement le même contexte et
 * les mêmes modèles, à l'exception du signal xG. La fidélité de cette
 * reproduction est vérifiée par un test qui compare les sorties à celles du
 * moteur réel (`pipeline.test.ts`).
 *
 * §16 — Tous les marchés proviennent de la MÊME matrice de scores :
 *   distribution des buts → Over/Under → les deux équipes → BTTS → score exact.
 */

import {
  MAX_GOALS,
  bttsProbability,
  buildScoreMatrix,
  fitDixonColesRho,
  normalizeMatrix,
  outcomeProbabilities,
  overUnderProbability,
  totalGoalsDistribution,
} from "../../src/server/engine/math";
import {
  buildModelContext,
  formModel,
  homeAwayModel,
  poissonModel,
  statisticalModel,
  type ModelContext,
} from "../../src/server/engine/models";
import { consensusLambdas, runEnsemble } from "../../src/server/engine/ensemble";
import { consensusLambdasLab, runEnsembleLab } from "./ensemble-lab";
import { halfSplitRatios } from "../../src/server/engine/ratings";
import { teamGoalsDistribution } from "../../src/server/engine/math";
import type { MatchContext, ModelPrediction } from "../../src/server/engine/types";
import { OUTCOME_SOURCE } from "../../src/lib/constants";

export const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
export const TEAM_LINES = [0.5, 1.5, 2.5];
export const HALF_LINES = [0.5, 1.5, 2.5];

export interface HalfMarkets {
  expectedGoals: number;
  overUnder: { line: number; over: number; under: number }[];
  probAtLeastOneGoal: number;
  /**
   * Matrice de scores de la période. Exposée pour la phase 13 : les marchés de
   * mi-temps (1X2, buts par équipe, BTTS, score exact) doivent être LUS dans
   * cette matrice, jamais reconstruits à part. La matrice est celle qui produit
   * déjà les lignes Over/Under de la période — il n'y a pas de second calcul.
   */
  matrix: number[][];
}

export interface MarketProbabilities {
  outcomes: { home: number; draw: number; away: number };
  totals: { line: number; over: number; under: number }[];
  teamGoals: {
    home: { line: number; over: number; under: number }[];
    away: { line: number; over: number; under: number }[];
  };
  btts: { yes: number; no: number };
  firstHalf: HalfMarkets;
  secondHalf: HalfMarkets;
  /** Matrice normalisée — source unique des marchés (§16). */
  matrix: number[][];
  lambdas: { home: number; away: number };
  agreement: number;
  activeModels: number;
  /** Poids effectif du modèle xG dans le consensus (0 si inapplicable). */
  xgWeight: number;
  /**
   * 1X2 DÉRIVÉ DE LA MATRICE DE SCORES (§13, §19).
   * Chemin cohérent : les trois issues sont lues dans la distribution des
   * scores, au lieu d'être moyennées à part.
   */
  matrixOutcomes: { home: number; draw: number; away: number };
  /**
   * 1X2 CONSENSUS, tel que la moyenne pondérée des modèles le produit. Publié
   * systématiquement, y compris quand le moteur publie la matrice : c'est ce
   * qui permet de comparer les deux sources à configuration identique.
   */
  consensusOutcomes: { home: number; draw: number; away: number };
  /** Détail par modèle — uniquement si `verbose`. */
  models?: {
    name: string;
    weight: number;
    applicable: boolean;
    outcomes: { home: number; draw: number; away: number };
    expectedGoals: { home: number; away: number } | null;
  }[];
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function lambdaValue(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0.01;
}

/** Identique à `estimateRho` du moteur. */
function estimateRho(context: MatchContext): number {
  const fixtures = [...context.home.seasonMatches, ...context.away.seasonMatches].map((m) => ({
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    lambdaHome: context.leagueBaseline.homeGoalsPerMatch,
    lambdaAway: context.leagueBaseline.awayGoalsPerMatch,
  }));
  return fitDixonColesRho(fixtures);
}

function halfBlock(matrix: number[][], expected: number): HalfMarkets {
  return {
    expectedGoals: expected,
    overUnder: HALF_LINES.map((line) => {
      const { over, under } = overUnderProbability(matrix, line);
      return { line, over, under };
    }),
    probAtLeastOneGoal: overUnderProbability(matrix, 0.5).over,
    matrix,
  };
}

/** Identique à `buildHalfTimeMarkets` du moteur. */
function buildHalfTimeMarkets(context: MatchContext, lambdaHome: number, lambdaAway: number) {
  const baselineShare = context.leagueBaseline.firstHalfGoalShare;
  const homeShare =
    halfSplitRatios(context.home.seasonMatches, context.home.identity.id)?.firstHalfShare ?? baselineShare;
  const awayShare =
    halfSplitRatios(context.away.seasonMatches, context.away.identity.id)?.firstHalfShare ?? baselineShare;
  const homeFirstShare = clamp((homeShare + awayShare) / 2, 0.3, 0.62);

  const fhLambdaHome = lambdaHome * homeFirstShare;
  const fhLambdaAway = lambdaAway * homeFirstShare;
  const shLambdaHome = lambdaHome * (1 - homeFirstShare);
  const shLambdaAway = lambdaAway * (1 - homeFirstShare);

  return {
    firstHalf: halfBlock(buildScoreMatrix(fhLambdaHome, fhLambdaAway, { rho: 0, maxGoals: 7 }), fhLambdaHome + fhLambdaAway),
    secondHalf: halfBlock(buildScoreMatrix(shLambdaHome, shLambdaAway, { rho: 0, maxGoals: 7 }), shLambdaHome + shLambdaAway),
  };
}

function teamGoalsLines(matrix: number[][], side: "home" | "away") {
  const dist = teamGoalsDistribution(matrix, side);
  return TEAM_LINES.map((line) => {
    let over = 0;
    for (let goals = 0; goals < dist.length; goals++) {
      if (goals > line) over += dist[goals];
    }
    return { line, over, under: 1 - over };
  });
}

export interface PipelineOptions {
  /**
   * Modèle xG à utiliser. `null` = le modèle du moteur, qui restera
   * inapplicable si le contexte ne contient aucun xG (c'est le Modèle A).
   */
  xgModel?: ModelPrediction | null;
  /**
   * Fabrique du modèle xG. Reçoit le contexte de modèles construit ici même,
   * afin que la variante lise exactement les mêmes séries que le moteur.
   */
  xgVariant?: (ctx: ModelContext) => ModelPrediction;
  /**
   * Poids a priori du modèle xG dans le consensus (§5).
   * `undefined` → le moteur, inchangé (0,20). `0` → modèle écarté.
   * Fournir cette option fait passer par le banc d'essai `ensemble-lab.ts`.
   */
  xgBaseWeight?: number;
  /** Exposer le détail par modèle (analyse des causes, §4). */
  verbose?: boolean;
}

/**
 * Exécute la chaîne complète et renvoie les probabilités publiées.
 * Aucune donnée postérieure au coup d'envoi n'entre ici : le contexte est déjà
 * filtré par `context.ts`.
 */
export function runPipeline(context: MatchContext, options: PipelineOptions = {}): MarketProbabilities {
  const rho = estimateRho(context);
  const ctx: ModelContext = buildModelContext(
    context.home,
    context.away,
    context.leagueBaseline,
    rho,
  );

  // Modèle A : aucune fabrique fournie → modèle xG neutre, inapplicable,
  // poids nul. C'est exactement l'état du moteur lorsque la source ne publie
  // pas de xG.
  const xgPart: ModelPrediction = options.xgVariant ? options.xgVariant(ctx) : (options.xgModel ?? XG_PLACEHOLDER);

  const models: ModelPrediction[] = [
    poissonModel(ctx),
    statisticalModel(ctx),
    xgPart,
    homeAwayModel(ctx),
    formModel(ctx),
  ];

  const ensemble =
    options.xgBaseWeight === undefined
      ? runEnsemble(models)
      : runEnsembleLab(models, { xgBaseWeight: options.xgBaseWeight });
  const lambdas =
    (options.xgBaseWeight === undefined
      ? consensusLambdas(ensemble.models)
      : consensusLambdasLab(ensemble.models)) ?? { home: ctx.lambdaHome, away: ctx.lambdaAway };

  const lambdaHome = clamp(lambdaValue(lambdas.home), 0.12, 5.2);
  const lambdaAway = clamp(lambdaValue(lambdas.away), 0.08, 5.0);

  const matrix = normalizeMatrix(buildScoreMatrix(lambdaHome, lambdaAway, { rho, maxGoals: MAX_GOALS }));
  const btts = bttsProbability(matrix);

  return {
    // `outcomes` = ce que publie le moteur (suit le commutateur §1, pour le
    // contrôle de fidélité). Les deux autres lectures sont toujours fournies,
    // ce qui permet de comparer les sources SANS changer de configuration.
    outcomes: OUTCOME_SOURCE === "matrix" ? outcomeProbabilities(matrix) : ensemble.outcomes,
    consensusOutcomes: ensemble.outcomes,
    totals: TOTAL_LINES.map((line) => {
      const { over, under } = overUnderProbability(matrix, line);
      return { line, over, under };
    }),
    teamGoals: { home: teamGoalsLines(matrix, "home"), away: teamGoalsLines(matrix, "away") },
    btts: { yes: btts.yes, no: btts.no },
    ...buildHalfTimeMarkets(context, lambdaHome, lambdaAway),
    matrix,
    lambdas: { home: lambdaHome, away: lambdaAway },
    agreement: ensemble.agreement,
    activeModels: ensemble.activeModels,
    xgWeight: ensemble.models.find((m) => m.name === "xg")?.weight ?? 0,
    matrixOutcomes: outcomeProbabilities(matrix),
    models: options.verbose
      ? ensemble.models.map((m) => ({
          name: m.name,
          weight: m.weight,
          applicable: m.applicable,
          outcomes: m.outcomes,
          expectedGoals: m.expectedGoals
            ? { home: m.expectedGoals.home, away: m.expectedGoals.away }
            : null,
        }))
      : undefined,
  };
}

/**
 * Modèle xG neutre : inapplicable, poids nul. Utilisé quand l'appelant ne
 * fournit aucun modèle xG — le consensus traite alors la place comme vide,
 * ce qui reproduit le Modèle A.
 */
const XG_PLACEHOLDER: ModelPrediction = {
  name: "xg",
  version: "absent",
  outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
  expectedGoals: null,
  selfConfidence: 0,
  weight: 0,
  applicable: false,
  unavailableReason: "Aucun modèle xG fourni",
  signals: [],
};

/** Distribution complète des scores, pour le score exact (§14, §15). */
export function scoreDistribution(matrix: number[][]): { home: number; away: number; probability: number }[] {
  const out: { home: number; away: number; probability: number }[] = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      out.push({ home: h, away: a, probability: matrix[h][a] });
    }
  }
  return out.sort((x, y) => y.probability - x.probability);
}

/** Somme de la distribution — contrôle de cohérence (§15). Doit valoir 1. */
export function distributionMass(matrix: number[][]): number {
  let total = 0;
  for (const row of matrix) for (const p of row) total += p;
  return total;
}

export { outcomeProbabilities, totalGoalsDistribution };
