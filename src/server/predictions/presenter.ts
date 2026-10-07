/**
 * ============================================================================
 * SOLEIL — Présentateur de prédiction
 * ============================================================================
 * Convertit une ligne `Prediction` de la base en modèle d'affichage.
 * La vue complète ayant été persistée lors de la génération, aucune
 * approximation n'est faite au moment du rendu : l'interface montre
 * exactement ce que le moteur a calculé.
 */

import type {
  Anomaly,
  DataQualityReport,
  ModelSignal,
  PredictionResult,
} from "@/server/engine/types";

export interface ModelOutputPayload {
  name: string;
  /** Libellé lisible. Optionnel : les libellés sont appliqués à la lecture. */
  label?: string;
  applicable: boolean;
  unavailableReason?: string;
  weight: number;
  selfConfidence: number;
  outcomes: { home: number; draw: number; away: number };
  expectedGoals?: { home: number; away: number; total: number } | null;
  signals: ModelSignal[];
}

export interface PredictionView {
  engineVersion: string;
  generatedAt: string;
  publishable: boolean;
  blockingReason?: string;
  outcomes: { home: number; draw: number; away: number };
  consensusPick: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  /** §1 (Phase 15) — origine du 1X2 publié. Absent des prédictions antérieures. */
  outcomeSource?: "matrix" | "consensus";
  /** 1X2 du consensus pondéré, conservé pour l'audit d'écart. */
  consensusOutcomes?: { home: number; draw: number; away: number };
  agreement: number;
  expectedGoals: { home: number; away: number; total: number };
  totalGoals: {
    line: number;
    over: number;
    under: number;
    spread: number;
    confidence: number;
    explanation: string;
  }[];
  teamGoals: {
    teamId: string;
    side: "home" | "away";
    expectedGoals: number;
    distribution: number[];
    overUnder: { line: number; over: number; under: number }[];
  }[];
  halfTime: {
    firstHalf: {
      expectedGoals: number;
      distribution: number[];
      overUnder: { line: number; over: number; under: number }[];
      probAtLeastOneGoal: number;
    };
    secondHalf: {
      expectedGoals: number;
      distribution: number[];
      overUnder: { line: number; over: number; under: number }[];
      probAtLeastOneGoal: number;
    };
  };
  btts: { yes: number; no: number; confidence: number };
  exactScore: {
    mostLikely: { score: string; home: number; away: number; probability: number };
    top: { score: string; home: number; away: number; probability: number }[];
    disclaimer: string;
  };
  goalsDistribution: { goals: number; probability: number }[];
  confidence: {
    score: number;
    grade: string;
    label: string;
    components: Record<string, number>;
    penalties: { code: string; points: number; message: string }[];
  };
  dataQuality: DataQualityReport;
  summary?: string;
  anomalies: Anomaly[];
  explanation: { positive: ModelSignal[]; negative: ModelSignal[]; summary: string };
  derived: {
    homeAttackStrength: number;
    homeDefenseStrength: number;
    homeFormIndex: number;
    awayAttackStrength: number;
    awayDefenseStrength: number;
    awayFormIndex: number;
    homeXgPerMatch: number | null;
    awayXgPerMatch: number | null;
    h2hSample: number;
  };
  models: ModelOutputPayload[];
}

const MODEL_LABELS: Record<string, string> = {
  poisson: "Modèle de Poisson (Dixon–Coles)",
  statistical: "Modèle statistique (distribution empirique)",
  xg: "Modèle Expected Goals",
  form: "Modèle de forme récente",
  home_away: "Modèle domicile / extérieur",
  ml: "Modèle Machine Learning",
  ensemble: "Consensus SOLEIL",
};

export interface MinimalPrediction {
  generatedAt: Date;
  modelVersion: string;
  confidenceScore: number;
  dataQuality: string;
  modelAgreement: number | null;
  matchResult: {
    homeWinProb: number;
    drawProb: number;
    awayWinProb: number;
    consensusPick: string | null;
    factors: unknown;
  } | null;
  totalGoals: {
    expectedGoals: number;
    expectedGoalsHome: number | null;
    expectedGoalsAway: number | null;
    ou05Over: number | null;
    ou05Under: number | null;
    ou15Over: number | null;
    ou15Under: number | null;
    ou25Over: number | null;
    ou25Under: number | null;
    ou35Over: number | null;
    ou35Under: number | null;
    ou45Over: number | null;
    ou45Under: number | null;
    ou05Confidence: number | null;
    ou15Confidence: number | null;
    ou25Confidence: number | null;
    ou35Confidence: number | null;
    ou45Confidence: number | null;
    goalsDistribution: unknown;
  } | null;
  exactScore: {
    mostLikelyScore: string | null;
    mostLikelyProb: number | null;
    topScores: unknown;
  } | null;
  btts: { yesProb: number; noProb: number; confidence: number | null } | null;
  halfTime: {
    htExpectedGoals: number | null;
    ht05Over: number | null;
    ht15Over: number | null;
    ht25Over: number | null;
    stExpectedGoals: number | null;
    st05Over: number | null;
    st15Over: number | null;
    st25Over: number | null;
    probGoalInFirstHalf: number | null;
    probGoalInSecondHalf: number | null;
  } | null;
  teamGoals: {
    teamId: string;
    isHome: boolean;
    expectedGoals: number;
    ou05Over: number | null;
    ou15Over: number | null;
    ou25Over: number | null;
    prob0Goals: number | null;
    prob1Goal: number | null;
    prob2Goals: number | null;
    prob3Goals: number | null;
    prob4PlusGoals: number | null;
  }[];
  modelOutputs: { modelName: string; output: unknown; weight: number; confidence: number | null }[];
}

/**
 * Construit le modèle d'affichage.
 * Si la vue complète n'a pas été persistée (prédictions générées par une
 * version antérieure du moteur), on retombe sur les données disponibles et
 * l'interface affiche « Donnée indisponible » là où l'information manque.
 */
export function toDisplay(prediction: MinimalPrediction | null): PredictionView | null {
  if (!prediction) return null;

  const factors = prediction.matchResult?.factors as { view?: PredictionView } | null;
  const view = factors?.view;

  if (view) {
    return normalizeView({
      ...view,
      models: (view.models ?? buildModelsFromOutputs(prediction)).map((m) => ({
        ...m,
        label: MODEL_LABELS[m.name] ?? m.label ?? m.name,
      })),
    });
  }

  // Prédiction produite par une version antérieure du moteur : on reconstruit
  // ce qui est stocké dans les colonnes relationnelles. Les composantes de
  // qualité de données et les anomalies n'étaient pas persistées à l'époque ;
  // elles sont donc déclarées absentes plutôt que devinées.
  return rebuildFromColumns(prediction);
}

/**
 * Normalise une vue persistée.
 *
 * Les prédictions générées par les premières versions du moteur stockaient la
 * sortie brute de celui-ci, dans laquelle les marchés sont regroupés sous
 * `markets`. On aplatit cette forme ici afin que l'interface n'ait jamais à
 * connaître l'historique des formats de persistance.
 */
function normalizeView(view: PredictionView & { markets?: unknown }): PredictionView {
  const raw = view as unknown as {
    markets?: {
      totalGoals?: PredictionView["totalGoals"];
      teamGoals?: { home: PredictionView["teamGoals"][number]; away: PredictionView["teamGoals"][number] };
      halfTime?: PredictionView["halfTime"];
      bothTeamsToScore?: PredictionView["btts"];
      exactScore?: PredictionView["exactScore"];
      goalsDistribution?: PredictionView["goalsDistribution"];
    };
    consensus?: { agreement?: number };
  };

  if (!raw.markets) return view;

  const m = raw.markets;
  return {
    ...view,
    agreement: view.agreement ?? raw.consensus?.agreement ?? 0,
    totalGoals: m.totalGoals ?? [],
    teamGoals: m.teamGoals ? [m.teamGoals.home, m.teamGoals.away] : [],
    halfTime:
      m.halfTime ?? {
        firstHalf: { expectedGoals: 0, distribution: [], overUnder: [], probAtLeastOneGoal: 0 },
        secondHalf: { expectedGoals: 0, distribution: [], overUnder: [], probAtLeastOneGoal: 0 },
      },
    btts: m.bothTeamsToScore ?? { yes: 0, no: 1, confidence: 0 },
    exactScore: m.exactScore ?? {
      mostLikely: { score: "—", home: 0, away: 0, probability: 0 },
      top: [],
      disclaimer: "",
    },
    goalsDistribution: m.goalsDistribution ?? [],
  };
}

function rebuildFromColumns(prediction: MinimalPrediction): PredictionView | null {
  const mr = prediction.matchResult;
  if (!mr) return null;

  const factors = mr.factors as
    | {
        positive?: ModelSignal[];
        negative?: ModelSignal[];
        derived?: PredictionView["derived"];
        summary?: string;
      }
    | null;

  const tg = prediction.totalGoals;
  const ht = prediction.halfTime;
  const es = prediction.exactScore;

  const lines: number[] = [0.5, 1.5, 2.5, 3.5, 4.5];
  const overOf = (l: number) =>
    ({ 0.5: tg?.ou05Over, 1.5: tg?.ou15Over, 2.5: tg?.ou25Over, 3.5: tg?.ou35Over, 4.5: tg?.ou45Over }[l] ?? null);
  const underOf = (l: number) =>
    ({ 0.5: tg?.ou05Under, 1.5: tg?.ou15Under, 2.5: tg?.ou25Under, 3.5: tg?.ou35Under, 4.5: tg?.ou45Under }[l] ?? null);
  const confOf = (l: number) =>
    ({
      0.5: tg?.ou05Confidence,
      1.5: tg?.ou15Confidence,
      2.5: tg?.ou25Confidence,
      3.5: tg?.ou35Confidence,
      4.5: tg?.ou45Confidence,
    }[l] ?? null);

  const distribution = Array.isArray(tg?.goalsDistribution)
    ? (tg!.goalsDistribution as number[])
    : typeof tg?.goalsDistribution === "object" && tg?.goalsDistribution !== null
      ? Object.entries(tg.goalsDistribution as Record<string, number>)
          .sort(([a], [b]) => (a === "5+" ? 1 : Number(a) - Number(b)))
          .map(([, v]) => v)
      : [];

  const topScores = Array.isArray(es?.topScores)
    ? (es!.topScores as { score: string; home: number; away: number; probability: number }[])
    : [];

  return {
    engineVersion: prediction.modelVersion,
    generatedAt: prediction.generatedAt.toISOString(),
    publishable: true,
    outcomes: { home: mr.homeWinProb, draw: mr.drawProb, away: mr.awayWinProb },
    consensusPick: (mr.consensusPick ?? "HOME_WIN") as PredictionView["consensusPick"],
    agreement: prediction.modelAgreement ?? 0,
    expectedGoals: {
      home: tg?.expectedGoalsHome ?? 0,
      away: tg?.expectedGoalsAway ?? 0,
      total: tg?.expectedGoals ?? 0,
    },
    totalGoals: lines
      .map((line) => {
        const over = overOf(line) ?? 0;
        const under = underOf(line) ?? 1 - over;
        return {
          line,
          over,
          under,
          spread: Math.abs(over - under),
          confidence: confOf(line) ?? 0,
          explanation: "",
        };
      })
      .filter((l) => l.over > 0),
    teamGoals: prediction.teamGoals.map((t) => ({
      teamId: t.teamId,
      side: t.isHome ? ("home" as const) : ("away" as const),
      expectedGoals: t.expectedGoals,
      distribution: [
        t.prob0Goals ?? 0,
        t.prob1Goal ?? 0,
        t.prob2Goals ?? 0,
        t.prob3Goals ?? 0,
        t.prob4PlusGoals ?? 0,
      ],
      overUnder: [
        { line: 0.5, over: t.ou05Over ?? 0, under: 1 - (t.ou05Over ?? 0) },
        { line: 1.5, over: t.ou15Over ?? 0, under: 1 - (t.ou15Over ?? 0) },
        { line: 2.5, over: t.ou25Over ?? 0, under: 1 - (t.ou25Over ?? 0) },
      ],
    })),
    halfTime: {
      firstHalf: {
        expectedGoals: ht?.htExpectedGoals ?? 0,
        distribution: [],
        overUnder: [
          { line: 0.5, over: ht?.ht05Over ?? 0, under: 1 - (ht?.ht05Over ?? 0) },
          { line: 1.5, over: ht?.ht15Over ?? 0, under: 1 - (ht?.ht15Over ?? 0) },
          { line: 2.5, over: ht?.ht25Over ?? 0, under: 1 - (ht?.ht25Over ?? 0) },
        ],
        probAtLeastOneGoal: ht?.probGoalInFirstHalf ?? 0,
      },
      secondHalf: {
        expectedGoals: ht?.stExpectedGoals ?? 0,
        distribution: [],
        overUnder: [
          { line: 0.5, over: ht?.st05Over ?? 0, under: 1 - (ht?.st05Over ?? 0) },
          { line: 1.5, over: ht?.st15Over ?? 0, under: 1 - (ht?.st15Over ?? 0) },
          { line: 2.5, over: ht?.st25Over ?? 0, under: 1 - (ht?.st25Over ?? 0) },
        ],
        probAtLeastOneGoal: ht?.probGoalInSecondHalf ?? 0,
      },
    },
    btts: {
      yes: prediction.btts?.yesProb ?? 0,
      no: prediction.btts?.noProb ?? 1 - (prediction.btts?.yesProb ?? 0),
      confidence: prediction.btts?.confidence ?? 0,
    },
    exactScore: {
      // Mission 23 — le score suggéré est celui persisté par le moteur
      // (sélection « top-k pondérée ») ; le premier du classement ne sert
      // que de repli pour les anciennes prédictions.
      mostLikely:
        topScores.find((s) => s.score === es?.mostLikelyScore) ??
        (es?.mostLikelyScore
          ? {
              score: es.mostLikelyScore,
              home: Number(es.mostLikelyScore.split("-")[0]) || 0,
              away: Number(es.mostLikelyScore.split("-")[1]) || 0,
              probability: es.mostLikelyProb ?? 0,
            }
          : topScores[0] ?? {
              score: "—",
              home: 0,
              away: 0,
              probability: 0,
            }),
      top: topScores,
      disclaimer:
        "Le score exact est intrinsèquement plus incertain que les marchés agrégés. " +
        "Le score le plus probable reste minoritaire : aucune issue n'est certaine.",
    },
    goalsDistribution: distribution.map((probability, goals) => ({
      goals: goals >= 5 ? -1 : goals,
      probability,
    })),
    confidence: {
      score: prediction.confidenceScore,
      grade: "MODEREE",
      label: "Confiance calculée",
      components: {},
      penalties: [],
    },
    dataQuality: {
      score: 0,
      grade: prediction.dataQuality as DataQualityReport["grade"],
      label: prediction.dataQuality,
      components: { volume: 0, recency: 0, richness: 0, sourceDiversity: 0, coverage: 0 },
      sources: [],
      usedFields: [],
      missingFields: [],
    },
    anomalies: [],
    explanation: {
      positive: factors?.positive ?? [],
      negative: factors?.negative ?? [],
      summary: factors?.summary ?? "",
    },
    derived: factors?.derived ?? {
      homeAttackStrength: 0,
      homeDefenseStrength: 0,
      homeFormIndex: 0,
      awayAttackStrength: 0,
      awayDefenseStrength: 0,
      awayFormIndex: 0,
      homeXgPerMatch: null,
      awayXgPerMatch: null,
      h2hSample: 0,
    },
    models: buildModelsFromOutputs(prediction),
  };
}

function buildModelsFromOutputs(prediction: MinimalPrediction): ModelOutputPayload[] {
  return prediction.modelOutputs.map((o) => {
    const payload = o.output as {
      outcomes?: { home: number; draw: number; away: number };
      expectedGoals?: { home: number; away: number; total: number } | null;
      signals?: ModelSignal[];
      applicable?: boolean;
      unavailableReason?: string | null;
      selfConfidence?: number;
    };
    return {
      name: o.modelName,
      label: MODEL_LABELS[o.modelName] ?? o.modelName,
      applicable: payload.applicable !== false,
      unavailableReason: payload.unavailableReason ?? undefined,
      weight: o.weight,
      selfConfidence: payload.selfConfidence ?? o.confidence ?? 0,
      outcomes: payload.outcomes ?? { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: payload.expectedGoals ?? null,
      signals: payload.signals ?? [],
    };
  });
}

/**
 * Sérialise la sortie brute du moteur pour l'affichage.
 *
 * On retire la matrice des scores (121 nombres) pour ne conserver que ce qui
 * est montré à l'utilisateur. Les `Date` sont converties en chaînes ISO pour
 * rester valides en JSON.
 *
 * Cette fonction est l'unique traduction « sortie du moteur → objet affiché ».
 * Elle est utilisée à l'écriture (persistance) comme par les tests de
 * cohérence, afin que ceux-ci portent sur l'objet réellement affiché et non
 * sur une copie qui pourrait diverger.
 */
export function serializeView(result: PredictionResult): PredictionView {
  return {
    engineVersion: result.engineVersion,
    generatedAt: result.generatedAt.toISOString(),
    publishable: result.publishable,
    blockingReason: result.blockingReason,
    outcomes: result.outcomes,
    consensusPick: result.consensusPick,
    outcomeSource: result.outcomeSource,
    consensusOutcomes: result.consensusOutcomes,
    agreement: result.consensus.agreement,
    expectedGoals: result.expectedGoals,
    totalGoals: result.markets.totalGoals,
    teamGoals: [result.markets.teamGoals.home, result.markets.teamGoals.away],
    halfTime: result.markets.halfTime,
    btts: result.markets.bothTeamsToScore,
    exactScore: result.markets.exactScore,
    goalsDistribution: result.markets.goalsDistribution,
    confidence: result.confidence,
    dataQuality: result.dataQuality,
    anomalies: result.anomalies,
    explanation: result.explanation,
    derived: result.derived,
    models: result.consensus.models,
  };
}

export { MODEL_LABELS };
