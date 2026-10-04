/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Fidélité des variantes et du pipeline
 * ============================================================================
 * Deux exigences :
 *
 *  1. §1 — Les Modèles A et B doivent être LE MÊME moteur. Si la variante
 *     « moteur » ne reproduit pas exactement `xgModel`, alors les variantes ne
 *     sont plus comparables au Modèle A et tout le backtest perd son sens.
 *
 *  2. §16 — Tous les marchés proviennent de la même matrice de scores. Le
 *     pipeline du backtest doit donc produire les probabilités que le moteur
 *     publie réellement, sinon on évaluerait un modèle qui n'existe pas.
 *
 * Note : les xG utilisés ici sont SYNTHÉTIQUES (dérivés des buts) — il s'agit
 * d'un jeu de test, pas d'une donnée de production. Aucun xG réel n'est
 * inventé nulle part ailleurs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePrediction } from "../../../src/server/engine/index";
import { xgModel } from "../../../src/server/engine/models";
import type { MatchContext, MatchRecord, TeamSnapshot } from "../../../src/server/engine/types";
import { buildBacktestContext } from "../context";
import { loadCompetition, type BacktestMatch } from "../dataset";
import { runPipeline } from "../pipeline";
import { VARIANT_BY_ID, MIN_OBSERVATIONS, signalSeries, variantModel } from "../variants";

let cached: BacktestMatch[] | null = null;
async function dataset(): Promise<BacktestMatch[]> {
  if (cached) return cached;
  cached = await loadCompetition("E0", ["2024/2025", "2025/2026"]);
  return cached;
}

function centralMatch(matches: BacktestMatch[]): BacktestMatch {
  const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  return sorted[Math.floor(sorted.length * 0.6)]!;
}

function syntheticXg(record: MatchRecord): MatchRecord {
  return {
    ...record,
    homeXg: Number((record.homeGoals * 0.85 + 0.5).toFixed(3)),
    awayXg: Number((record.awayGoals * 0.85 + 0.4).toFixed(3)),
  };
}

function withXgSnapshot(snapshot: TeamSnapshot): TeamSnapshot {
  const seasonMatches = snapshot.seasonMatches.map(syntheticXg);
  return {
    ...snapshot,
    seasonMatches,
    headToHead: snapshot.headToHead.map(syntheticXg),
    hasXg: true,
  };
}

async function contextWithXg(): Promise<MatchContext> {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);
  return { ...context, home: withXgSnapshot(context.home), away: withXgSnapshot(context.away) };
}

// ---------------------------------------------------------------------------
// 1 — Fidélité de la variante « moteur »
// ---------------------------------------------------------------------------

test("la variante B1 reproduit EXACTEMENT le modèle xG du moteur", async () => {
  const context = await contextWithXg();
  const variant = VARIANT_BY_ID.get("B1_xg_all")!;

  // Le moteur construit son propre contexte interne ; on lui donne le même.
  const { buildModelContext } = await import("../../../src/server/engine/models");
  const { fitDixonColesRho } = await import("../../../src/server/engine/math");

  const fixtures = [...context.home.seasonMatches, ...context.away.seasonMatches].map((m) => ({
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    lambdaHome: context.leagueBaseline.homeGoalsPerMatch,
    lambdaAway: context.leagueBaseline.awayGoalsPerMatch,
  }));
  const rho = fitDixonColesRho(fixtures);
  const ctx = buildModelContext(context.home, context.away, context.leagueBaseline, rho);

  const engine = xgModel(ctx);
  const mine = variantModel(ctx, variant);

  assert.equal(engine.applicable, true, "le modèle xG du moteur devrait être applicable avec des xG");
  assert.equal(mine.applicable, true);
  assert.equal(mine.outcomes.home, engine.outcomes.home);
  assert.equal(mine.outcomes.draw, engine.outcomes.draw);
  assert.equal(mine.outcomes.away, engine.outcomes.away);
  assert.equal(mine.expectedGoals!.home, engine.expectedGoals!.home);
  assert.equal(mine.expectedGoals!.away, engine.expectedGoals!.away);
});

// ---------------------------------------------------------------------------
// 2 — Fenêtres et découpage domicile/extérieur
// ---------------------------------------------------------------------------

test("les fenêtres respectent le nombre de matchs demandé", async () => {
  const context = await contextWithXg();
  for (const [id, expected] of [
    ["B2_xg_5", 5],
    ["B3_xg_10", 10],
    ["B4_xg_20", 20],
  ] as const) {
    const variant = VARIANT_BY_ID.get(id)!;
    const series = signalSeries(context.home, "xg", true, variant, "home");
    assert.ok(series.length <= expected, `${id} : ${series.length} observations pour une fenêtre de ${expected}`);
    if (context.home.seasonMatches.length >= expected) {
      assert.equal(series.length, expected);
    }
  }
});

test("le découpage domicile/extérieur ne retient que les matchs au bon lieu", async () => {
  const context = await contextWithXg();
  const variant = VARIANT_BY_ID.get("B7_xg_home_away")!;
  const teamId = context.home.identity.id;

  const atHome = signalSeries(context.home, "xg", true, variant, "home");
  const expectedAtHome = context.home.seasonMatches.filter((m) => m.homeTeamId === teamId);
  assert.equal(atHome.length, expectedAtHome.length);

  const away = signalSeries(context.away, "xg", true, variant, "away");
  const expectedAway = context.away.seasonMatches.filter((m) => m.awayTeamId === context.away.identity.id);
  assert.equal(away.length, expectedAway.length);
});

// ---------------------------------------------------------------------------
// 3 — Contrôle gratuit : tirs et tirs cadrés
// ---------------------------------------------------------------------------

test("les variantes « tirs » produisent des intensités plausibles (conversion appliquée)", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);
  const { buildModelContext } = await import("../../../src/server/engine/models");

  const ctx = buildModelContext(context.home, context.away, context.leagueBaseline, -0.05);

  for (const id of ["C1_shots_all", "C2_sot_all"]) {
    const model = variantModel(ctx, VARIANT_BY_ID.get(id)!);
    assert.equal(model.applicable, true, `${id} devrait être applicable (tirs disponibles gratuitement)`);
    const total = model.expectedGoals!.total;
    assert.ok(total > 0.5 && total < 6.5, `${id} : total de buts attendu aberrant (${total}) — conversion ratée`);
  }
});

test("la conversion vaut 1 pour le xG — les intensités restent dans l'échelle des buts", async () => {
  const context = await contextWithXg();
  const { buildModelContext } = await import("../../../src/server/engine/models");
  const ctx = buildModelContext(context.home, context.away, context.leagueBaseline, -0.05);
  const model = variantModel(ctx, VARIANT_BY_ID.get("B1_xg_all")!);
  assert.ok(model.expectedGoals!.total > 0.8 && model.expectedGoals!.total < 6);
});

// ---------------------------------------------------------------------------
// 4 — Robustesse aux données insuffisantes
// ---------------------------------------------------------------------------

test("une variante sans assez d'observations est inapplicable, avec poids nul", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);
  const { buildModelContext } = await import("../../../src/server/engine/models");

  // On ampute l'historique sous le seuil minimal.
  const starved = {
    ...context,
    home: {
      ...context.home,
      seasonMatches: context.home.seasonMatches.slice(0, MIN_OBSERVATIONS - 1).map(syntheticXg),
    },
    away: { ...context.away, seasonMatches: context.away.seasonMatches.map(syntheticXg) },
  };
  const ctx = buildModelContext(starved.home, starved.away, starved.leagueBaseline, -0.05);
  const model = variantModel(ctx, VARIANT_BY_ID.get("B1_xg_all")!);
  assert.equal(model.applicable, false);
  assert.equal(model.weight, 0);
});

// ---------------------------------------------------------------------------
// 5 — Fidélité du pipeline complet
// ---------------------------------------------------------------------------

test("le pipeline reproduit les marchés publiés par le moteur", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);

  const engine = generatePrediction(context);
  const pipeline = runPipeline(context);

  const close = (a: number, b: number, label: string) =>
    assert.ok(Math.abs(a - b) < 1e-9, `${label} : moteur ${a} vs pipeline ${b}`);

  close(pipeline.outcomes.home, engine.outcomes.home, "1X2 domicile");
  close(pipeline.outcomes.draw, engine.outcomes.draw, "1X2 nul");
  close(pipeline.outcomes.away, engine.outcomes.away, "1X2 extérieur");

  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const mine = pipeline.totals.find((t) => t.line === line)!;
    const theirs = engine.markets.totalGoals.find((t) => t.line === line)!;
    close(mine.over, theirs.over, `Over ${line}`);
    close(mine.under, theirs.under, `Under ${line}`);
  }

  close(pipeline.btts.yes, engine.markets.bothTeamsToScore.yes, "BTTS oui");

  for (const side of ["home", "away"] as const) {
    for (const line of [0.5, 1.5, 2.5]) {
      const mine = pipeline.teamGoals[side].find((t) => t.line === line)!;
      const theirs = engine.markets.teamGoals[side].overUnder.find((t) => t.line === line)!;
      close(mine.over, theirs.over, `buts ${side} over ${line}`);
    }
  }

  for (const half of ["firstHalf", "secondHalf"] as const) {
    for (const line of [0.5, 1.5, 2.5]) {
      const mine = pipeline[half].overUnder.find((t) => t.line === line)!;
      const theirs = engine.markets.halfTime[half].overUnder.find((t) => t.line === line)!;
      close(mine.over, theirs.over, `${half} over ${line}`);
    }
    close(pipeline[half].expectedGoals, engine.markets.halfTime[half].expectedGoals, `${half} buts attendus`);
  }

  // La matrice est la source unique des marchés (§16).
  close(pipeline.matrix.flat().reduce((a, b) => a + b, 0), 1, "masse de la matrice");
  for (let h = 0; h < 4; h++) {
    for (let a = 0; a < 4; a++) {
      const engineMass = engine.scoreMatrix.flat().reduce((x, y) => x + y, 0);
      close(pipeline.matrix[h]![a]!, engine.scoreMatrix[h]![a]! / engineMass, `score ${h}-${a}`);
    }
  }
});

test("le pipeline n'altère pas le contexte reçu", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);
  const before = JSON.stringify(context.home.seasonMatches.map((m) => m.id));
  runPipeline(context);
  assert.equal(JSON.stringify(context.home.seasonMatches.map((m) => m.id)), before);
});
