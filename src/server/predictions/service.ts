/**
 * ============================================================================
 * SOLEIL — Service de prédictions
 * ============================================================================
 * Fait le lien entre le moteur pur et la base de données :
 *   generateAndPersist  → calcule puis écrit une prédiction
 *   settlePredictions   → compare les prédictions passées aux résultats réels
 *   computePerformance  → agrège Brier / Log Loss / calibration (§22)
 *
 * §22 : une prédiction est enregistrée AVANT le coup d'envoi et n'est
 * jamais modifiée rétroactivement — seule sa «settlement» évolue.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generatePrediction, evaluatePredictions } from "@/server/engine";
import { CONFIDENCE_THRESHOLDS, PREDICTOR_VERSION } from "@/lib/constants";
import type { PredictionResult } from "@/server/engine/types";
import { serializeView } from "./presenter";
import { buildMatchContext } from "./context";

export interface GenerateOutcome {
  matchId: string;
  predictionId: string | null;
  status: "published" | "not_publishable" | "skipped";
  confidence: number | null;
  reason?: string;
}

/**
 * Génère (ou régénère) la prédiction d'un match et la persiste.
 *
 * Une prédiction déjà `SETTLED` n'est jamais recalculée : elle appartient à
 * l'historique (§22).
 */
export async function generateAndPersist(
  matchId: string,
  options: { asOf?: Date; force?: boolean } = {},
): Promise<GenerateOutcome> {
  const existing = await prisma.prediction.findFirst({
    where: { matchId, status: { in: ["PUBLISHED", "SETTLED"] } },
    orderBy: { generatedAt: "desc" },
  });

  if (existing?.status === "SETTLED" && !options.force) {
    return {
      matchId,
      predictionId: existing.id,
      status: "skipped",
      confidence: existing.confidenceScore,
      reason: "Prédiction déjà réglée — conservée en l'état (§22).",
    };
  }

  const { context, reason } = await buildMatchContext(matchId, options.asOf);
  if (!context) {
    return { matchId, predictionId: null, status: "skipped", confidence: null, reason };
  }

  const result = generatePrediction(context);
  const predictionId = await persistPrediction(matchId, result);

  const published = result.publishable && result.confidence.score >= CONFIDENCE_THRESHOLDS.MIN_PUBLISHABLE;

  return {
    matchId,
    predictionId,
    status: published ? "published" : "not_publishable",
    confidence: result.confidence.score,
    reason: published ? undefined : result.blockingReason ?? "Confiance insuffisante pour publier.",
  };
}

/** Écrit la prédiction complète en base, dans une transaction unique. */
async function persistPrediction(matchId: string, result: PredictionResult): Promise<string> {
  const published =
    result.publishable && result.confidence.score >= CONFIDENCE_THRESHOLDS.MIN_PUBLISHABLE;

  return prisma.$transaction(async (tx) => {
    // On remplace toute prédiction non réglée antérieure pour ce match.
    await tx.prediction.deleteMany({ where: { matchId, status: { in: ["GENERATED", "PUBLISHED"] } } });

    const prediction = await tx.prediction.create({
      data: {
        matchId,
        // La provenance est écrite dans la ligne elle-même : on peut donc
        // toujours savoir avec quelle source de 1X2 elle a été produite.
        modelVersion: PREDICTOR_VERSION,
        status: published ? "PUBLISHED" : "GENERATED",
        confidenceScore: result.confidence.score,
        dataQuality: result.dataQuality.grade,
        modelAgreement: result.consensus.agreement,
        publishedAt: published ? new Date() : null,

        matchResult: {
          create: {
            homeWinProb: result.outcomes.home,
            drawProb: result.outcomes.draw,
            awayWinProb: result.outcomes.away,
            consensusPick: result.consensusPick,
            consensusConfidence: result.confidence.score / 100,
            ...modelColumns(result),
            factors: {
              // On persiste l'intégralité de la vue du moteur (hors matrice de
              // scores, inutile après coup) : l'interface n'a ainsi jamais à
              // recalculer ni à approximer ce qui a été publié (§22).
              view: serializeView(result) as unknown as Prisma.InputJsonValue,
            },
          },
        },

        totalGoals: {
          create: {
            expectedGoals: result.expectedGoals.total,
            expectedGoalsHome: result.expectedGoals.home,
            expectedGoalsAway: result.expectedGoals.away,
            ou05Over: line(result, 0.5)?.over,
            ou05Under: line(result, 0.5)?.under,
            ou15Over: line(result, 1.5)?.over,
            ou15Under: line(result, 1.5)?.under,
            ou25Over: line(result, 2.5)?.over,
            ou25Under: line(result, 2.5)?.under,
            ou35Over: line(result, 3.5)?.over,
            ou35Under: line(result, 3.5)?.under,
            ou45Over: line(result, 4.5)?.over,
            ou45Under: line(result, 4.5)?.under,
            ou05Confidence: line(result, 0.5)?.confidence,
            ou15Confidence: line(result, 1.5)?.confidence,
            ou25Confidence: line(result, 2.5)?.confidence,
            ou35Confidence: line(result, 3.5)?.confidence,
            ou45Confidence: line(result, 4.5)?.confidence,
            goalsDistribution: Object.fromEntries(
              result.markets.goalsDistribution.map((g) => [g.goals === -1 ? "5+" : g.goals, g.probability]),
            ),
          },
        },

        exactScore: {
          create: {
            topScores: result.markets.exactScore.top as unknown as never,
            mostLikelyScore: result.markets.exactScore.mostLikely.score,
            mostLikelyProb: result.markets.exactScore.mostLikely.probability,
          },
        },

        btts: {
          create: {
            yesProb: result.markets.bothTeamsToScore.yes,
            noProb: result.markets.bothTeamsToScore.no,
            confidence: result.markets.bothTeamsToScore.confidence,
          },
        },

        halfTime: {
          create: {
            ht05Over: halfLine(result, "firstHalf", 0.5)?.over,
            ht05Under: halfLine(result, "firstHalf", 0.5)?.under,
            ht15Over: halfLine(result, "firstHalf", 1.5)?.over,
            ht15Under: halfLine(result, "firstHalf", 1.5)?.under,
            ht25Over: halfLine(result, "firstHalf", 2.5)?.over,
            ht25Under: halfLine(result, "firstHalf", 2.5)?.under,
            htExpectedGoals: result.markets.halfTime.firstHalf.expectedGoals,
            htGoalsDist: result.markets.halfTime.firstHalf.distribution as unknown as never,
            st05Over: halfLine(result, "secondHalf", 0.5)?.over,
            st05Under: halfLine(result, "secondHalf", 0.5)?.under,
            st15Over: halfLine(result, "secondHalf", 1.5)?.over,
            st15Under: halfLine(result, "secondHalf", 1.5)?.under,
            st25Over: halfLine(result, "secondHalf", 2.5)?.over,
            st25Under: halfLine(result, "secondHalf", 2.5)?.under,
            stExpectedGoals: result.markets.halfTime.secondHalf.expectedGoals,
            stGoalsDist: result.markets.halfTime.secondHalf.distribution as unknown as never,
            probGoalInFirstHalf: result.markets.halfTime.firstHalf.probAtLeastOneGoal,
            probGoalInSecondHalf: result.markets.halfTime.secondHalf.probAtLeastOneGoal,
          },
        },

        teamGoals: {
          create: [result.markets.teamGoals.home, result.markets.teamGoals.away].map((tg) => ({
            teamId: tg.teamId,
            isHome: tg.side === "home",
            expectedGoals: tg.expectedGoals,
            ou05Over: tg.overUnder.find((l) => l.line === 0.5)?.over ?? null,
            ou05Under: tg.overUnder.find((l) => l.line === 0.5)?.under ?? null,
            ou15Over: tg.overUnder.find((l) => l.line === 1.5)?.over ?? null,
            ou15Under: tg.overUnder.find((l) => l.line === 1.5)?.under ?? null,
            ou25Over: tg.overUnder.find((l) => l.line === 2.5)?.over ?? null,
            ou25Under: tg.overUnder.find((l) => l.line === 2.5)?.under ?? null,
            prob0Goals: tg.distribution[0],
            prob1Goal: tg.distribution[1],
            prob2Goals: tg.distribution[2],
            prob3Goals: tg.distribution[3],
            prob4PlusGoals: tg.distribution[4],
          })),
        },

        modelOutputs: {
          create: result.consensus.models.map((m) => ({
            modelName: m.name,
            modelVersion: m.version,
            output: {
              outcomes: m.outcomes,
              expectedGoals: m.expectedGoals,
              signals: m.signals,
              applicable: m.applicable,
              unavailableReason: m.unavailableReason ?? null,
              selfConfidence: m.selfConfidence,
            } as unknown as never,
            weight: m.weight,
            confidence: m.selfConfidence,
          })),
        },
      },
    });

    return prediction.id;
  });
}

function line(result: PredictionResult, value: number) {
  return result.markets.totalGoals.find((l) => l.line === value);
}

function halfLine(result: PredictionResult, half: "firstHalf" | "secondHalf", value: number) {
  return result.markets.halfTime[half].overUnder.find((l) => l.line === value);
}

/** Aplatit les sorties modèles dans les colonnes dédiées du schéma. */
function modelColumns(result: PredictionResult) {
  const get = (name: string) => result.consensus.models.find((m) => m.name === name);
  const p = get("poisson");
  const s = get("statistical");
  const x = get("xg");
  const f = get("form");
  const ha = get("home_away");

  return {
    statisticalModelHome: s?.outcomes.home ?? null,
    statisticalModelDraw: s?.outcomes.draw ?? null,
    statisticalModelAway: s?.outcomes.away ?? null,
    poissonModelHome: p?.outcomes.home ?? null,
    poissonModelDraw: p?.outcomes.draw ?? null,
    poissonModelAway: p?.outcomes.away ?? null,
    xgModelHome: x?.applicable ? x.outcomes.home : null,
    xgModelDraw: x?.applicable ? x.outcomes.draw : null,
    xgModelAway: x?.applicable ? x.outcomes.away : null,
    formModelHome: f?.outcomes.home ?? null,
    formModelDraw: f?.outcomes.draw ?? null,
    formModelAway: f?.outcomes.away ?? null,
    homeAwayModelHome: ha?.outcomes.home ?? null,
    homeAwayModelDraw: ha?.outcomes.draw ?? null,
    homeAwayModelAway: ha?.outcomes.away ?? null,
    // Le modèle ML n'est pas entraîné : colonnes laissées nulles (§23/§35).
    mlModelHome: null,
    mlModelDraw: null,
    mlModelAway: null,
    ensembleHome: result.outcomes.home,
    ensembleDraw: result.outcomes.draw,
    ensembleAway: result.outcomes.away,
  };
}

// ---------------------------------------------------------------------------
// §22 — Règlement des prédictions
// ---------------------------------------------------------------------------

export interface SettleResult {
  settled: number;
  correct: number;
  alreadySettled: number;
}

/**
 * Compare les prédictions publiées aux résultats réels des matchs terminés.
 * Ne touche jamais aux probabilités : on écrit uniquement le résultat observé,
 * le verdict et le Brier Score de la ligne 1X2.
 */
export async function settlePredictions(limit = 500): Promise<SettleResult> {
  const pending = await prisma.prediction.findMany({
    where: { status: "PUBLISHED", match: { status: "FINISHED" } },
    include: { match: true, matchResult: true },
    take: limit,
  });

  let settled = 0;
  let correct = 0;
  let alreadySettled = 0;

  for (const prediction of pending) {
    const m = prediction.match;
    if (m.homeScore === null || m.awayScore === null) {
      alreadySettled += 1;
      continue;
    }

    const actual: "HOME_WIN" | "DRAW" | "AWAY_WIN" =
      m.homeScore > m.awayScore ? "HOME_WIN" : m.homeScore < m.awayScore ? "AWAY_WIN" : "DRAW";

    const probs = prediction.matchResult;
    let brier: number | null = null;
    if (probs) {
      const targets = {
        HOME_WIN: [1, 0, 0],
        DRAW: [0, 1, 0],
        AWAY_WIN: [0, 0, 1],
      }[actual];
      const p = [probs.homeWinProb, probs.drawProb, probs.awayWinProb];
      brier = p.reduce((acc, v, i) => acc + (v - targets[i]) ** 2, 0);
    }

    const isCorrect = probs?.consensusPick === actual;
    if (isCorrect) correct += 1;

    await prisma.prediction.update({
      where: { id: prediction.id },
      data: {
        status: "SETTLED",
        actualResult: actual,
        isCorrect,
        brierScore: brier,
      },
    });
    settled += 1;
  }

  return { settled, correct, alreadySettled };
}

// ---------------------------------------------------------------------------
// §22 — SOLEIL PERFORMANCE
// ---------------------------------------------------------------------------

export interface PerformanceReport {
  sample: number;
  accuracy: number;
  brierScore: number;
  logLoss: number;
  calibration: { bin: string; predicted: number; observed: number; count: number }[];
  byConfidence: { band: string; sample: number; accuracy: number }[];
  byMarket: { market: string; sample: number; accuracy: number }[];
  byLeague: { league: string; sample: number; accuracy: number }[];
  byModel: {
    name: string;
    label: string;
    sample: number;
    accuracy: number;
    brierScore: number | null;
    logLoss: number | null;
    applicable: boolean;
  }[];
  /** Date de la prédiction la plus ancienne et la plus récente du lot. */
  window: { from: Date; to: Date } | null;
}

/**
 * Agrège la performance réelle. Retourne `null` si aucune prédiction n'est
 * réglée : SOLEIL n'affiche jamais de statistique de performance vide
 * présentée comme un résultat (§34).
 */
export async function computePerformance(filter: { leagueId?: string } = {}): Promise<PerformanceReport | null> {
  const predictions = await prisma.prediction.findMany({
    where: {
      status: "SETTLED",
      actualResult: { not: null },
      ...(filter.leagueId ? { match: { leagueId: filter.leagueId } } : {}),
    },
    include: {
      match: { include: { league: true } },
      matchResult: true,
      totalGoals: true,
      btts: true,
      modelOutputs: true,
    },
  });

  if (predictions.length === 0) return null;

  const withProbs = predictions.filter((p) => p.matchResult !== null);
  const metrics = evaluatePredictions(
    withProbs.map((p) => ({
      probabilities: {
        home: p.matchResult!.homeWinProb,
        draw: p.matchResult!.drawProb,
        away: p.matchResult!.awayWinProb,
      },
      actual: p.actualResult as "HOME_WIN" | "DRAW" | "AWAY_WIN",
    })),
  );

  // --- Par bande de confiance ---
  const bands = [
    { band: "80-100 (très forte)", min: 80, max: 101 },
    { band: "68-79 (forte)", min: 68, max: 80 },
    { band: "55-67 (modérée)", min: 55, max: 68 },
    { band: "40-54 (faible)", min: 40, max: 55 },
    { band: "0-39 (très faible)", min: 0, max: 40 },
  ];
  const byConfidence = bands
    .map((b) => {
      const subset = predictions.filter(
        (p) => p.confidenceScore >= b.min && p.confidenceScore < b.max,
      );
      return {
        band: b.band,
        sample: subset.length,
        accuracy: subset.length ? subset.filter((p) => p.isCorrect).length / subset.length : 0,
      };
    })
    .filter((b) => b.sample > 0);

  // --- Par marché ---
  const byMarket: PerformanceReport["byMarket"] = [];
  const ou25 = predictions.filter((p) => p.totalGoals?.ou25Over !== undefined);
  if (ou25.length > 0) {
    const hits = ou25.filter((p) => {
      const actualOver = (p.match.homeScore ?? 0) + (p.match.awayScore ?? 0) > 2.5;
      const predictedOver = (p.totalGoals!.ou25Over ?? 0.5) >= 0.5;
      return actualOver === predictedOver;
    }).length;
    byMarket.push({ market: "Total de buts 2.5", sample: ou25.length, accuracy: hits / ou25.length });
  }
  const btts = predictions.filter((p) => p.btts !== null);
  if (btts.length > 0) {
    const hits = btts.filter((p) => {
      const actual = (p.match.homeScore ?? 0) > 0 && (p.match.awayScore ?? 0) > 0;
      return actual === ((p.btts!.yesProb ?? 0.5) >= 0.5);
    }).length;
    byMarket.push({ market: "Les deux équipes marquent", sample: btts.length, accuracy: hits / btts.length });
  }

  // --- Par compétition ---
  const leagueMap = new Map<string, { total: number; hits: number }>();
  for (const p of predictions) {
    const key = p.match.league.name;
    const entry = leagueMap.get(key) ?? { total: 0, hits: 0 };
    entry.total += 1;
    if (p.isCorrect) entry.hits += 1;
    leagueMap.set(key, entry);
  }
  const byLeague = [...leagueMap.entries()]
    .map(([league, v]) => ({ league, sample: v.total, accuracy: v.hits / v.total }))
    .sort((a, b) => b.sample - a.sample)
    .slice(0, 12);

  // --- Par modèle : on évalue chaque modèle sur les mêmes matchs ---
  const MODEL_LABELS: Record<string, string> = {
    poisson: "Poisson",
    statistical: "Statistique",
    xg: "Expected Goals",
    form: "Forme récente",
    home_away: "Domicile / Extérieur",
    ml: "Machine Learning",
    ensemble: "Consensus SOLEIL",
  };
  const modelNames = Object.keys(MODEL_LABELS);
  const byModel = modelNames.map((name) => {
    const entries = predictions
      .map((p) => {
        // Le consensus n'est pas stocké dans `modelOutputs` : il est porté par
        // les probabilités de `matchResult`. On l'évalue donc directement.
        if (name === "ensemble") {
          if (!p.matchResult) return null;
          return {
            probabilities: {
              home: p.matchResult.homeWinProb,
              draw: p.matchResult.drawProb,
              away: p.matchResult.awayWinProb,
            },
            actual: p.actualResult as "HOME_WIN" | "DRAW" | "AWAY_WIN",
          };
        }
        const output = p.modelOutputs.find((o) => o.modelName === name);
        if (!output) return null;
        const payload = output.output as {
          outcomes?: { home: number; draw: number; away: number };
          applicable?: boolean;
        };
        if (!payload?.outcomes || payload.applicable === false) return null;
        return {
          probabilities: payload.outcomes,
          actual: p.actualResult as "HOME_WIN" | "DRAW" | "AWAY_WIN",
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const m = entries.length > 0 ? evaluatePredictions(entries) : null;
    return {
      name,
      label: MODEL_LABELS[name],
      sample: entries.length,
      accuracy: m?.accuracy ?? 0,
      brierScore: m?.brierScore ?? null,
      logLoss: m?.logLoss ?? null,
      applicable: entries.length > 0,
    };
  });

  const dates = predictions.map((p) => p.generatedAt).sort((a, b) => a.getTime() - b.getTime());

  return {
    sample: predictions.length,
    accuracy: metrics?.accuracy ?? 0,
    brierScore: metrics?.brierScore ?? 0,
    logLoss: metrics?.logLoss ?? 0,
    calibration: metrics?.calibration ?? [],
    byConfidence,
    byMarket,
    byLeague,
    byModel,
    window: { from: dates[0], to: dates[dates.length - 1] },
  };
}
