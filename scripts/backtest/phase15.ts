/**
 * ============================================================================
 * SOLEIL — PHASE 15 · Backtest préalable aux changements du moteur
 * ============================================================================
 * §21 — « Ne pas modifier le moteur sans backtest ». Ce script mesure, sur les
 * données locales déjà payées, les deux changements envisagés :
 *
 *   A. 1X2 DÉRIVÉ DE LA DISTRIBUTION DE SCORES (§1)
 *      comparaison appariée, sur les mêmes rencontres :
 *        · 1X2 consensus  = moyenne pondérée des modèles (comportement actuel)
 *        · 1X2 matrice    = lu dans la distribution de scores (candidat)
 *
 *   B. xG SUR LES MARCHÉS DE BUTS (§2)
 *      ablation appariée, marché par marché :
 *        · sans xG        (poids 0, modèle écarté comme s'il était inapplicable)
 *        · avec xG        (modèle xG du moteur, poids 0,20 — configuration en production)
 *
 * Chaque marché a SES PROPRES métriques : le gain sur Over/Under ne prouve rien
 * pour BTTS, pour les buts par équipe ou pour le score exact.
 *
 * 🔒 ZÉRO crédit : uniquement les fichiers locaux.
 * 🔒 Aucune donnée postérieure au coup d'envoi n'est lue (firewall de
 *    `scripts/backtest/context.ts`).
 * 🔒 Le moteur de production n'est pas modifié par ce script.
 *
 * Usage : npx tsx scripts/backtest/phase15.ts
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generatePrediction } from "@/server/engine";
import { xgModel } from "@/server/engine/models";
import type { MatchContext, MatchRecord } from "@/server/engine/types";
import {
  COMPETITIONS,
  applyXg,
  featuresPath,
  loadCompetition,
  type BacktestMatch,
  type XgRecord,
} from "./dataset";
import { buildBacktestContext } from "./context";
import { runPipeline, type MarketProbabilities } from "./pipeline";
import {
  binaryBrierPerMatch,
  binaryMetrics,
  multiclassBrierPerMatch,
  multiclassMetrics,
  pairedBootstrap,
  type BinaryObservation,
  type MulticlassObservation,
} from "./metrics";

// ---------------------------------------------------------------------------
// Périmètre
// ---------------------------------------------------------------------------

const HISTORY_SEASONS = [
  "2015/2016",
  "2016/2017",
  "2017/2018",
  "2018/2019",
  "2019/2020",
  "2020/2021",
  "2021/2022",
  "2022/2023",
  "2023/2024",
  "2024/2025",
  "2025/2026",
];

/** Saisons où la source xG existe : c'est là que l'ablation a un sens. */
const TEST_SEASONS = ["2024/2025", "2025/2026"];

/** Sous-période la plus récente : mesure hors échantillon de référence. */
const OOS_SEASON = "2025/2026";

/** Poids xG en production (BASE_WEIGHTS.xg) — non modifié par cette phase. */
const XG_WEIGHT = 0.2;

const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const TEAM_LINES = [0.5, 1.5, 2.5];

const SEED = 20260930;

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

interface MatchSample {
  id: string;
  season: string;
  competition: string;
  /** Résultat réel — lu après la prédiction, jamais avant. */
  homeGoals: number;
  awayGoals: number;
}

function logLoss(p: number, y: 0 | 1): number {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  return y === 1 ? -Math.log(q) : -Math.log(1 - q);
}

function binaryLogLossPerMatch(obs: BinaryObservation[]): number[] {
  return obs.map((o) => logLoss(o.p, o.y));
}

function multiclassLogLossPerMatch(obs: MulticlassObservation[]): number[] {
  return obs.map((o) => -Math.log(Math.min(Math.max(o.p[o.y] ?? 1e-12, 1e-12), 1)));
}

/** Probabilités par ligne de total, puis par ligne d'équipe. */
function overOf(probs: MarketProbabilities, line: number): number {
  return probs.totals.find((t) => t.line === line)!.over;
}

function teamOverOf(probs: MarketProbabilities, side: "home" | "away", line: number): number {
  return probs.teamGoals[side].find((t) => t.line === line)!.over;
}

/** Log Loss du score exact réalisé, lu dans la matrice. */
function exactScoreLogLoss(probs: MarketProbabilities, home: number, away: number): number {
  const max = Math.min(home, probs.matrix.length - 1);
  const row = probs.matrix[max] ?? [];
  const p = row[Math.min(away, row.length - 1)] ?? 1e-12;
  return -Math.log(Math.min(Math.max(p, 1e-12), 1));
}

function outcomeIndex(home: number, away: number): number {
  return home > away ? 0 : home === away ? 1 : 2;
}

function fmt(x: number, digits = 4): string {
  return x.toFixed(digits);
}

function signed(x: number, digits = 4): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
}

function ci(boot: { lower: number; upper: number }): string {
  return `[${signed(boot.lower)};${signed(boot.upper)}]`;
}

/** ✅ = l'intervalle exclut 0 (dans le bon sens). */
function flag(boot: { lower: number; upper: number }, betterIsLower: boolean): string {
  const excludesZero = betterIsLower ? boot.upper < 0 : boot.lower > 0;
  return excludesZero ? "✅" : "  ";
}

// ---------------------------------------------------------------------------
// Programme
// ---------------------------------------------------------------------------

interface MarketRow {
  market: string;
  n: number;
  brierA: number;
  brierB: number;
  deltaBrier: number;
  ciBrier: [number, number];
  logLossA: number;
  logLossB: number;
  deltaLogLoss: number;
  ciLogLoss: [number, number];
  eceA: number;
  eceB: number;
  probabilityBetter: number;
}

const marketRows: MarketRow[] = [];

function pushBinaryRow(
  label: string,
  obsA: BinaryObservation[],
  obsB: BinaryObservation[],
  out: MarketRow[],
) {
  const a = binaryMetrics(obsA);
  const b = binaryMetrics(obsB);
  const bootBrier = pairedBootstrap(binaryBrierPerMatch(obsA), binaryBrierPerMatch(obsB), { seed: SEED });
  const bootLog = pairedBootstrap(binaryLogLossPerMatch(obsA), binaryLogLossPerMatch(obsB), { seed: SEED });
  out.push({
    market: label,
    n: a.n,
    brierA: a.brier,
    brierB: b.brier,
    deltaBrier: bootBrier.meanDifference,
    ciBrier: [bootBrier.lower, bootBrier.upper],
    logLossA: a.logLoss,
    logLossB: b.logLoss,
    deltaLogLoss: bootLog.meanDifference,
    ciLogLoss: [bootLog.lower, bootLog.upper],
    eceA: a.ece,
    eceB: b.ece,
    probabilityBetter: bootBrier.probabilityBetter,
  });
}

function pushMulticlassRow(
  label: string,
  obsA: MulticlassObservation[],
  obsB: MulticlassObservation[],
  out: MarketRow[],
) {
  const a = multiclassMetrics(obsA);
  const b = multiclassMetrics(obsB);
  const bootBrier = pairedBootstrap(multiclassBrierPerMatch(obsA), multiclassBrierPerMatch(obsB), { seed: SEED });
  const bootLog = pairedBootstrap(multiclassLogLossPerMatch(obsA), multiclassLogLossPerMatch(obsB), { seed: SEED });
  out.push({
    market: label,
    n: a.n,
    brierA: a.brier,
    brierB: b.brier,
    deltaBrier: bootBrier.meanDifference,
    ciBrier: [bootBrier.lower, bootBrier.upper],
    logLossA: a.logLoss,
    logLossB: b.logLoss,
    deltaLogLoss: bootLog.meanDifference,
    ciLogLoss: [bootLog.lower, bootLog.upper],
    eceA: a.ece,
    eceB: b.ece,
    probabilityBetter: bootBrier.probabilityBetter,
  });
}

function printTable(title: string, rows: MarketRow[], aLabel: string, bLabel: string) {
  console.log(`\n${title}`);
  console.log(
    `${"marché".padEnd(20)}${"n".padStart(5)}${aLabel.padStart(11)}${bLabel.padStart(11)}` +
      `${"Δ".padStart(10)}${"IC 95 %".padStart(22)}${"ECE A".padStart(9)}${"ECE B".padStart(9)}`,
  );
  for (const r of rows) {
    const verdict = flag({ lower: r.ciBrier[0], upper: r.ciBrier[1] }, true);
    console.log(
      `${r.market.padEnd(20)}${String(r.n).padStart(5)}${fmt(r.brierA).padStart(11)}${fmt(r.brierB).padStart(11)}` +
        `${signed(r.deltaBrier).padStart(10)}${ci({ lower: r.ciBrier[0], upper: r.ciBrier[1] }).padStart(22)}` +
        `${(r.eceA * 100).toFixed(2).padStart(9)}${(r.eceB * 100).toFixed(2).padStart(9)} ${verdict}`,
    );
  }
}

async function main() {
  console.log("═".repeat(96));
  console.log("SOLEIL — PHASE 15 · backtest préalable (0 crédit, moteur de production non modifié)");
  console.log("═".repeat(96));

  const all: BacktestMatch[] = [];
  const xgLookup = new Map<string, XgRecord>();
  for (const competition of Object.keys(COMPETITIONS)) {
    all.push(...(await loadCompetition(competition, HISTORY_SEASONS)));
    for (const season of HISTORY_SEASONS) {
      const path = featuresPath(competition, season);
      if (!existsSync(path)) continue;
      const payload = JSON.parse(readFileSync(path, "utf8")) as { records: XgRecord[] };
      for (const record of payload.records) xgLookup.set(record.matchId, record);
    }
  }
  applyXg(all, xgLookup);

  const testMatches = all
    .filter((m) => TEST_SEASONS.includes(m.season))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nRencontres chargées : ${all.length} · enregistrements xG : ${xgLookup.size}`);
  console.log(`Périmètre de test   : ${testMatches.length} rencontres (${TEST_SEASONS.join(" + ")})`);

  // -------------------------------------------------------------------------
  // 0 — Fidélité du banc d'essai
  // -------------------------------------------------------------------------
  // Avant de comparer quoi que ce soit, on vérifie que le banc d'essai
  // reproduit EXACTEMENT le moteur de production dans sa configuration
  // actuelle. Sans cette vérification, un écart mesuré pourrait venir du banc
  // d'essai et non du changement étudié.
  const fidelityFixture = testMatches.slice(0, 8);
  let fidelityMax = 0;
  let fidelityChecked = 0;
  for (const match of fidelityFixture) {
    const context = buildBacktestContext(match, all, {
      leagueName: COMPETITIONS[match.competition]!.name,
    });
    const engine = generatePrediction(context);
    const lab = runPipeline(context, {
      xgBaseWeight: XG_WEIGHT,
      xgVariant: (ctx: Parameters<typeof xgModel>[0]) => xgModel(ctx),
    });
    fidelityMax = Math.max(
      fidelityMax,
      Math.abs(engine.consensus.models.find((m) => m.name === "xg")?.weight ?? 0 - lab.xgWeight),
      Math.abs(engine.outcomes.home - lab.outcomes.home),
      Math.abs(engine.outcomes.draw - lab.outcomes.draw),
      Math.abs(engine.outcomes.away - lab.outcomes.away),
    );
    fidelityChecked += 1;
  }
  console.log(
    `\nFidélité du banc d'essai : ${fidelityChecked} rencontres · écart maximal au moteur = ${fidelityMax.toExponential(2)}`,
  );
  if (fidelityMax > 1e-9) {
    console.error("❌ Le banc d'essai ne reproduit pas le moteur : comparaison interrompue.");
    process.exit(1);
  }
  console.log("✅ Le banc d'essai reproduit le moteur en configuration de production.");

  // -------------------------------------------------------------------------
  // 1 — Collecte
  // -------------------------------------------------------------------------
  const samples: { sample: MatchSample; A: MarketProbabilities; B: MarketProbabilities }[] = [];
  const failures: string[] = [];
  let withXg = 0;
  let withoutXg = 0;

  for (const match of testMatches) {
    let context: MatchContext;
    try {
      context = buildBacktestContext(match, all, {
        leagueName: COMPETITIONS[match.competition]!.name,
      });
    } catch (error) {
      failures.push(`${match.id}: ${(error as Error).message}`);
      continue;
    }

    // A — sans xG : le modèle est écarté du consensus, exactement comme
    //     lorsque la source ne publie aucun xG.
    const A = runPipeline(context, { xgBaseWeight: 0 });
    // B — configuration en production : modèle xG du moteur, poids validé.
    const B = runPipeline(context, {
      xgBaseWeight: XG_WEIGHT,
      xgVariant: (ctx: Parameters<typeof xgModel>[0]) => xgModel(ctx),
    });

    if (B.xgWeight > 0) withXg += 1;
    else withoutXg += 1;

    samples.push({
      sample: {
        id: match.id,
        season: match.season,
        competition: match.competition,
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
      },
      A,
      B,
    });
  }

  console.log(`\nRencontres évaluées : ${samples.length} (${failures.length} échec(s))`);
  console.log(`  · avec xG utilisé     : ${withXg}`);
  console.log(`  · sans xG (inapplicable) : ${withoutXg}`);

  const subset = {
    all: samples,
    xgOnly: samples.filter((s) => s.B.xgWeight > 0),
    oos: samples.filter((s) => s.sample.season === OOS_SEASON),
    oosXgOnly: samples.filter((s) => s.sample.season === OOS_SEASON && s.B.xgWeight > 0),
  };

  // -------------------------------------------------------------------------
  // 2 — §1 : 1X2 dérivé de la distribution de scores
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(96));
  console.log("§1 — 1X2 : consensus pondéré contre dérivé de la matrice de scores");
  console.log("     (même configuration de production pour les deux : xG au poids validé)");
  console.log("─".repeat(96));

  const oneXtwo: Record<string, MarketRow[]> = {};
  for (const [key, group] of Object.entries(subset)) {
    // A et B sortent de la MÊME exécution (B, configuration de production) :
    // seule la source du 1X2 change. Aucun effet du xG ne se mélange à la
    // comparaison.
    const obsA: MulticlassObservation[] = group.map(({ sample, B }) => ({
      p: [B.consensusOutcomes.home, B.consensusOutcomes.draw, B.consensusOutcomes.away],
      y: outcomeIndex(sample.homeGoals, sample.awayGoals),
    }));
    const obsB: MulticlassObservation[] = group.map(({ sample, B }) => ({
      p: [B.matrixOutcomes.home, B.matrixOutcomes.draw, B.matrixOutcomes.away],
      y: outcomeIndex(sample.homeGoals, sample.awayGoals),
    }));
    const rows: MarketRow[] = [];
    pushMulticlassRow("1X2 (toutes)", obsA, obsB, rows);
    // Par classe, pour voir où se situe l'écart.
    pushBinaryRow(
      "  · domicile",
      group.map(({ sample, B }) => ({ p: B.consensusOutcomes.home, y: (sample.homeGoals > sample.awayGoals ? 1 : 0) as 0 | 1 })),
      group.map(({ sample, B }) => ({ p: B.matrixOutcomes.home, y: (sample.homeGoals > sample.awayGoals ? 1 : 0) as 0 | 1 })),
      rows,
    );
    pushBinaryRow(
      "  · nul",
      group.map(({ sample, B }) => ({ p: B.consensusOutcomes.draw, y: (sample.homeGoals === sample.awayGoals ? 1 : 0) as 0 | 1 })),
      group.map(({ sample, B }) => ({ p: B.matrixOutcomes.draw, y: (sample.homeGoals === sample.awayGoals ? 1 : 0) as 0 | 1 })),
      rows,
    );
    pushBinaryRow(
      "  · extérieur",
      group.map(({ sample, B }) => ({ p: B.consensusOutcomes.away, y: (sample.homeGoals < sample.awayGoals ? 1 : 0) as 0 | 1 })),
      group.map(({ sample, B }) => ({ p: B.matrixOutcomes.away, y: (sample.homeGoals < sample.awayGoals ? 1 : 0) as 0 | 1 })),
      rows,
    );
    oneXtwo[key] = rows;
    const title =
      key === "all"
        ? `Tout le périmètre (${group.length} rencontres)`
        : key === "xgOnly"
          ? `Sous-ensemble avec xG (${group.length})`
          : key === "oos"
            ? `Hors échantillon ${OOS_SEASON} (${group.length})`
            : `Hors échantillon ${OOS_SEASON} avec xG (${group.length})`;
    printTable(title, rows, "consensus", "matrice");
  }

  // -------------------------------------------------------------------------
  // 3 — §2 : xG sur les marchés de buts, marché par marché
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(96));
  console.log("§2 — xG : marchés de buts, sans xG (A) contre avec xG, poids 0,20 (B)");
  console.log("─".repeat(96));

  const goalMarkets: Record<string, MarketRow[]> = {};
  for (const key of ["xgOnly", "oosXgOnly"] as const) {
    const group = subset[key];
    const rows: MarketRow[] = [];

    if (group.length > 0) {
      // Over/Under — chaque ligne séparément.
      for (const line of TOTAL_LINES) {
        pushBinaryRow(
          `Over ${line}`,
          group.map(({ sample, A }) => ({ p: overOf(A, line), y: (sample.homeGoals + sample.awayGoals > line ? 1 : 0) as 0 | 1 })),
          group.map(({ sample, B }) => ({ p: overOf(B, line), y: (sample.homeGoals + sample.awayGoals > line ? 1 : 0) as 0 | 1 })),
          rows,
        );
      }
      // BTTS.
      pushBinaryRow(
        "BTTS oui",
        group.map(({ sample, A }) => ({ p: A.btts.yes, y: (sample.homeGoals > 0 && sample.awayGoals > 0 ? 1 : 0) as 0 | 1 })),
        group.map(({ sample, B }) => ({ p: B.btts.yes, y: (sample.homeGoals > 0 && sample.awayGoals > 0 ? 1 : 0) as 0 | 1 })),
        rows,
      );
      // Buts par équipe.
      for (const side of ["home", "away"] as const) {
        for (const line of TEAM_LINES) {
          pushBinaryRow(
            `${side === "home" ? "Dom" : "Ext"} > ${line}`,
            group.map(({ sample, A }) => ({ p: teamOverOf(A, side, line), y: ((side === "home" ? sample.homeGoals : sample.awayGoals) > line ? 1 : 0) as 0 | 1 })),
            group.map(({ sample, B }) => ({ p: teamOverOf(B, side, line), y: ((side === "home" ? sample.homeGoals : sample.awayGoals) > line ? 1 : 0) as 0 | 1 })),
            rows,
          );
        }
      }
      // Score exact — Log Loss du score réalisé (la matrice est la seule source).
      const exactA = group.map(({ sample, A }) => exactScoreLogLoss(A, sample.homeGoals, sample.awayGoals));
      const exactB = group.map(({ sample, B }) => exactScoreLogLoss(B, sample.homeGoals, sample.awayGoals));
      const bootExact = pairedBootstrap(exactA, exactB, { seed: SEED });
      rows.push({
        market: "Score exact (LL)",
        n: exactA.length,
        brierA: Number.NaN,
        brierB: Number.NaN,
        deltaBrier: Number.NaN,
        ciBrier: [Number.NaN, Number.NaN],
        logLossA: exactA.reduce((a, b) => a + b, 0) / Math.max(1, exactA.length),
        logLossB: exactB.reduce((a, b) => a + b, 0) / Math.max(1, exactB.length),
        deltaLogLoss: bootExact.meanDifference,
        ciLogLoss: [bootExact.lower, bootExact.upper],
        eceA: Number.NaN,
        eceB: Number.NaN,
        probabilityBetter: bootExact.probabilityBetter,
      });
      // 1X2 — pour situer le changement §1 dans le même tableau.
      pushMulticlassRow(
        "1X2 (matrice)",
        group.map(({ sample, A }) => ({ p: [A.matrixOutcomes.home, A.matrixOutcomes.draw, A.matrixOutcomes.away], y: outcomeIndex(sample.homeGoals, sample.awayGoals) })),
        group.map(({ sample, B }) => ({ p: [B.matrixOutcomes.home, B.matrixOutcomes.draw, B.matrixOutcomes.away], y: outcomeIndex(sample.homeGoals, sample.awayGoals) })),
        rows,
      );
    }

    goalMarkets[key] = rows;
    const title =
      key === "xgOnly"
        ? `Rencontres où le xG est réellement utilisé (${group.length})`
        : `Hors échantillon ${OOS_SEASON}, xG disponible (${group.length})`;
    printTable(title, rows, "sans xG", "avec xG");
    console.log("     « Score exact (LL) » se lit en Log Loss (colonne logLoss) ; le Brier d'un score exact n'est pas comparable aux marchés binaires.");
  }

  // -------------------------------------------------------------------------
  // 4 — Verdicts
  // -------------------------------------------------------------------------
  function verdict(rows: MarketRow[], name: string): string {
    const row = rows.find((r) => r.market === name);
    if (!row) return "absent";
    const established = row.ciBrier[1] < 0 ? "établi" : row.ciBrier[0] > 0 ? "défavorable établi" : "non établi";
    return `${signed(row.deltaBrier)} ${ci({ lower: row.ciBrier[0], upper: row.ciBrier[1] })} → ${established}`;
  }

  const established1x2 = oneXtwo.all!.filter((r) => r.ciBrier[1] < 0).length;
  const degraded1x2 = oneXtwo.all!.filter((r) => r.ciBrier[0] > 0).length;
  const establishedGoals = goalMarkets.xgOnly!.filter(
    (r) => Number.isFinite(r.deltaBrier) && r.ciBrier[1] < 0,
  ).length;
  const degradedGoals = goalMarkets.xgOnly!.filter(
    (r) => Number.isFinite(r.deltaBrier) && r.ciBrier[0] > 0,
  ).length;

  console.log("\n" + "═".repeat(96));
  console.log("VERDICTS");
  console.log("═".repeat(96));
  console.log(`§1 — 1X2 dérivé de la matrice : ${verdict(oneXtwo.all!, "1X2 (toutes)")}`);
  console.log(`     hors échantillon ${OOS_SEASON} : ${verdict(oneXtwo.oos!, "1X2 (toutes)")}`);
  console.log(`     lignes établies : ${established1x2} · lignes dégradées : ${degraded1x2}`);
  console.log(
    `§2 — xG sur les marchés de buts : ${establishedGoals} marché(s) établi(s) · ${degradedGoals} dégradé(s)`,
  );
  for (const line of TOTAL_LINES) {
    console.log(`     Over ${line} : ${verdict(goalMarkets.xgOnly!, `Over ${line}`)}`);
  }
  console.log(`     BTTS oui : ${verdict(goalMarkets.xgOnly!, "BTTS oui")}`);

  // -------------------------------------------------------------------------
  // 5 — Sauvegarde
  // -------------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join("data", "backtests", `${stamp}-phase15`);
  mkdirSync(dir, { recursive: true });
  const payload = {
    phase: 15,
    generatedAt: new Date().toISOString(),
    seed: SEED,
    xgWeight: XG_WEIGHT,
    testSeasons: TEST_SEASONS,
    oosSeason: OOS_SEASON,
    perimeter: { evaluated: samples.length, withXg, withoutXg, failures: failures.length },
    fidelity: { matches: fidelityChecked, maxGap: fidelityMax },
    oneXtwo,
    goalMarkets,
  };
  writeFileSync(join(dir, "resultats.json"), JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(join(dir, "echecs.txt"), failures.join("\n"), "utf8");
  console.log(`\nRésultats écrits dans ${dir}/resultats.json\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
