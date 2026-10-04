/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Variantes du modèle xG
 * ============================================================================
 * §17 — Tester plusieurs variantes, ne garder que celles qui apportent un gain
 * robuste. §3 — fenêtres 5 / 10 / 20. §4 — pondération temporelle.
 *
 * Deux règles de construction :
 *
 *  1. Le modèle « moteur » (fenêtre = toute la saison, moyenne simple, pas de
 *     découpage domicile/extérieur) est reproduit À L'IDENTIQUE. Le test
 *     `variants.test.ts` compare les deux sorties : si elles divergent, les
 *     variantes ne sont plus comparables au Modèle A.
 *
 *  2. Aucune de ces fonctions ne lit le match à prédire : elles ne voient que
 *     `snapshot.seasonMatches`, déjà filtré par le pare-feu temporel.
 */

import { recencyWeightedMean, shrink } from "../../src/server/engine/math";
import { outcomesFromLambdas, type ModelContext } from "../../src/server/engine/models";
import { xgAgainst, xgFor } from "../../src/server/engine/ratings";
import type { MatchRecord, ModelPrediction, ModelSignal, TeamSnapshot } from "../../src/server/engine/types";

export type SignalMetric = "xg" | "shots" | "shotsOnTarget";

export interface SignalVariant {
  id: string;
  label: string;
  metric: SignalMetric;
  /** Nombre de matchs récents utilisés, ou toute la profondeur disponible. */
  window: number | "all";
  /** Demi-vie en matchs pour la pondération temporelle ; `null` = moyenne simple. */
  recencyHalfLife: number | null;
  /** Vrai : le signal d'attaque vient des matchs au même lieu que le match ciblé. */
  homeAwaySplit: boolean;
}

/** Nombre minimal d'observations pour qu'une série soit exploitable (comme le moteur). */
export const MIN_OBSERVATIONS = 3;

/** Bornes du moteur (models.ts `clampLambda`) — reproduites pour rester comparable. */
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 5.5;
/** Constante de shrinkage du modèle xG du moteur. */
const SHRINK_K = 8;

export const VARIANT_VERSION = "phase11-variants-1.0.0";

/** Catalogue évalué. Aucune variante n'est écartée a priori du rapport. */
export const VARIANTS: SignalVariant[] = [
  { id: "B1_xg_all", label: "xG moyen — toute la profondeur (moteur actuel)", metric: "xg", window: "all", recencyHalfLife: null, homeAwaySplit: false },
  { id: "B2_xg_5", label: "xG moyen — 5 derniers matchs", metric: "xg", window: 5, recencyHalfLife: null, homeAwaySplit: false },
  { id: "B3_xg_10", label: "xG moyen — 10 derniers matchs", metric: "xg", window: 10, recencyHalfLife: null, homeAwaySplit: false },
  { id: "B4_xg_20", label: "xG moyen — 20 derniers matchs", metric: "xg", window: 20, recencyHalfLife: null, homeAwaySplit: false },
  { id: "B5_xg_recency_6", label: "xG pondéré par récence (demi-vie 6)", metric: "xg", window: "all", recencyHalfLife: 6, homeAwaySplit: false },
  { id: "B6_xg_recency_3", label: "xG pondéré par récence (demi-vie 3)", metric: "xg", window: "all", recencyHalfLife: 3, homeAwaySplit: false },
  { id: "B7_xg_home_away", label: "xG domicile/extérieur", metric: "xg", window: "all", recencyHalfLife: null, homeAwaySplit: true },
  { id: "B8_xg_recency_home_away", label: "xG domicile/extérieur + récence (demi-vie 6)", metric: "xg", window: "all", recencyHalfLife: 6, homeAwaySplit: true },
  // Contrôle GRATUIT : ces deux variantes n'utilisent aucune donnée payante.
  // Si elles font aussi bien que le xG, le xG n'apporte rien qui justifie son coût.
  { id: "C1_shots_all", label: "Tirs moyens — gratuit (contrôle)", metric: "shots", window: "all", recencyHalfLife: null, homeAwaySplit: false },
  { id: "C2_sot_all", label: "Tirs cadrés moyens — gratuit (contrôle)", metric: "shotsOnTarget", window: "all", recencyHalfLife: null, homeAwaySplit: false },
];

export const VARIANT_BY_ID = new Map(VARIANTS.map((v) => [v.id, v]));

// ---------------------------------------------------------------------------
// Extraction des séries
// ---------------------------------------------------------------------------

function metricValue(
  match: MatchRecord,
  teamId: string,
  metric: SignalMetric,
  attacking: boolean,
): number | null {
  if (metric === "xg") {
    return attacking ? xgFor(match, teamId) : xgAgainst(match, teamId);
  }
  const isHome = match.homeTeamId === teamId;
  if (metric === "shots") {
    return attacking
      ? isHome
        ? match.homeShots
        : match.awayShots
      : isHome
        ? match.awayShots
        : match.homeShots;
  }
  return attacking
    ? isHome
      ? match.homeShotsOnTarget
      : match.awayShotsOnTarget
    : isHome
      ? match.awayShotsOnTarget
      : match.homeShotsOnTarget;
}

function goalsFor(match: MatchRecord, teamId: string): number {
  return match.homeTeamId === teamId ? match.homeGoals : match.awayGoals;
}

/**
 * Série du signal, du plus récent au plus ancien, fenêtrée si demandé.
 * `venue` = lieu de l'équipe DANS le match ciblé (sert au découpage domicile/extérieur).
 */
export function signalSeries(
  snapshot: TeamSnapshot,
  metric: SignalMetric,
  attacking: boolean,
  variant: SignalVariant,
  venue: "home" | "away",
): number[] {
  const teamId = snapshot.identity.id;
  let history = [...snapshot.seasonMatches].sort((a, b) => b.date.getTime() - a.date.getTime());

  if (variant.homeAwaySplit) {
    const atHome = venue === "home";
    history = history.filter((m) => (m.homeTeamId === teamId) === atHome);
  }

  if (variant.window !== "all") history = history.slice(0, variant.window);

  const values: number[] = [];
  for (const match of history) {
    const value = metricValue(match, teamId, metric, attacking);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  return values;
}

function aggregate(values: number[], variant: SignalVariant): number | null {
  if (values.length < MIN_OBSERVATIONS) return null;
  if (variant.recencyHalfLife !== null) return recencyWeightedMean(values, variant.recencyHalfLife);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Facteur de conversion vers l'échelle des buts.
 *
 * xG est déjà à l'échelle des buts (facteur 1). Les tirs et les tirs cadrés ne
 * le sont pas : on les convertit avec le ratio buts/tirs observé sur les
 * mêmes matchs antérieurs. Sans conversion, λ vaudrait ~13 buts par match et
 * serait écrasé par le plafond du moteur — la comparaison serait fausse.
 */
function conversionFactor(ctx: ModelContext, metric: SignalMetric): number {
  if (metric === "xg") return 1;

  let goals = 0;
  let signal = 0;
  const seen = new Set<string>();
  for (const snapshot of [ctx.home, ctx.away]) {
    const teamId = snapshot.identity.id;
    for (const match of snapshot.seasonMatches) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      const value = metricValue(match, teamId, metric, true);
      if (value === null || !Number.isFinite(value)) continue;
      goals += goalsFor(match, teamId);
      signal += value;
    }
  }
  if (signal <= 0) return 0;
  const ratio = goals / signal;
  // Garde-fou : un ratio aberrant sur petit échantillon ne doit pas produire
  // d'intensités absurdes.
  return Math.min(Math.max(ratio, 0.02), 0.6);
}

function clampLambda(value: number): number {
  return Math.min(Math.max(value, LAMBDA_MIN), LAMBDA_MAX);
}

/**
 * Modèle xG paramétré. Avec `VARIANT_BY_ID.get("B1_xg_all")` et un contexte
 * portant des xG, la sortie est identique à `xgModel` du moteur.
 */
export function variantModel(ctx: ModelContext, variant: SignalVariant): ModelPrediction {
  const factor = conversionFactor(ctx, variant.metric);

  const homeAttack = aggregate(signalSeries(ctx.home, variant.metric, true, variant, "home"), variant);
  const homeDefense = aggregate(signalSeries(ctx.home, variant.metric, false, variant, "home"), variant);
  const awayAttack = aggregate(signalSeries(ctx.away, variant.metric, true, variant, "away"), variant);
  const awayDefense = aggregate(signalSeries(ctx.away, variant.metric, false, variant, "away"), variant);

  const counts = {
    homeAttack: signalSeries(ctx.home, variant.metric, true, variant, "home").length,
    homeDefense: signalSeries(ctx.home, variant.metric, false, variant, "home").length,
    awayAttack: signalSeries(ctx.away, variant.metric, true, variant, "away").length,
    awayDefense: signalSeries(ctx.away, variant.metric, false, variant, "away").length,
  };

  if (
    homeAttack === null ||
    homeDefense === null ||
    awayAttack === null ||
    awayDefense === null
  ) {
    return {
      name: "xg",
      version: VARIANT_VERSION,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Données insuffisantes pour cette variante",
      signals: [],
    };
  }

  const baselineAvg = (ctx.baseline.homeGoalsPerMatch + ctx.baseline.awayGoalsPerMatch) / 2;
  const lambdaHome = clampLambda(
    shrink(
      ((homeAttack + awayDefense) / 2) * factor,
      baselineAvg,
      counts.homeAttack + counts.awayDefense,
      SHRINK_K,
    ),
  );
  const lambdaAway = clampLambda(
    shrink(
      ((awayAttack + homeDefense) / 2) * factor,
      baselineAvg,
      counts.awayAttack + counts.homeDefense,
      SHRINK_K,
    ),
  );

  const signals: ModelSignal[] = [
    {
      key: "xg_attack_gap",
      label: `Signal offensif ${ctx.home.identity.name} vs ${ctx.away.identity.name}`,
      value: homeAttack - awayAttack,
      impact: "neutral",
      side: "both",
    },
    {
      key: "xg_defensive_solidity",
      label: `Solidité défensive : ${homeDefense.toFixed(2)} vs ${awayDefense.toFixed(2)}`,
      value: homeDefense - awayDefense,
      impact: "neutral",
      side: "both",
    },
  ];

  return {
    name: "xg",
    version: VARIANT_VERSION,
    outcomes: outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho),
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: Math.min(0.9, 0.5 + (counts.homeAttack + counts.awayAttack) / 60),
    weight: 0,
    applicable: true,
    signals,
  };
}
