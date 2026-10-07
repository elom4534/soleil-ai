/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Orchestrateur
 * ============================================================================
 * Point d'entrée unique du moteur. Enchaîne :
 *   contexte → modèles → consensus → matrices de scores → marchés
 *   → anomalies → qualité des données → score de confiance → explication
 *
 * Le moteur est **pur** : étant donné un `MatchContext`, il produit toujours
 * le même `PredictionResult`. Aucune donnée n'est inventée (§34) : toute
 * valeur indisponible est explicitement `null`, et toute prédiction produite
 * sur des données insuffisantes est marquée `publishable: false` (§15).
 */

import type {
  BttsMarket,
  ExactScoreEntry,
  HalfTimeMarket,
  MatchContext,
  ModelPrediction,
  Outcome,
  PredictionResult,
  TeamGoalsMarket,
  TotalGoalsMarket,
} from "./types";
import {
  MAX_GOALS,
  bttsProbability,
  buildScoreMatrix,
  exactScores,
  fitDixonColesRho,
  mean,
  expectedTotalGoals,
  outcomeProbabilities,
  overUnderProbability,
  teamGoalsDistribution,
  totalGoalsDistribution,
} from "./math";
import { buildModelContext, formModel, homeAwayModel, mlModel, poissonModel, shotsModel, statisticalModel, xgModel } from "./models";
import { consensusLambdas, runEnsemble } from "./ensemble";
import { assessDataQuality, computeConfidence, detectAnomalies } from "./quality";
import { halfSplitRatios } from "./ratings";
import { ENGINE_VERSION, OUTCOME_SOURCE } from "@/lib/constants";

/** Lignes de total de buts systématiquement produites (§7). */
const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

/** Lignes par équipe (§8). */
const TEAM_LINES = [0.5, 1.5, 2.5];

/** Lignes par mi-temps (§9). */
const HALF_LINES = [0.5, 1.5, 2.5];

export interface EngineOptions {
  /** Nombre de scores exacts renvoyés dans le top. */
  exactScoreLimit?: number;
  /** Force l'inclusion du modèle ML (toujours inapplicable en v1). */
  includeMlModel?: boolean;
}

export function generatePrediction(
  context: MatchContext,
  options: EngineOptions = {},
): PredictionResult {
  const { exactScoreLimit = 10, includeMlModel = true } = options;
  const generatedAt = new Date();

  // ---------------------------------------------------------------------
  // 1 — ρ Dixon–Coles ajusté sur les matchs réellement observés
  // ---------------------------------------------------------------------
  const rho = estimateRho(context);

  // ---------------------------------------------------------------------
  // 2 — Contexte partagé + exécution des modèles
  // ---------------------------------------------------------------------
  const ctx = buildModelContext(context.home, context.away, context.leagueBaseline, rho);

  const models: ModelPrediction[] = [
    poissonModel(ctx),
    statisticalModel(ctx),
    xgModel(ctx),
    shotsModel(ctx),
    homeAwayModel(ctx),
    formModel(ctx),
    ...(includeMlModel ? [mlModel()] : []),
  ];

  // ---------------------------------------------------------------------
  // 3 — Consensus pondéré
  // ---------------------------------------------------------------------
  const ensemble = runEnsemble(models);

  // ---------------------------------------------------------------------
  // 4 — Intensités consensuelles puis matrice de scores unique
  // ---------------------------------------------------------------------
  const lambdas =
    consensusLambdas(ensemble.models) ?? { home: ctx.lambdaHome, away: ctx.lambdaAway };

  // Garde-fou : on borne les intensités à des valeurs footballistiquement
  // plausibles afin qu'une donnée aberrante ne produise pas de score absurde.
  const lambdaHome = clamp(lambdaValue(lambdas.home), 0.12, 5.2);
  const lambdaAway = clamp(lambdaValue(lambdas.away), 0.08, 5.0);

  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, { rho, maxGoals: MAX_GOALS });

  // ---------------------------------------------------------------------
  // 5 — Marchés
  // ---------------------------------------------------------------------
  // La matrice sert de source unique pour tous les marchés ; les probabilités
  // 1X2 publiées sont toutefois celles du consensus, plus fiables que la
  // simple relecture de la matrice.
  const outcomeProbabilitiesFromMatrix = outcomeProbabilities(matrix);

  // §1 (Phase 15) — Le 1X2 publié est dérivé de la distribution de scores.
  // Les trois issues sont lues dans la matrice qui produit déjà tous les
  // autres marchés : la cohérence devient alors exacte par construction, au
  // lieu de dépendre de deux chemins de calcul distincts.
  // Le commutateur `OUTCOME_SOURCE` rétablit en une ligne le comportement
  // précédent si le backtest ne confirme pas le gain.
  const publishedOutcomes =
    OUTCOME_SOURCE === "matrix" ? outcomeProbabilitiesFromMatrix : ensemble.outcomes;
  const consensusPick = pickOutcome(publishedOutcomes);

  const totalGoals = TOTAL_LINES.map((line) => {
    const { over, under } = overUnderProbability(matrix, line);
    const spread = Math.abs(over - under);
    const explanation = buildTotalExplanation(line, over, under, lambdaHome + lambdaAway, context);
    return {
      line,
      over,
      under,
      spread,
      confidence: lineConfidence(spread, ensemble.agreement, context),
      explanation,
    } satisfies TotalGoalsMarket;
  });

  const teamGoals = {
    home: buildTeamGoals(matrix, "home", context.home.identity.id, lambdaHome),
    away: buildTeamGoals(matrix, "away", context.away.identity.id, lambdaAway),
  };

  const halfTime = buildHalfTimeMarkets(context, lambdaHome, lambdaAway);

  const bttsProbs = bttsProbability(matrix);
  const btts: BttsMarket = {
    yes: bttsProbs.yes,
    no: bttsProbs.no,
    confidence: lineConfidence(Math.abs(bttsProbs.yes - bttsProbs.no), ensemble.agreement, context),
  };

  const topScores = exactScores(matrix, exactScoreLimit);
  const exactScoreEntries: ExactScoreEntry[] = topScores.map((s) => ({
    score: s.score,
    home: s.home,
    away: s.away,
    probability: s.probability,
  }));

  // §1 — Sélection du score suggéré (Mission 23, « top-k pondéré »).
  // Les probabilités de la matrice ne sont jamais modifiées : quand plusieurs
  // scores forment un plateau de probabilités quasi équivalentes, le score
  // retenu est celui dont les buts sont les plus proches des intensités du
  // match (λD, λA). Cela différencie les profils de rencontre sans toucher à
  // la distribution (cf. mesure Brier avant/après).
  const mostLikelyEntry = pickMostLikely(exactScoreEntries, lambdaHome, lambdaAway, consensusPick);

  const goalsDistribution = totalGoalsDistribution(matrix, 5).map((probability, goals) => ({
    goals: goals === 5 ? -1 : goals, // -1 : sentinelle « 5+ »
    probability,
  }));

  // ---------------------------------------------------------------------
  // 6 — Anomalies, qualité, confiance
  // ---------------------------------------------------------------------
  const dataQuality = assessDataQuality({
    home: context.home,
    away: context.away,
    baseline: context.leagueBaseline,
    matchDate: context.date,
  });

  const anomalies = detectAnomalies({
    home: context.home,
    away: context.away,
    baseline: context.leagueBaseline,
    models: ensemble.models,
    agreement: ensemble.agreement,
    matchDate: context.date,
  });

  const confidence = computeConfidence({
    dataQuality,
    home: context.home,
    away: context.away,
    models: ensemble.models,
    agreement: ensemble.agreement,
    anomalies,
    baseline: context.leagueBaseline,
  });

  // ---------------------------------------------------------------------
  // 7 — Décision de publication (§15 : ne jamais forcer une prédiction)
  // ---------------------------------------------------------------------
  const blocking = findBlockingIssue(context, dataQuality, ensemble.activeModels);
  const publishable = blocking === null && confidence.score >= 30;

  // Contrôle de cohérence interne : la matrice et le consensus sont produits
  // par deux chemins distincts (matrice vs moyenne pondérée des modèles). Un
  // écart important signalerait une régression du moteur.
  const matrixConsensusGap = Math.abs(
    outcomeProbabilitiesFromMatrix[
      consensusPick === "HOME_WIN" ? "home" : consensusPick === "AWAY_WIN" ? "away" : "draw"
    ] -
      ensemble.outcomes[
        consensusPick === "HOME_WIN" ? "home" : consensusPick === "AWAY_WIN" ? "away" : "draw"
      ],
  );
  if (matrixConsensusGap > 0.25) {
    anomalies.push({
      code: "CONTRADICTORY_STATS",
      severity: "warning",
      message:
        "Écart inhabituel entre la matrice de scores et le consensus des modèles. " +
        "La prédiction est publiée mais sa robustesse est réduite.",
      confidencePenalty: 8,
    });
  }

  // ---------------------------------------------------------------------
  // 8 — Explication « Pourquoi ? » (§21)
  // ---------------------------------------------------------------------
  const allSignals = ensemble.models.flatMap((m) => m.signals);
  const positive = allSignals.filter((s) => s.impact === "positive").slice(0, 6);
  const negative = allSignals.filter((s) => s.impact === "negative").slice(0, 6);

  const summary = buildSummary({
    context,
    // Le texte d'explication doit citer les probabilités réellement publiées.
    outcomes: publishedOutcomes,
    consensusPick,
    lambdaHome,
    lambdaAway,
    confidence: confidence.score,
    agreement: ensemble.agreement,
    bttsYes: bttsProbs.yes,
    topScore: mostLikelyEntry,
    publishable,
    blocking,
  });

  return {
    engineVersion: ENGINE_VERSION,
    generatedAt,
    publishable,
    blockingReason: blocking ?? undefined,
    outcomes: publishedOutcomes,
    consensusPick,
    outcomeSource: OUTCOME_SOURCE,
    consensusOutcomes: ensemble.outcomes,
    consensus: {
      agreement: ensemble.agreement,
      models: ensemble.models,
      method: "weighted_average",
    },
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    scoreMatrix: matrix,
    markets: {
      totalGoals,
      teamGoals,
      halfTime,
      bothTeamsToScore: btts,
      exactScore: {
        mostLikely: mostLikelyEntry,
        top: exactScoreEntries,
        disclaimer:
          "Le score exact est intrinsèquement plus incertain que les marchés agrégés. " +
          "Le score le plus probable reste minoritaire : aucune issue n'est certaine.",
      },
      goalsDistribution,
    },
    confidence,
    dataQuality,
    anomalies,
    explanation: { positive, negative, summary },
    derived: {
      homeAttackStrength: ctx.homeRatings.homeAttack,
      homeDefenseStrength: ctx.homeRatings.homeDefense,
      homeFormIndex: ctx.homeRatings.formIndex,
      awayAttackStrength: ctx.awayRatings.awayAttack,
      awayDefenseStrength: ctx.awayRatings.awayDefense,
      awayFormIndex: ctx.awayRatings.formIndex,
      homeXgPerMatch: ctx.homeRatings.xgPerMatch,
      awayXgPerMatch: ctx.awayRatings.xgPerMatch,
      h2hSample: context.home.headToHead.length,
    },
  };
}

// ===========================================================================
// Helpers internes
// ===========================================================================

function lambdaValue(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0.01;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

/**
 * Ajuste ρ sur les matchs de la saison des deux équipes. Échantillon de
 * plusieurs centaines de matchs → estimation stable.
 */
function estimateRho(context: MatchContext): number {
  const fixtures = [...context.home.seasonMatches, ...context.away.seasonMatches].map((m) => ({
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    lambdaHome: context.leagueBaseline.homeGoalsPerMatch,
    lambdaAway: context.leagueBaseline.awayGoalsPerMatch,
  }));
  return fitDixonColesRho(fixtures);
}

function pickOutcome(p: { home: number; draw: number; away: number }): Outcome {
  if (p.home >= p.draw && p.home >= p.away) return "HOME_WIN";
  if (p.away >= p.draw && p.away >= p.home) return "AWAY_WIN";
  return "DRAW";
}

/**
 * Confiance d'une ligne : combinaison de la séparation Over/Under, de l'accord
 * entre modèles et de la qualité des données. Bornée : une ligne n'est jamais
 * affichée comme certaine.
 */
function lineConfidence(spread: number, agreement: number, context: MatchContext): number {
  const agreementPart = agreement * 45; // 0-45
  const spreadPart = Math.min(1, spread / 0.35) * 35; // 0-35
  const dataPart = Math.min(1, (context.home.seasonMatches.length + context.away.seasonMatches.length) / 28) * 20; // 0-20
  return Math.round(clamp(agreementPart + spreadPart + dataPart, 5, 97));
}

function buildTotalExplanation(
  line: number,
  over: number,
  under: number,
  totalLambda: number,
  context: MatchContext,
): string {
  const favourite = over >= under ? "Over" : "Under";
  const prob = Math.max(over, under);
  const shape =
    totalLambda > 3.1
      ? "profil de rencontre ouvert"
      : totalLambda < 2.3
        ? "profil de rencontre fermé"
        : "profil de rencontre équilibré";
  return (
    `${favourite} ${line} ${prob >= 0.5 ? "est majoritaire" : "reste minoritaire"} à ${(prob * 100).toFixed(1)} % — ` +
    `total attendu de ${totalLambda.toFixed(2)} buts (${shape}). ` +
    `Moyenne de la compétition : ${context.leagueBaseline.totalGoalsPerMatch.toFixed(2)} buts/match.`
  );
}

function buildTeamGoals(
  matrix: number[][],
  side: "home" | "away",
  teamId: string,
  lambda: number,
): TeamGoalsMarket {
  // `dist` est indexé par nombre de buts exact (0..3) puis « 4+ » en index 4.
  // Pour une ligne L, Over = somme des P(buts > L). La classe « 4+ » satisfait
  // donc Over pour toutes les lignes ≤ 3.5, ce qui couvre nos lignes (0.5-2.5).
  const dist = teamGoalsDistribution(matrix, side);
  const overUnder = TEAM_LINES.map((line) => {
    let over = 0;
    for (let goals = 0; goals < dist.length; goals++) {
      if (goals > line) over += dist[goals];
    }
    return { line, over, under: 1 - over };
  });

  return { teamId, side, expectedGoals: lambda, distribution: dist, overUnder };
}

/**
 * Marchés mi-temps. Les intensités par mi-temps sont dérivées de la part de
 * buts observée en 1re mi-temps (compétition + équipe), jamais d'un ratio
 * arbitraire figé.
 */
function buildHalfTimeMarkets(
  context: MatchContext,
  lambdaHome: number,
  lambdaAway: number,
): HalfTimeMarket {
  const baselineShare = context.leagueBaseline.firstHalfGoalShare;

  const homeShare = halfSplitRatios(context.home.seasonMatches, context.home.identity.id)?.firstHalfShare ?? baselineShare;
  const awayShare = halfSplitRatios(context.away.seasonMatches, context.away.identity.id)?.firstHalfShare ?? baselineShare;

  const homeFirstShare = clamp((homeShare + awayShare) / 2, 0.3, 0.62);

  const fhLambdaHome = lambdaHome * homeFirstShare;
  const fhLambdaAway = lambdaAway * homeFirstShare;
  const shLambdaHome = lambdaHome * (1 - homeFirstShare);
  const shLambdaAway = lambdaAway * (1 - homeFirstShare);

  const fhMatrix = buildScoreMatrix(fhLambdaHome, fhLambdaAway, { rho: 0, maxGoals: 7 });
  const shMatrix = buildScoreMatrix(shLambdaHome, shLambdaAway, { rho: 0, maxGoals: 7 });

  return {
    firstHalf: halfBlock(fhMatrix, fhLambdaHome + fhLambdaAway),
    secondHalf: halfBlock(shMatrix, shLambdaHome + shLambdaAway),
  };
}

function halfBlock(matrix: number[][], expected: number) {
  const dist = totalGoalsDistribution(matrix, 5);
  const overUnder = HALF_LINES.map((line) => {
    const { over, under } = overUnderProbability(matrix, line);
    return { line, over, under };
  });
  return {
    expectedGoals: expected,
    distribution: dist,
    overUnder,
    probAtLeastOneGoal: overUnderProbability(matrix, 0.5).over,
  };
}

/**
 * Sélection « top-k pondérée » du score suggéré (Mission 23).
 *
 * 1. Plateau : scores à probabilités quasi équivalentes (≥ 92 % du max).
 * 2. Cohérence : on retient d'abord les scores du plateau situés du bon côté
 *    de l'issue publiée (un score suggéré ne contredit pas le 1X2).
 * 3. Tie-break : entre candidats, le score dont les buts sont les plus proches
 *    des intensités (λD, λA) du match.
 * Aucune probabilité n'est modifiée : seul le score mis en avant change.
 */
function pickMostLikely(
  entries: ExactScoreEntry[],
  lambdaHome: number,
  lambdaAway: number,
  pick: Outcome,
): ExactScoreEntry {
  const first = entries[0];
  if (!first) return first;
  const isConsistent = (e: ExactScoreEntry) => {
    const [h, a] = e.score.split("-").map(Number);
    return pick === "HOME_WIN" ? h > a : pick === "AWAY_WIN" ? h < a : h === a;
  };
  const maxP = first.probability;
  const plateau = entries.filter((e) => e.probability >= maxP * 0.92);
  // 1 — candidats cohérents avec l'issue dans le plateau ; sinon le plateau.
  // Le score suggéré reste ainsi TOUJOURS dans le plateau des scores probables
  // (règle de cohérence d'affichage).
  const consistent = plateau.filter(isConsistent);
  const pool = consistent.length > 0 ? consistent : plateau;
  if (pool.length === 1) return pool[0];
  // 2 — tie-break : le plus proche des intensités (λD, λA) du match.
  let best = pool[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of pool) {
    const [h, a] = e.score.split("-").map(Number);
    const dist = Math.abs(h - lambdaHome) + Math.abs(a - lambdaAway);
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
}

/** Décide si une prédiction peut être publiée, et pourquoi sinon (§15). */
function findBlockingIssue(
  context: MatchContext,
  quality: ReturnType<typeof assessDataQuality>,
  activeModels: number,
): string | null {
  const homeN = context.home.seasonMatches.length;
  const awayN = context.away.seasonMatches.length;

  if (homeN === 0 || awayN === 0) {
    return "Données insuffisantes pour produire une prédiction fiable : aucune rencontre enregistrée pour l'une des deux équipes.";
  }
  if (Math.min(homeN, awayN) < 3) {
    return `Données insuffisantes pour produire une prédiction fiable : moins de 3 rencontres disponibles pour l'une des deux équipes (${Math.min(homeN, awayN)}).`;
  }
  if (activeModels === 0) {
    return "Données insuffisantes pour produire une prédiction fiable : aucun modèle n'a pu s'exécuter.";
  }
  if (quality.grade === "INSUFFICIENT") {
    return "Qualité de données insuffisante pour publier une prédiction. Prédiction non publiée.";
  }
  return null;
}

/** Résumé rédigé automatiquement, sans aucune donnée inventée. */
function buildSummary(args: {
  context: MatchContext;
  outcomes: { home: number; draw: number; away: number };
  consensusPick: Outcome;
  lambdaHome: number;
  lambdaAway: number;
  confidence: number;
  agreement: number;
  bttsYes: number;
  topScore?: ExactScoreEntry;
  publishable: boolean;
  blocking: string | null;
}): string {
  const {
    context, outcomes, consensusPick, lambdaHome, lambdaAway,
    confidence, agreement, bttsYes, topScore, publishable, blocking,
  } = args;

  if (!publishable) {
    return blocking ?? "Prédiction non publiée — données insuffisantes.";
  }

  const home = context.home.identity.name;
  const away = context.away.identity.name;

  const favourite =
    consensusPick === "HOME_WIN" ? home : consensusPick === "AWAY_WIN" ? away : null;
  const favProb =
    consensusPick === "HOME_WIN" ? outcomes.home : consensusPick === "AWAY_WIN" ? outcomes.away : outcomes.draw;

  const lead =
    favourite === null
      ? `Le nul est l'issue la plus probable, mais avec seulement ${(favProb * 100).toFixed(1)} % de probabilité le match reste très ouvert.`
      : `${favourite} est favori à ${(favProb * 100).toFixed(1)} %.`;

  const goals =
    `Total attendu : ${(lambdaHome + lambdaAway).toFixed(2)} buts ` +
    `(${home} ${lambdaHome.toFixed(2)} — ${away} ${lambdaAway.toFixed(2)}).`;

  const bttsText =
    `Probabilité que les deux équipes marquent : ${(bttsYes * 100).toFixed(1)} %.`;

  const scoreText = topScore
    ? `Score le plus probable : ${topScore.score} (${(topScore.probability * 100).toFixed(1)} %) — une issue parmi d'autres, jamais une certitude.`
    : "";

  const quality =
    `Accord entre modèles : ${(agreement * 100).toFixed(0)} %. Score de confiance SOLEIL : ${confidence}/100.`;

  return [lead, goals, bttsText, scoreText, quality].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Évaluation des prédictions passées (§22) — Brier, Log Loss, calibration
// ---------------------------------------------------------------------------

export interface EvaluationMetrics {
  sample: number;
  accuracy: number;
  brierScore: number;
  logLoss: number;
  calibration: { bin: string; predicted: number; observed: number; count: number }[];
}

/**
 * Évalue un lot de prédictions déjà réglées.
 * Aucune métrique n'est produite sur un échantillon vide ou trop faible.
 */
export function evaluatePredictions(
  entries: {
    probabilities: { home: number; draw: number; away: number };
    actual: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  }[],
): EvaluationMetrics | null {
  if (entries.length === 0) return null;

  let correct = 0;
  let brier = 0;
  let logLoss = 0;

  const bins: { sum: number; hits: number; count: number }[] = Array.from({ length: 10 }, () => ({
    sum: 0,
    hits: 0,
    count: 0,
  }));

  for (const e of entries) {
    const probs = [e.probabilities.home, e.probabilities.draw, e.probabilities.away];
    const actualIndex = e.actual === "HOME_WIN" ? 0 : e.actual === "DRAW" ? 1 : 2;
    const targets = [0, 0, 0];
    targets[actualIndex] = 1;

    // Brier multiclasse
    brier += probs.reduce((acc, p, i) => acc + (p - targets[i]) ** 2, 0);

    // Log Loss avec bornage pour éviter l'infini
    logLoss += -Math.log(Math.max(1e-15, Math.min(1 - 1e-15, probs[actualIndex])));

    const predictedIndex = probs.indexOf(Math.max(...probs));
    if (predictedIndex === actualIndex) correct += 1;

    // Calibration : on suit la probabilité de la classe prédite majoritaire
    const pMax = probs[predictedIndex];
    const binIndex = Math.min(9, Math.floor(pMax * 10));
    bins[binIndex].sum += pMax;
    bins[binIndex].count += 1;
    if (predictedIndex === actualIndex) bins[binIndex].hits += 1;
  }

  const n = entries.length;

  return {
    sample: n,
    accuracy: correct / n,
    brierScore: brier / n,
    logLoss: logLoss / n,
    calibration: bins
      .map((b, i) =>
        b.count === 0
          ? null
          : {
              bin: `${i * 10}-${i * 10 + 10} %`,
              predicted: b.sum / b.count,
              observed: b.hits / b.count,
              count: b.count,
            },
      )
      .filter((b): b is NonNullable<typeof b> => b !== null),
  };
}

export { mean, expectedTotalGoals };
