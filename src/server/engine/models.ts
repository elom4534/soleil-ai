/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Bibliothèque de modèles
 * ============================================================================
 * Chaque modèle expose le même contrat `ModelPrediction`. Ils sont volontairement
 * complémentaires : aucun ne doit dominer artificiellement l'ensemble (§14).
 *
 * Modèle 1 · Poisson       — intensités issues des ratios attaque/défense
 * Modèle 2 · Statistique   — multinomial empirique sur la distribution des buts
 * Modèle 3 · Expected Goals— Poisson sur intensités xG (si données disponibles)
 * Modèle 4 · Forme         — pondération par dynamique récente
 * Modèle 5 · Domicile/Ext. — poids accru aux performances contextuelles
 */

import type { LeagueBaseline, MatchRecord, ModelName, ModelPrediction, ModelSignal, TeamSnapshot } from "./types";
import { computeTeamRatings, pointsFor, sotAgainst, sotFor, type TeamRatings, xgAgainst, xgFor } from "./ratings";
import { buildScoreMatrix, mean, shrink } from "./math";

export const MODEL_VERSIONS: Record<ModelName, string> = {
  poisson: "1.0.0",
  statistical: "1.0.0",
  xg: "1.0.0",
  shots: "1.0.0",
  form: "1.0.0",
  home_away: "1.0.0",
  ml: "0.0.0-unimplemented",
  ensemble: "1.0.0",
};

/** Contexte interne partagé par tous les modèles (calculé une seule fois). */
export interface ModelContext {
  home: TeamSnapshot;
  away: TeamSnapshot;
  homeRatings: TeamRatings;
  awayRatings: TeamRatings;
  baseline: LeagueBaseline;
  /** λ attendus « neutres » issus du modèle de ratios. */
  lambdaHome: number;
  lambdaAway: number;
  /** ρ Dixon–Coles ajusté sur la compétition. */
  rho: number;
  h2h: MatchRecord[];
}

/** Construit le contexte une seule fois pour éviter les recalculs. */
export function buildModelContext(
  home: TeamSnapshot,
  away: TeamSnapshot,
  baseline: LeagueBaseline,
  rho = -0.05,
): ModelContext {
  const homeRatings = computeTeamRatings(home, baseline);
  const awayRatings = computeTeamRatings(away, baseline);

  // λ_domicile = Attaque_dom(A) × Défense_ext(B) × moyenne buts domicile
  // λ_extérieur = Attaque_ext(B) × Défense_dom(A) × moyenne buts extérieur
  const lambdaHome = clampLambda(
    homeRatings.homeAttack * awayRatings.awayDefense * baseline.homeGoalsPerMatch,
  );
  const lambdaAway = clampLambda(
    awayRatings.awayAttack * homeRatings.homeDefense * baseline.awayGoalsPerMatch,
  );

  return {
    home,
    away,
    homeRatings,
    awayRatings,
    baseline,
    lambdaHome,
    lambdaAway,
    rho,
    h2h: home.headToHead,
  };
}

/** Borne les intensités pour éviter des valeurs absurdes sur petit échantillon. */
function clampLambda(v: number): number {
  return Math.min(Math.max(v, 0.15), 5.5);
}

/** Probabilités 1X2 issues d'une matrice de scores. */
function outcomesFromMatrix(matrix: number[][]) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const t = home + draw + away || 1;
  return { home: home / t, draw: draw / t, away: away / t };
}

/** Transforme des intensités en probabilités 1X2 via Dixon–Coles. */
export function outcomesFromLambdas(lambdaHome: number, lambdaAway: number, rho: number) {
  return outcomesFromMatrix(buildScoreMatrix(lambdaHome, lambdaAway, { rho }));
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

function signal(
  key: string,
  label: string,
  value: number | null,
  impact: ModelSignal["impact"],
  side: ModelSignal["side"],
): ModelSignal {
  return { key, label, value, impact, side };
}

// ---------------------------------------------------------------------------
// MODÈLE 1 — Poisson (ratios attaque/défense)
// ---------------------------------------------------------------------------

export function poissonModel(ctx: ModelContext): ModelPrediction {
  const signals: ModelSignal[] = [];

  if (ctx.homeRatings.sampleSize < 3 || ctx.awayRatings.sampleSize < 3) {
    return {
      name: "poisson",
      version: MODEL_VERSIONS.poisson,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0.1,
      weight: 0,
      applicable: false,
      unavailableReason: "Historique insuffisant (moins de 3 matchs pour une équipe)",
      signals: [
        signal("insufficient_history", "Historique insuffisant pour le modèle de Poisson", null, "negative", "both"),
      ],
    };
  }

  const outcomes = outcomesFromLambdas(ctx.lambdaHome, ctx.lambdaAway, ctx.rho);

  const attackGap = ctx.homeRatings.homeAttack - ctx.awayRatings.awayAttack;
  const defenseGap = ctx.awayRatings.awayDefense - ctx.homeRatings.homeDefense;

  signals.push(
    signal(
      "home_attack_superiority",
      `Force offensive domicile de ${ctx.home.identity.name} (${ctx.homeRatings.homeAttack.toFixed(2)}×)`,
      ctx.homeRatings.homeAttack,
      attackGap > 0.08 ? "positive" : attackGap < -0.08 ? "negative" : "neutral",
      "home",
    ),
    signal(
      "away_defense_fragility",
      `Défense extérieure de ${ctx.away.identity.name} (${ctx.awayRatings.awayDefense.toFixed(2)}×)`,
      ctx.awayRatings.awayDefense,
      defenseGap > 0.08 ? "positive" : "neutral",
      "home",
    ),
    signal(
      "expected_total_goals",
      `Total de buts attendu : ${(ctx.lambdaHome + ctx.lambdaAway).toFixed(2)}`,
      ctx.lambdaHome + ctx.lambdaAway,
      "neutral",
      "total",
    ),
  );

  const total = ctx.lambdaHome + ctx.lambdaAway;
  const selfConfidence = Math.min(
    0.92,
    Math.max(
      0.2,
      0.45 +
        Math.min(ctx.homeRatings.sampleSize, 15) / 60 +
        Math.min(ctx.awayRatings.sampleSize, 15) / 60,
    ),
  );

  return {
    name: "poisson",
    version: MODEL_VERSIONS.poisson,
    outcomes,
    expectedGoals: { home: ctx.lambdaHome, away: ctx.lambdaAway, total },
    selfConfidence,
    weight: 0,
    applicable: true,
    signals,
  };
}

// ---------------------------------------------------------------------------
// MODÈLE 2 — Statistique (distribution empirique des buts)
// ---------------------------------------------------------------------------

/**
 * Contrairement à Poisson qui suppose une intensité constante, ce modèle
 * s'appuie sur la distribution empirique observée des buts marqués/encaissés.
 * Il capture la sur-dispersion (équipes capables de 0 comme de 4 buts).
 */
export function statisticalModel(ctx: ModelContext): ModelPrediction {
  const signals: ModelSignal[] = [];
  const homeSamples = ctx.home.seasonMatches.length;
  const awaySamples = ctx.away.seasonMatches.length;

  if (homeSamples < 4 || awaySamples < 4) {
    return {
      name: "statistical",
      version: MODEL_VERSIONS.statistical,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0.1,
      weight: 0,
      applicable: false,
      unavailableReason: "Moins de 4 matchs disponibles pour construire une distribution fiable",
      signals: [
        signal("small_sample", "Échantillon trop réduit pour une distribution empirique fiable", null, "negative", "both"),
      ],
    };
  }

  // Moyennes empiriques pondérées vers la référence de la compétition.
  const homeGoalsFor = mean(ctx.home.seasonMatches.map((m) => (m.homeTeamId === ctx.home.identity.id ? m.homeGoals : m.awayGoals))) ?? 0;
  const homeGoalsAgainst = mean(ctx.home.seasonMatches.map((m) => (m.homeTeamId === ctx.home.identity.id ? m.awayGoals : m.homeGoals))) ?? 0;
  const awayGoalsFor = mean(ctx.away.seasonMatches.map((m) => (m.awayTeamId === ctx.away.identity.id ? m.awayGoals : m.homeGoals))) ?? 0;
  const awayGoalsAgainst = mean(ctx.away.seasonMatches.map((m) => (m.awayTeamId === ctx.away.identity.id ? m.homeGoals : m.awayGoals))) ?? 0;

  const lambdaHome = clampLambda(
    shrink((homeGoalsFor + awayGoalsAgainst) / 2, ctx.baseline.homeGoalsPerMatch, homeSamples + awaySamples, 8),
  );
  const lambdaAway = clampLambda(
    shrink((awayGoalsFor + homeGoalsAgainst) / 2, ctx.baseline.awayGoalsPerMatch, homeSamples + awaySamples, 8),
  );

  const outcomes = outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho);

  // Écart entre les deux intensités → signal de domination
  const gap = lambdaHome - lambdaAway;
  signals.push(
    signal(
      "empirical_goal_gap",
      `Écart de buts attendus en faveur de ${gap >= 0 ? ctx.home.identity.name : ctx.away.identity.name} (${Math.abs(gap).toFixed(2)})`,
      gap,
      Math.abs(gap) < 0.15 ? "neutral" : gap > 0 ? "positive" : "negative",
      gap >= 0 ? "home" : "away",
    ),
    signal(
      "empirical_btts_rate",
      `Taux « les deux équipes marquent » observé : ${(
        ((ctx.homeRatings.bttsRate ?? 0) + (ctx.awayRatings.bttsRate ?? 0)) / 2 * 100
      ).toFixed(0)}%`,
      ((ctx.homeRatings.bttsRate ?? 0) + (ctx.awayRatings.bttsRate ?? 0)) / 2,
      "neutral",
      "both",
    ),
  );

  return {
    name: "statistical",
    version: MODEL_VERSIONS.statistical,
    outcomes,
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: Math.min(0.85, 0.35 + (homeSamples + awaySamples) / 80),
    weight: 0,
    applicable: true,
    signals,
  };
}

// ---------------------------------------------------------------------------
// MODÈLE 3 — Expected Goals
// ---------------------------------------------------------------------------

/**
 * N'est applicable que si les sources fournissent réellement des xG (§34 :
 * jamais de statistique inventée). Sinon, le modèle est marqué inapplicable
 * et son poids est nul — il ne fausse donc pas l'ensemble.
 */
export function xgModel(ctx: ModelContext): ModelPrediction {
  const homeXg = collectXg(ctx.home, true);
  const awayXg = collectXg(ctx.away, true);
  const homeXga = collectXg(ctx.home, false);
  const awayXga = collectXg(ctx.away, false);

  if (homeXg.length < 3 || awayXg.length < 3 || homeXga.length < 3 || awayXga.length < 3) {
    return {
      name: "xg",
      version: MODEL_VERSIONS.xg,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Données xG indisponibles pour cette rencontre",
      signals: [
        signal("xg_unavailable", "xG indisponibles — modèle exclu du consensus", null, "negative", "both"),
      ],
    };
  }

  const homeAttackXg = mean(homeXg)!;
  const homeDefenseXga = mean(homeXga)!;
  const awayAttackXg = mean(awayXg)!;
  const awayDefenseXga = mean(awayXga)!;

  // Les xG sont calibrés sur la moyenne de buts de la compétition afin de
  // rester comparables aux autres modèles.
  const baselineAvg = (ctx.baseline.homeGoalsPerMatch + ctx.baseline.awayGoalsPerMatch) / 2;
  const lambdaHome = clampLambda(shrink((homeAttackXg + awayDefenseXga) / 2, baselineAvg, homeXg.length + awayXga.length, 8));
  const lambdaAway = clampLambda(shrink((awayAttackXg + homeDefenseXga) / 2, baselineAvg, awayXg.length + homeXga.length, 8));

  const outcomes = outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho);

  const finishingGap = homeAttackXg - awayAttackXg;
  const signals: ModelSignal[] = [
    signal(
      "xg_attack_gap",
      `xG moyens : ${ctx.home.identity.name} ${homeAttackXg.toFixed(2)} vs ${ctx.away.identity.name} ${awayAttackXg.toFixed(2)}`,
      finishingGap,
      Math.abs(finishingGap) < 0.15 ? "neutral" : finishingGap > 0 ? "positive" : "negative",
      finishingGap >= 0 ? "home" : "away",
    ),
    signal(
      "xg_defensive_solidity",
      `xGA moyens : ${ctx.home.identity.name} ${homeDefenseXga.toFixed(2)} vs ${ctx.away.identity.name} ${awayDefenseXga.toFixed(2)}`,
      homeDefenseXga - awayDefenseXga,
      "neutral",
      "both",
    ),
  ];

  return {
    name: "xg",
    version: MODEL_VERSIONS.xg,
    outcomes,
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: Math.min(0.9, 0.5 + (homeXg.length + awayXg.length) / 60),
    weight: 0,
    applicable: true,
    signals,
  };
}

function collectXg(snapshot: TeamSnapshot, attacking: boolean): number[] {
  const teamId = snapshot.identity.id;
  const values: number[] = [];
  for (const m of snapshot.seasonMatches) {
    const v = attacking ? xgFor(m, teamId) : xgAgainst(m, teamId);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  return values;
}

// ---------------------------------------------------------------------------
// MODÈLE 3bis — Qualité de tir (tirs cadrés) — Mission 23
// ---------------------------------------------------------------------------

/**
 * Proxy « expected goals » basé sur les tirs cadrés, pour les compétitions où
 * les xG ne sont pas fournis. Valeur mesurée avant implémentation :
 * corr(SOT, buts) ≈ 0,58 · R² ≈ 0,33 sur 20 000 matchs. Le taux de conversion
 * est observé sur les matchs réellement exploités — jamais une constante.
 * Complémentaire au modèle xg : les deux peuvent coexister, l'ensemble arbitre.
 */
export function shotsModel(ctx: ModelContext): ModelPrediction {
  const homeSotFor = collectSot(ctx.home, true);
  const awaySotFor = collectSot(ctx.away, true);
  const homeSotAgainst = collectSot(ctx.home, false);
  const awaySotAgainst = collectSot(ctx.away, false);

  if (
    homeSotFor.length < 3 ||
    awaySotFor.length < 3 ||
    homeSotAgainst.length < 3 ||
    awaySotAgainst.length < 3
  ) {
    return {
      name: "shots",
      version: MODEL_VERSIONS.shots,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Tirs cadrés insuffisants pour évaluer la qualité de tir",
      signals: [signal("shots_unavailable", "Tirs cadrés indisponibles — modèle exclu du consensus", null, "negative", "both")],
    };
  }

  // Taux de conversion SOT → buts observé sur l'historique exploité du contexte.
  const allMatches = [...ctx.home.seasonMatches, ...ctx.away.seasonMatches];
  let goals = 0;
  let sots = 0;
  for (const m of allMatches) {
    const sot = (m.homeShotsOnTarget ?? 0) + (m.awayShotsOnTarget ?? 0);
    if (sot > 0) {
      goals += m.homeGoals + m.awayGoals;
      sots += sot;
    }
  }
  if (sots <= 0 || goals <= 0) {
    return {
      name: "shots",
      version: MODEL_VERSIONS.shots,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Taux de conversion tirs cadrés non observable sur cet historique",
      signals: [signal("shots_conversion_unavailable", "Conversion tirs cadrés non observable", null, "negative", "both")],
    };
  }
  const conversion = goals / sots;

  const homeSotAvg = mean(homeSotFor)!;
  const awaySotAvg = mean(awaySotFor)!;
  const homeSotAgainstAvg = mean(homeSotAgainst)!;
  const awaySotAgainstAvg = mean(awaySotAgainst)!;

  // Méthode des ratios (identique en esprit au modèle xg) : l'attaque attendue
  // combine les tirs cadrés produits et ceux concédés par l'adversaire, puis
  // est convertie en buts par le taux observé et shrinkée vers la compétition.
  const baselineAvg = (ctx.baseline.homeGoalsPerMatch + ctx.baseline.awayGoalsPerMatch) / 2;
  const lambdaHome = clampLambda(
    shrink(((homeSotAvg + awaySotAgainstAvg) / 2) * conversion, baselineAvg, homeSotFor.length + awaySotAgainst.length, 8),
  );
  const lambdaAway = clampLambda(
    shrink(((awaySotAvg + homeSotAgainstAvg) / 2) * conversion, baselineAvg, awaySotFor.length + homeSotAgainst.length, 8),
  );

  const outcomes = outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho);
  const sotGap = homeSotAvg - awaySotAvg;

  const signals: ModelSignal[] = [
    signal(
      "sot_gap",
      `Tirs cadrés moyens : ${ctx.home.identity.name} ${homeSotAvg.toFixed(1)} vs ${ctx.away.identity.name} ${awaySotAvg.toFixed(1)}`,
      sotGap,
      Math.abs(sotGap) < 0.5 ? "neutral" : sotGap > 0 ? "positive" : "negative",
      sotGap >= 0 ? "home" : "away",
    ),
    signal(
      "sot_conversion",
      `Conversion tirs cadrés observée : ${(conversion * 100).toFixed(0)} %`,
      conversion,
      "neutral",
      "both",
    ),
  ];

  return {
    name: "shots",
    version: MODEL_VERSIONS.shots,
    outcomes,
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: Math.min(0.85, 0.45 + (homeSotFor.length + awaySotFor.length) / 60),
    weight: 0,
    applicable: true,
    signals,
  };
}

function collectSot(snapshot: TeamSnapshot, attacking: boolean): number[] {
  const teamId = snapshot.identity.id;
  const values: number[] = [];
  for (const m of snapshot.seasonMatches) {
    const v = attacking ? sotFor(m, teamId) : sotAgainst(m, teamId);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  return values;
}

// ---------------------------------------------------------------------------
// MODÈLE 4 — Forme récente
// ---------------------------------------------------------------------------

/**
 * Traduit la dynamique récente en probabilités. Ce modèle est volontairement
 * peu confiant en absolu : il est utile en complément, pas en pilote.
 */
export function formModel(ctx: ModelContext): ModelPrediction {
  const homeRecent = ctx.home.seasonMatches.slice(0, 6);
  const awayRecent = ctx.away.seasonMatches.slice(0, 6);
  const signals: ModelSignal[] = [];

  if (homeRecent.length < 3 || awayRecent.length < 3) {
    return {
      name: "form",
      version: MODEL_VERSIONS.form,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Moins de 3 matchs récents pour évaluer la forme",
      signals: [signal("form_unavailable", "Forme récente non évaluable", null, "negative", "both")],
    };
  }

  const homePpg = mean(homeRecent.map((m) => pointsFor(m, ctx.home.identity.id)))!;
  const awayPpg = mean(awayRecent.map((m) => pointsFor(m, ctx.away.identity.id)))!;

  // Les points par match sont convertis en « force » relative puis en buts
  // attendus via la moyenne de la compétition.
  const homeStrength = 0.65 + (homePpg / 3) * 0.7; // 0.65 → 1.35
  const awayStrength = 0.65 + (awayPpg / 3) * 0.7;

  const lambdaHome = clampLambda(ctx.baseline.homeGoalsPerMatch * homeStrength * (2 - awayStrength) * 0.85 + 0.12);
  const lambdaAway = clampLambda(ctx.baseline.awayGoalsPerMatch * awayStrength * (2 - homeStrength) * 0.85 + 0.12);

  const outcomes = outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho);
  const gap = homePpg - awayPpg;

  signals.push(
    signal(
      "form_gap",
      `Forme sur 6 matchs : ${ctx.home.identity.name} ${homePpg.toFixed(1)} pt/match vs ${ctx.away.identity.name} ${awayPpg.toFixed(1)} pt/match`,
      gap,
      Math.abs(gap) < 0.4 ? "neutral" : gap > 0 ? "positive" : "negative",
      gap >= 0 ? "home" : "away",
    ),
  );

  return {
    name: "form",
    version: MODEL_VERSIONS.form,
    outcomes,
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: 0.42 + Math.min(0.2, (homeRecent.length + awayRecent.length) / 60),
    weight: 0,
    applicable: true,
    signals,
  };
}

// ---------------------------------------------------------------------------
// MODÈLE 5 — Domicile / Extérieur
// ---------------------------------------------------------------------------

/**
 * Isole l'avantage du terrain. Ce modèle est le plus pertinent quand les
 * équipes ont un profil fortement asymétrique domicile/extérieur.
 */
export function homeAwayModel(ctx: ModelContext): ModelPrediction {
  const signals: ModelSignal[] = [];
  const homeH = ctx.homeRatings.homeSampleSize;
  const awayA = ctx.awayRatings.awaySampleSize;

  if (homeH < 3 || awayA < 3) {
    return {
      name: "home_away",
      version: MODEL_VERSIONS.home_away,
      outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null,
      selfConfidence: 0,
      weight: 0,
      applicable: false,
      unavailableReason: "Échantillon domicile/extérieur trop faible",
      signals: [signal("venue_sample_low", "Peu de matchs dans le contexte domicile/extérieur", null, "negative", "both")],
    };
  }

  const lambdaHome = clampLambda(ctx.homeRatings.homeAttack * ctx.awayRatings.awayDefense * ctx.baseline.homeGoalsPerMatch);
  const lambdaAway = clampLambda(ctx.awayRatings.awayAttack * ctx.homeRatings.homeDefense * ctx.baseline.awayGoalsPerMatch);
  const outcomes = outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho);

  // Asymétrie : écart entre la performance globale et la performance contextuelle.
  const homeBias = ctx.homeRatings.homeAttack - ctx.homeRatings.attack;
  const awayBias = ctx.awayRatings.awayDefense - ctx.awayRatings.defense;

  signals.push(
    signal(
      "home_venue_advantage",
      `${ctx.home.identity.name} marque ${ctx.homeRatings.homeAttack.toFixed(2)}× la moyenne à domicile`,
      homeBias,
      homeBias > 0.1 ? "positive" : homeBias < -0.1 ? "negative" : "neutral",
      "home",
    ),
    signal(
      "away_travel_weakness",
      `${ctx.away.identity.name} encaisse ${ctx.awayRatings.awayDefense.toFixed(2)}× la moyenne à l'extérieur`,
      awayBias,
      awayBias > 0.1 ? "negative" : "neutral",
      "away",
    ),
  );

  return {
    name: "home_away",
    version: MODEL_VERSIONS.home_away,
    outcomes,
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: 0.55 + Math.min(0.2, (homeH + awayA) / 80),
    weight: 0,
    applicable: true,
    signals,
  };
}

// ---------------------------------------------------------------------------
// Modèle Machine Learning — non implémenté, déclaré honnêtement (§23, §35)
// ---------------------------------------------------------------------------

/**
 * SOLEIL n'entraîne PAS de modèle ML dans cette version. Le slot existe pour
 * permettre un branchement ultérieur sans refonte, et il est explicitement
 * marqué comme non applicable afin qu'aucune métrique ne soit simulée.
 */
export function mlModel(): ModelPrediction {
  return {
    name: "ml",
    version: MODEL_VERSIONS.ml,
    outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
    expectedGoals: null,
    selfConfidence: 0,
    weight: 0,
    applicable: false,
    unavailableReason: "Modèle ML non entraîné dans cette version du moteur",
    signals: [
      signal(
        "ml_not_trained",
        "Modèle ML : non disponible (architecture prête, entraînement non réalisé)",
        null,
        "neutral",
        "both",
      ),
    ],
  };
}
