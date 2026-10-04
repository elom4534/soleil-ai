/**
 * ============================================================================
 * SOLEIL — PHASE 12 · Architecture hybride buts + 1X2
 * ============================================================================
 * Question posée : « comment utiliser une information utile pour les buts sans
 * dégrader le 1X2 ? »
 *
 * §16 — ZÉRO appel API : ce script ne lit que le cache, les fichiers et les
 * 460 rencontres déjà enrichies. Aucun crédit n'est engagé.
 * §1  — Le moteur de production n'est pas modifié : le banc d'essai
 * (`ensemble-lab.ts`) n'est activé que si l'appelant fournit un poids.
 *
 * Chaque rencontre produit un instantané compact, à partir duquel TOUTES les
 * analyses sont recalculées — y compris sur des sous-ensembles. Aucune matrice
 * n'est stockée : les indicateurs du score exact sont réduits par rencontre.
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { xgModel } from "../../src/server/engine/models";
import type { MatchContext, MatchRecord, TeamSnapshot } from "../../src/server/engine/types";
import {
  COMPETITIONS,
  applyXg,
  featuresPath,
  loadCompetition,
  type BacktestMatch,
  type XgRecord,
} from "./dataset";
import { buildBacktestContext } from "./context";
import { distributionMass, runPipeline } from "./pipeline";
import { VARIANT_BY_ID, variantModel, type SignalVariant } from "./variants";
import {
  binaryBrierPerMatch,
  binaryMetrics,
  multiclassBrierPerMatch,
  multiclassMetrics,
  pairedBootstrap,
  type BinaryObservation,
  type MarketMetrics,
  type MulticlassObservation,
} from "./metrics";
import {
  fitTemperature,
  fitVector,
  multiclassBrier,
  multiclassLogLoss,
  perClassBrier,
  temperatureApply,
  vectorApply,
  type CalibrationObservation,
} from "./calibration";

// ---------------------------------------------------------------------------
// Périmètre — identique à la phase 11, aucune donnée nouvelle
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
const TEST_SEASONS = ["2023/2024", "2024/2025", "2025/2026"];
const FIT_SEASONS = ["2023/2024", "2024/2025"];
const VALIDATION_SEASON = "2025/2026";

const WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4];
const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const TEAM_LINES = [0.5, 1.5, 2.5];
const HALF_LINES = [0.5, 1.5, 2.5];

const SERIES: { id: string; label: string; variant: SignalVariant | null }[] = [
  { id: "moteur", label: "xG moteur (profondeur totale)", variant: null },
  { id: "recence3", label: "xG récence (demi-vie 3)", variant: VARIANT_BY_ID.get("B6_xg_recency_3")! },
];

interface Config {
  key: string;
  label: string;
  weight: number;
  variant: SignalVariant | null;
}

const CONFIGS: Config[] = [
  { key: "W0", label: "A — sans xG (référence)", weight: 0, variant: null },
  ...SERIES.flatMap((series) =>
    WEIGHTS.filter((w) => w > 0).map((weight) => ({
      key: `${series.id}_w${Math.round(weight * 100)}`,
      label: `${series.label} — ${Math.round(weight * 100)} %`,
      weight,
      variant: series.variant,
    })),
  ),
];

// ---------------------------------------------------------------------------
// Inventaire
// ---------------------------------------------------------------------------

/** Identique à `withXg` de run.ts — seul écart autorisé entre A et B. */
function withXg(context: MatchContext, lookup: Map<string, XgRecord>): MatchContext {
  if (lookup.size === 0) return context;
  const mapRecord = (record: MatchRecord): MatchRecord => {
    const fetched = lookup.get(record.id);
    if (!fetched) return record;
    return { ...record, homeXg: fetched.homeXg, awayXg: fetched.awayXg, source: fetched.source };
  };
  const mapSnapshot = (snapshot: TeamSnapshot): TeamSnapshot => {
    const seasonMatches = snapshot.seasonMatches.map(mapRecord);
    return {
      ...snapshot,
      seasonMatches,
      headToHead: snapshot.headToHead.map(mapRecord),
      hasXg: seasonMatches.some((m) => m.homeXg !== null || m.awayXg !== null),
    };
  };
  return { ...context, home: mapSnapshot(context.home), away: mapSnapshot(context.away) };
}

interface Snapshot12 {
  id: string;
  competition: string;
  season: string;
  half: "premiere" | "seconde";
  y: number;
  homeGoals: number;
  awayGoals: number;
  totalGoals: number;
  htTotal: number | null;
  /** 1X2 moyenné entre modèles — architecture actuelle. */
  ensemble: number[];
  /** 1X2 lu dans la matrice de scores — architecture cohérente. */
  fromMatrix: number[];
  totals: number[];
  btts: number;
  teamHome: number[];
  teamAway: number[];
  firstHalf: number[] | null;
  lambdaHome: number;
  lambdaAway: number;
  xgWeight: number;
  agreement: number;
  /** Score exact, réduit par rencontre. */
  exact: { logLoss: number; pActual: number; topProb: number; rank: number; mass: number };
}

function outcomeOf(match: BacktestMatch): number {
  if (match.homeGoals > match.awayGoals) return 0;
  if (match.homeGoals === match.awayGoals) return 1;
  return 2;
}

/**
 * Indicateurs du score exact — définitions STRICTEMENT identiques à
 * `exactScoreMetrics` : rang 1/3/5 du score réellement réalisé.
 */
function exactIndicators(matrix: number[][], home: number, away: number) {
  const scores: { p: number; h: number; a: number }[] = [];
  let sum = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      const p = matrix[h]![a]!;
      sum += p;
      scores.push({ p, h, a });
    }
  }
  scores.sort((x, y) => y.p - x.p);
  const cap = (v: number, limit: number) => Math.min(v, limit);
  const actual = scores.find(
    (s) => s.h === cap(home, matrix.length - 1) && s.a === cap(away, matrix.length - 1),
  );
  const pActual = actual ? actual.p / (sum || 1) : 1e-9;
  return {
    logLoss: -Math.log(Math.max(pActual, 1e-9)),
    pActual,
    topProb: scores[0] ? scores[0].p / (sum || 1) : 1e-9,
    rank: scores.findIndex((s) => s === actual) + 1,
    mass: sum,
  };
}

function exactSummary(records: Snapshot12[]) {
  if (records.length === 0) {
    return { n: 0, logLoss: 0, meanProbabilityOfActual: 0, meanTopProbability: 0, top1: 0, top3: 0, top5: 0, meanMass: 0 };
  }
  const n = records.length;
  const sum = (pick: (r: Snapshot12) => number) => records.reduce((s, r) => s + pick(r), 0);
  return {
    n,
    logLoss: sum((r) => r.exact.logLoss) / n,
    meanProbabilityOfActual: sum((r) => r.exact.pActual) / n,
    meanTopProbability: sum((r) => r.exact.topProb) / n,
    top1: records.filter((r) => r.exact.rank === 1).length / n,
    top3: records.filter((r) => r.exact.rank >= 1 && r.exact.rank <= 3).length / n,
    top5: records.filter((r) => r.exact.rank >= 1 && r.exact.rank <= 5).length / n,
    meanMass: sum((r) => r.exact.mass) / n,
  };
}

interface Aggregate {
  n: number;
  ensemble: MarketMetrics;
  fromMatrix: MarketMetrics;
  drawMean: number;
  classBrier: number[];
  totals: Record<string, MarketMetrics>;
  btts: MarketMetrics;
  teamHome: Record<string, MarketMetrics>;
  teamAway: Record<string, MarketMetrics>;
  firstHalf: Record<string, MarketMetrics> | null;
  exact: ReturnType<typeof exactSummary>;
  meanXgWeight: number;
  meanLambdaHome: number;
  meanLambdaAway: number;
  meanAgreement: number;
}

function aggregate(records: Snapshot12[]): Aggregate {
  const ensembleObs: MulticlassObservation[] = records.map((r) => ({ p: r.ensemble, y: r.y }));
  const matrixObs: MulticlassObservation[] = records.map((r) => ({ p: r.fromMatrix, y: r.y }));

  const totals: Record<string, MarketMetrics> = {};
  TOTAL_LINES.forEach((line, index) => {
    totals[String(line)] = binaryMetrics(
      records.map((r) => ({ p: r.totals[index]!, y: r.totalGoals > line ? 1 : 0 })),
    );
  });

  const teamHome: Record<string, MarketMetrics> = {};
  const teamAway: Record<string, MarketMetrics> = {};
  TEAM_LINES.forEach((line, index) => {
    teamHome[String(line)] = binaryMetrics(
      records.map((r) => ({ p: r.teamHome[index]!, y: r.homeGoals > line ? 1 : 0 })),
    );
    teamAway[String(line)] = binaryMetrics(
      records.map((r) => ({ p: r.teamAway[index]!, y: r.awayGoals > line ? 1 : 0 })),
    );
  });

  const withHalf = records.filter((r) => r.firstHalf !== null && r.htTotal !== null);
  const firstHalf: Record<string, MarketMetrics> | null =
    withHalf.length === 0
      ? null
      : Object.fromEntries(
          HALF_LINES.map((line, index) => [
            String(line),
            binaryMetrics(
              withHalf.map((r) => ({ p: r.firstHalf![index]!, y: r.htTotal! > line ? 1 : 0 })),
            ),
          ]),
        );

  const mean = (pick: (r: Snapshot12) => number) =>
    records.length === 0 ? 0 : records.reduce((s, r) => s + pick(r), 0) / records.length;

  return {
    n: records.length,
    ensemble: multiclassMetrics(ensembleObs),
    fromMatrix: multiclassMetrics(matrixObs),
    drawMean: mean((r) => r.ensemble[1]!),
    classBrier: [0, 1, 2].map((i) => perClassBrier(ensembleObs, i)),
    totals,
    btts: binaryMetrics(
      records.map((r) => ({ p: r.btts, y: r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0 })),
    ),
    teamHome,
    teamAway,
    firstHalf,
    exact: exactSummary(records),
    meanXgWeight: mean((r) => r.xgWeight),
    meanLambdaHome: mean((r) => r.lambdaHome),
    meanLambdaAway: mean((r) => r.lambdaAway),
    meanAgreement: mean((r) => r.agreement),
  };
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

async function main() {
  const outDir = `data/backtests/${new Date().toISOString().replace(/[:.]/g, "-")}-phase12`;
  mkdirSync(outDir, { recursive: true });

  console.log("\n☀️  SOLEIL — phase 12 · architecture hybride buts + 1X2");
  console.log("═".repeat(78));
  console.log("Coût de cette phase : 0 crédit (cache, fichiers, base uniquement)");
  console.log(`Saisons de test     : ${TEST_SEASONS.join(", ")}`);
  console.log(`Poids xG testés     : ${WEIGHTS.map((w) => `${Math.round(w * 100)} %`).join(" · ")}`);
  console.log(`Configurations      : ${CONFIGS.length}`);
  console.log("═".repeat(78));

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
  console.log(`\nRencontres chargées : ${all.length} · xG en base : ${xgLookup.size}`);
  console.log(`Rencontres de test  : ${testMatches.length}`);

  const ranking = new Map<string, Map<string, number>>();
  for (const key of new Set(testMatches.map((m) => `${m.competition}:${m.season}`))) {
    const ordered = all
      .filter((m) => `${m.competition}:${m.season}` === key)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    ranking.set(key, new Map(ordered.map((m, index) => [m.id, index])));
  }

  const snapshots = new Map<string, Snapshot12[]>();
  for (const config of CONFIGS) snapshots.set(config.key, []);

  // Inventaire des modèles : moyennes par configuration, pour la décomposition (§4)
  const modelDetail = new Map<string, { weights: Record<string, number>; lambdas: Record<string, { home: number; away: number }>; outcomes: Record<string, number[]> }>();
  for (const config of CONFIGS) {
    modelDetail.set(config.key, { weights: {}, lambdas: {}, outcomes: {} });
  }

  let processed = 0;
  const failures: string[] = [];
  for (const match of testMatches) {
    const seasonKey = `${match.competition}:${match.season}`;
    const table = ranking.get(seasonKey)!;
    const rank = table.get(match.id) ?? 0;
    const half: "premiere" | "seconde" = rank < table.size / 2 ? "premiere" : "seconde";
    const y = outcomeOf(match);
    let context: MatchContext;
    try {
      context = withXg(
        buildBacktestContext(match, all, { leagueName: COMPETITIONS[match.competition]!.name }),
        xgLookup,
      );
    } catch (error) {
      failures.push(`${match.id}: ${(error as Error).message}`);
      continue;
    }

    for (const config of CONFIGS) {
      const xgVariant = config.variant
        ? (ctx: Parameters<typeof variantModel>[0]) => variantModel(ctx, config.variant!)
        : (ctx: Parameters<typeof xgModel>[0]) => xgModel(ctx);
      const probs = runPipeline(context, {
        xgVariant,
        xgBaseWeight: config.weight,
        verbose: true,
      });

      const detail = modelDetail.get(config.key)!;
      for (const model of probs.models ?? []) {
        const weightEntry = detail.weights[model.name] ?? 0;
        detail.weights[model.name] = weightEntry + model.weight / testMatches.length;
        if (model.expectedGoals) {
          const prev = detail.lambdas[model.name] ?? { home: 0, away: 0 };
          detail.lambdas[model.name] = {
            home: prev.home + model.expectedGoals.home / testMatches.length,
            away: prev.away + model.expectedGoals.away / testMatches.length,
          };
        }
        const prevOutcome = detail.outcomes[model.name] ?? [0, 0, 0];
        detail.outcomes[model.name] = [
          prevOutcome[0]! + model.outcomes.home / testMatches.length,
          prevOutcome[1]! + model.outcomes.draw / testMatches.length,
          prevOutcome[2]! + model.outcomes.away / testMatches.length,
        ];
      }

      snapshots.get(config.key)!.push({
        id: match.id,
        competition: match.competition,
        season: match.season,
        half,
        y,
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        totalGoals: match.homeGoals + match.awayGoals,
        htTotal:
          match.halfTimeHomeGoals !== null && match.halfTimeAwayGoals !== null
            ? match.halfTimeHomeGoals + match.halfTimeAwayGoals
            : null,
        ensemble: [probs.outcomes.home, probs.outcomes.draw, probs.outcomes.away],
        fromMatrix: [probs.matrixOutcomes.home, probs.matrixOutcomes.draw, probs.matrixOutcomes.away],
        totals: probs.totals.map((t) => t.over),
        btts: probs.btts.yes,
        teamHome: probs.teamGoals.home.map((t) => t.over),
        teamAway: probs.teamGoals.away.map((t) => t.over),
        firstHalf: match.halfTimeHomeGoals !== null ? probs.firstHalf.overUnder.map((t) => t.over) : null,
        lambdaHome: probs.lambdas.home,
        lambdaAway: probs.lambdas.away,
        xgWeight: probs.xgWeight,
        agreement: probs.agreement,
        exact: exactIndicators(
          probs.matrix,
          Math.min(match.homeGoals, probs.matrix.length - 1),
          Math.min(match.awayGoals, probs.matrix.length - 1),
        ),
      });
    }
    processed += 1;
    if (processed % 500 === 0) console.log(`   … ${processed}/${testMatches.length}`);
  }
  console.log(`Rencontres évaluées : ${processed} × ${CONFIGS.length} configurations`);
  if (failures.length > 0) console.log(`Échecs : ${failures.length} (${failures[0]})`);

  // --- Sous-ensemble commun : le xG est actif -------------------------------
  const reference = snapshots.get("moteur_w20")!;
  const eligibleIds = new Set(reference.filter((r) => r.xgWeight > 0).map((r) => r.id));
  const pick = (key: string, ids?: Set<string>) =>
    ids ? snapshots.get(key)!.filter((r) => ids.has(r.id)) : snapshots.get(key)!;

  console.log(`\nSous-ensemble commun (xG actif) : ${eligibleIds.size} rencontres`);

  const results: Record<string, Aggregate> = {};
  const resultsEligible: Record<string, Aggregate> = {};
  for (const config of CONFIGS) {
    results[config.key] = aggregate(pick(config.key));
    resultsEligible[config.key] = aggregate(pick(config.key, eligibleIds));
  }

  // --- Balayage des poids (§5, §22) ----------------------------------------
  console.log("\n" + "═".repeat(78));
  console.log("POIDS xG — sur les rencontres où le xG agit (§5)");
  console.log("═".repeat(78));
  console.log(
    `${"configuration".padEnd(38)} ${"pds eff.".padStart(8)} ${"1X2 moy.".padStart(9)} ${"1X2 matr.".padStart(10)} ${"O/U2.5".padStart(8)} ${"BTTS".padStart(8)} ${"LogLoss".padStart(9)} ${"ECE".padStart(7)}`,
  );
  for (const config of CONFIGS) {
    const agg = resultsEligible[config.key]!;
    console.log(
      `${config.label.padEnd(38)} ${`${(agg.meanXgWeight * 100).toFixed(1)} %`.padStart(8)} ` +
        `${agg.ensemble.brier.toFixed(4).padStart(9)} ${agg.fromMatrix.brier.toFixed(4).padStart(10)} ` +
        `${agg.totals["2.5"]!.brier.toFixed(4).padStart(8)} ${agg.btts.brier.toFixed(4).padStart(8)} ` +
        `${agg.ensemble.logLoss.toFixed(4).padStart(9)} ${`${(agg.ensemble.ece * 100).toFixed(2)}`.padStart(7)}`,
    );
  }

  // --- Écarts appariés contre le modèle A (§6, §8) --------------------------
  const baseline = resultsEligible.W0!;
  const deltaTable: {
    key: string;
    label: string;
    weight: number;
    effectiveWeight: number;
    markets: Record<string, ReturnType<typeof pairedBootstrap>>;
    matrixMarkets: Record<string, ReturnType<typeof pairedBootstrap>>;
    byCompetition: Record<string, number>;
    byPeriod: Record<string, number>;
    bySeason: Record<string, number>;
  }[] = [];

  console.log("\n" + "─".repeat(78));
  console.log("ÉCARTS APPARIÉS CONTRE LE MODÈLE A — 1X2 moyenné (§6)");
  console.log("─".repeat(78));
  console.log(`${"configuration".padEnd(38)} ${"Δ 1X2".padStart(10)} ${"IC 95 %".padStart(24)} ${"P(B<A)".padStart(8)} ${"Δ O/U2.5".padStart(11)} ${"Δ BTTS".padStart(10)}`);

  for (const config of CONFIGS) {
    if (config.key === "W0") continue;
    const candidate = pick(config.key, eligibleIds);
    const referenceRecords = pick("W0", eligibleIds);
    const markets: Record<string, ReturnType<typeof pairedBootstrap>> = {
      "1X2": pairedBootstrap(
        multiclassBrierPerMatch(referenceRecords.map((r) => ({ p: r.ensemble, y: r.y }))),
        multiclassBrierPerMatch(candidate.map((r) => ({ p: r.ensemble, y: r.y }))),
      ),
      "Over/Under 2.5": pairedBootstrap(
        binaryBrierPerMatch(referenceRecords.map((r) => ({ p: r.totals[2]!, y: r.totalGoals > 2.5 ? 1 : 0 }))),
        binaryBrierPerMatch(candidate.map((r) => ({ p: r.totals[2]!, y: r.totalGoals > 2.5 ? 1 : 0 }))),
      ),
      BTTS: pairedBootstrap(
        binaryBrierPerMatch(referenceRecords.map((r) => ({ p: r.btts, y: r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0 }))),
        binaryBrierPerMatch(candidate.map((r) => ({ p: r.btts, y: r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0 }))),
      ),
    };
    const matrixMarkets: Record<string, ReturnType<typeof pairedBootstrap>> = {
      "1X2": pairedBootstrap(
        multiclassBrierPerMatch(referenceRecords.map((r) => ({ p: r.fromMatrix, y: r.y }))),
        multiclassBrierPerMatch(candidate.map((r) => ({ p: r.fromMatrix, y: r.y }))),
      ),
    };
    const byCompetition: Record<string, number> = {};
    for (const competition of Object.keys(COMPETITIONS)) {
      const a = referenceRecords.filter((r) => r.competition === competition);
      const b = candidate.filter((r) => r.competition === competition);
      if (a.length === 0) continue;
      byCompetition[competition] =
        multiclassBrierPerMatch(b.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / b.length -
        multiclassBrierPerMatch(a.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / a.length;
    }
    const byPeriod: Record<string, number> = {};
    for (const half of ["premiere", "seconde"]) {
      const a = referenceRecords.filter((r) => r.half === half);
      const b = candidate.filter((r) => r.half === half);
      if (a.length === 0) continue;
      byPeriod[half] =
        multiclassBrierPerMatch(b.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / b.length -
        multiclassBrierPerMatch(a.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / a.length;
    }
    const bySeason: Record<string, number> = {};
    for (const season of TEST_SEASONS) {
      const a = referenceRecords.filter((r) => r.season === season);
      const b = candidate.filter((r) => r.season === season);
      if (a.length < 30) continue;
      bySeason[season] =
        multiclassBrierPerMatch(b.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / b.length -
        multiclassBrierPerMatch(a.map((r) => ({ p: r.ensemble, y: r.y }))).reduce((s, v) => s + v, 0) / a.length;
    }

    deltaTable.push({
      key: config.key,
      label: config.label,
      weight: config.weight,
      effectiveWeight: resultsEligible[config.key]!.meanXgWeight,
      markets,
      matrixMarkets,
      byCompetition,
      byPeriod,
      bySeason,
    });

    const one = markets["1X2"]!;
    console.log(
      `${config.label.padEnd(38)} ${one.meanDifference >= 0 ? "+" : ""}${one.meanDifference.toFixed(5)} ` +
        `[${one.lower >= 0 ? "+" : ""}${one.lower.toFixed(5)}; ${one.upper >= 0 ? "+" : ""}${one.upper.toFixed(5)}]`.padStart(24) +
        ` ${one.probabilityBetter.toFixed(2).padStart(8)} ` +
        `${markets["Over/Under 2.5"]!.meanDifference.toFixed(5).padStart(11)} ` +
        `${markets.BTTS!.meanDifference.toFixed(5).padStart(10)}`,
    );
  }

  // --- Calibration (§7) — ajustée sur le passé, validée sur le futur ---------
  const toCal = (records: Snapshot12[], which: "ensemble" | "fromMatrix"): CalibrationObservation[] =>
    records.map((r) => ({ p: which === "ensemble" ? r.ensemble : r.fromMatrix, y: r.y }));

  const calibration: Record<string, unknown>[] = [];
  console.log("\n" + "═".repeat(78));
  console.log("CALIBRATION 1X2 — ajustée sur 2023/24 + 2024/25, validée sur 2025/26 (§7)");
  console.log("═".repeat(78));
  console.log(`${"configuration".padEnd(30)} ${"avant".padStart(9)} ${"température".padStart(11)} ${"T".padStart(6)} ${"vecteur".padStart(9)} ${"c(nul)".padStart(8)} ${"c(ext)".padStart(8)}`);

  for (const config of CONFIGS) {
    if (!["W0", "moteur_w20", "recence3_w20", "moteur_w10", "moteur_w30"].includes(config.key)) continue;
    for (const which of ["ensemble", "fromMatrix"] as const) {
      const fitSet = pick(config.key).filter((r) => FIT_SEASONS.includes(r.season));
      const validationSet = pick(config.key).filter((r) => r.season === VALIDATION_SEASON);
      if (fitSet.length < 100 || validationSet.length < 100) continue;
      const fitObs = toCal(fitSet, which);
      const validationObs = toCal(validationSet, which);
      const temperature = fitTemperature(fitObs);
      const vector = fitVector(fitObs);
      const before = {
        brier: multiclassBrier(validationObs),
        logLoss: multiclassLogLoss(validationObs),
        ece: multiclassMetrics(validationObs).ece,
      };
      const afterTemp = {
        brier: multiclassBrier(validationObs.map((o) => ({ p: temperatureApply(o.p, temperature.t), y: o.y }))),
        logLoss: multiclassLogLoss(validationObs.map((o) => ({ p: temperatureApply(o.p, temperature.t), y: o.y }))),
        ece: multiclassMetrics(validationObs.map((o) => ({ p: temperatureApply(o.p, temperature.t), y: o.y }))).ece,
      };
      const afterVector = {
        brier: multiclassBrier(validationObs.map((o) => ({ p: vectorApply(o.p, vector.t, vector.c), y: o.y }))),
        logLoss: multiclassLogLoss(validationObs.map((o) => ({ p: vectorApply(o.p, vector.t, vector.c), y: o.y }))),
        ece: multiclassMetrics(validationObs.map((o) => ({ p: vectorApply(o.p, vector.t, vector.c), y: o.y }))).ece,
      };
      calibration.push({
        config: config.key,
        path: which,
        fitSeasons: FIT_SEASONS,
        validationSeason: VALIDATION_SEASON,
        fitMatches: fitSet.length,
        validationMatches: validationSet.length,
        temperature: { t: temperature.t, c: temperature.c },
        vector: { t: vector.t, c: vector.c },
        before,
        afterTemp,
        afterVector,
      });
      console.log(
        `${`${config.key}/${which === "ensemble" ? "moyenné" : "matrice"}`.padEnd(30)} ` +
          `${before.brier.toFixed(4).padStart(9)} ${afterTemp.brier.toFixed(4).padStart(11)} ${temperature.t.toFixed(2).padStart(6)} ` +
          `${afterVector.brier.toFixed(4).padStart(9)} ${vector.c[1]!.toFixed(3).padStart(8)} ${vector.c[2]!.toFixed(3).padStart(8)}`,
      );
    }
  }

  // --- Nul (§9) -------------------------------------------------------------
  console.log("\n" + "─".repeat(78));
  console.log("CLASSE NUL — décomposition du Brier par issue (§9)");
  console.log("─".repeat(78));
  console.log(`${"configuration".padEnd(30)} ${"P(nul) moy".padStart(11)} ${"fréq. réelle".padStart(12)} ${"Brier dom.".padStart(11)} ${"Brier nul".padStart(10)} ${"Brier ext.".padStart(10)}`);
  const drawAnalysis: unknown[] = [];
  for (const config of CONFIGS) {
    const agg = resultsEligible[config.key]!;
    const records = pick(config.key, eligibleIds);
    const observedDraw = records.filter((r) => r.y === 1).length / (records.length || 1);
    drawAnalysis.push({
      key: config.key,
      label: config.label,
      meanDraw: agg.drawMean,
      observedDraw,
      classBrier: agg.classBrier,
      ensemble: { brier: agg.ensemble.brier, logLoss: agg.ensemble.logLoss },
      fromMatrix: { brier: agg.fromMatrix.brier, logLoss: agg.fromMatrix.logLoss },
    });
    console.log(
      `${config.label.padEnd(30)} ${agg.drawMean.toFixed(4).padStart(11)} ${observedDraw.toFixed(4).padStart(12)} ` +
        `${agg.classBrier[0]!.toFixed(4).padStart(11)} ${agg.classBrier[1]!.toFixed(4).padStart(10)} ${agg.classBrier[2]!.toFixed(4).padStart(10)}`,
    );
  }

  // --- Marchés de buts (§11) et score exact (§12) ---------------------------
  console.log("\n" + "─".repeat(78));
  console.log("MARCHÉS DE BUTS ET SCORE EXACT — configuration la plus favorable (§11, §12)");
  console.log("─".repeat(78));
  const goalMarkets: unknown[] = [];
  for (const config of CONFIGS) {
    const agg = resultsEligible[config.key]!;
    goalMarkets.push({
      key: config.key,
      label: config.label,
      totals: Object.fromEntries(Object.entries(agg.totals).map(([line, m]) => [line, { brier: m.brier, logLoss: m.logLoss }])),
      btts: { brier: agg.btts.brier, logLoss: agg.btts.logLoss },
      teamHome: Object.fromEntries(Object.entries(agg.teamHome).map(([line, m]) => [line, m.brier])),
      teamAway: Object.fromEntries(Object.entries(agg.teamAway).map(([line, m]) => [line, m.brier])),
      firstHalf: agg.firstHalf
        ? Object.fromEntries(Object.entries(agg.firstHalf).map(([line, m]) => [line, m.brier]))
        : null,
      exact: agg.exact,
    });
  }

  // --- Architecture (§19, §23) ---------------------------------------------
  console.log("\n" + "═".repeat(78));
  console.log("ARCHITECTURE — 1X2 moyenné contre 1X2 dérivé de la distribution (§19)");
  console.log("═".repeat(78));
  console.log(`${"configuration".padEnd(30)} ${"moyenné".padStart(9)} ${"matrice".padStart(9)} ${"écart".padStart(9)} ${"somme dist.".padStart(12)}`);
  const architecture: unknown[] = [];
  for (const config of CONFIGS) {
    const agg = resultsEligible[config.key]!;
    architecture.push({
      key: config.key,
      label: config.label,
      ensemble: { brier: agg.ensemble.brier, logLoss: agg.ensemble.logLoss, ece: agg.ensemble.ece },
      fromMatrix: { brier: agg.fromMatrix.brier, logLoss: agg.fromMatrix.logLoss, ece: agg.fromMatrix.ece },
      meanDistributionMass: agg.exact.meanMass,
    });
    console.log(
      `${config.label.padEnd(30)} ${agg.ensemble.brier.toFixed(4).padStart(9)} ${agg.fromMatrix.brier.toFixed(4).padStart(9)} ` +
        `${(agg.fromMatrix.brier - agg.ensemble.brier).toFixed(5).padStart(9)} ${agg.exact.meanMass.toFixed(7).padStart(12)}`,
    );
  }

  // --- Analyse des erreurs (§10) -------------------------------------------
  console.log("\n" + "─".repeat(78));
  console.log("ANALYSE DES ERREURS — Modèle A contre xG 20 % (§10)");
  console.log("─".repeat(78));
  const errorAnalysis: Record<string, unknown> = {};
  {
    const a = pick("W0", eligibleIds);
    const b = pick("moteur_w20", eligibleIds);
    const index = new Map(b.map((r) => [r.id, r]));
    const brierOf = (r: Snapshot12) =>
      r.ensemble.reduce((s, p, i) => s + (p - (i === r.y ? 1 : 0)) ** 2, 0);

    const brackets = (pick2: (r: Snapshot12) => string) => {
      const groups = new Map<string, { n: number; delta: number; a: number; b: number }>();
      for (const ra of a) {
        const rb = index.get(ra.id)!;
        const key = pick2(ra);
        const entry = groups.get(key) ?? { n: 0, delta: 0, a: 0, b: 0 };
        entry.n += 1;
        entry.a += brierOf(ra);
        entry.b += brierOf(rb);
        entry.delta += brierOf(rb) - brierOf(ra);
        groups.set(key, entry);
      }
      return Object.fromEntries(
        [...groups.entries()].map(([key, v]) => [
          key,
          { n: v.n, brierA: v.a / v.n, brierB: v.b / v.n, delta: v.delta / v.n },
        ]),
      );
    };

    const topClass = (p: number[]) => p.indexOf(Math.max(...p));
    const favorites = { changed: 0, aWrong: 0, bWrong: 0, bothWrong: 0 };
    let drawDown = 0;
    let awayUp = 0;
    let drawSumA = 0;
    let drawSumB = 0;
    for (const ra of a) {
      const rb = index.get(ra.id)!;
      if (ra.ensemble[1]! > rb.ensemble[1]!) drawDown += 1;
      if (rb.ensemble[2]! > ra.ensemble[2]!) awayUp += 1;
      drawSumA += ra.ensemble[1]!;
      drawSumB += rb.ensemble[1]!;
      const topA = topClass(ra.ensemble);
      const topB = topClass(rb.ensemble);
      if (topA !== topB) favorites.changed += 1;
      if (topA !== ra.y) favorites.aWrong += 1;
      if (topB !== rb.y) favorites.bWrong += 1;
      if (topA !== ra.y && topB !== rb.y) favorites.bothWrong += 1;
    }
    errorAnalysis.selection = {
      favoritesChanged: favorites.changed,
      wrongFavouriteA: favorites.aWrong,
      wrongFavouriteB: favorites.bWrong,
      wrongInBoth: favorites.bothWrong,
      drawProbabilityLowered: drawDown,
      awayProbabilityRaised: awayUp,
      meanDrawA: drawSumA / a.length,
      meanDrawB: drawSumB / b.length,
    };
    errorAnalysis.byActualGoals = brackets((r) =>
      r.totalGoals <= 1 ? "0-1 but" : r.totalGoals <= 3 ? "2-3 buts" : "4 buts et plus",
    );
    errorAnalysis.byFavouriteClarity = brackets((r) => {
      const gap = Math.abs(r.ensemble[0]! - r.ensemble[2]!);
      return gap < 0.1 ? "favori peu net" : gap < 0.25 ? "favori net" : "favori très net";
    });
    errorAnalysis.byDrawProbability = brackets((r) =>
      r.ensemble[1]! < 0.24 ? "nul improbable (<24 %)" : r.ensemble[1]! < 0.28 ? "nul moyen (24-28 %)" : "nul probable (≥28 %)",
    );
    errorAnalysis.byLambdaTotal = brackets((r) =>
      r.lambdaHome + r.lambdaAway < 2.4 ? "match fermé (<2,4)" : r.lambdaHome + r.lambdaAway < 3.2 ? "match médian" : "match ouvert (≥3,2)",
    );
    const meanLambdas = {
      A: resultsEligible.W0!.meanLambdaHome + resultsEligible.W0!.meanLambdaAway,
      B: resultsEligible.moteur_w20!.meanLambdaHome + resultsEligible.moteur_w20!.meanLambdaAway,
    };
    errorAnalysis.meanLambdas = meanLambdas;

    console.log(`Favori désigné qui change entre A et B : ${favorites.changed} / ${a.length}`);
    console.log(`Favori faux — A : ${favorites.aWrong} · B : ${favorites.bWrong} · les deux : ${favorites.bothWrong}`);
    console.log(`P(nul) abaissée par le xG : ${drawDown} / ${a.length} rencontres`);
    console.log(`P(extérieur) relevée par le xG : ${awayUp} / ${a.length} rencontres`);
    console.log(`P(nul) moyenne — A : ${(drawSumA / a.length).toFixed(4)} · B : ${(drawSumB / b.length).toFixed(4)}`);
    console.log(`λ total moyen — A : ${meanLambdas.A.toFixed(3)} · B : ${meanLambdas.B.toFixed(3)}`);
    for (const [name, table] of Object.entries({
      "par buts réels": errorAnalysis.byActualGoals,
      "par netteté du favori": errorAnalysis.byFavouriteClarity,
      "par P(nul)": errorAnalysis.byDrawProbability,
      "par λ total": errorAnalysis.byLambdaTotal,
    })) {
      console.log(`  ${name} :`);
      for (const [key, v] of Object.entries(table as Record<string, { n: number; delta: number }>)) {
        console.log(`    ${key.padEnd(24)} n=${String(v.n).padStart(4)}  ΔBrier ${v.delta >= 0 ? "+" : ""}${v.delta.toFixed(5)}`);
      }
    }
  }

  // --- Calibration des marchés de buts (§7 appliqué aux marchés binaires) ----
  const binaryApplyT = (p: number, t: number) => {
    const a = Math.pow(Math.max(p, 1e-9), 1 / t);
    const b = Math.pow(Math.max(1 - p, 1e-9), 1 / t);
    return a / (a + b);
  };
  const binaryFitT = (obs: BinaryObservation[]) => {
    let best = { t: 1, loss: Number.POSITIVE_INFINITY };
    for (let value = 0.4; value <= 3 + 1e-9; value += 0.01) {
      const t = Math.round(value * 1000) / 1000;
      let loss = 0;
      for (const o of obs) {
        const q = binaryApplyT(o.p, t);
        loss += -Math.log(Math.max(o.y === 1 ? q : 1 - q, 1e-9));
      }
      loss /= obs.length || 1;
      if (loss < best.loss) best = { t, loss };
    }
    return best;
  };
  const binaryLoss = (obs: BinaryObservation[]) =>
    obs.length === 0
      ? 0
      : obs.reduce((s, o) => s + -Math.log(Math.max(o.y === 1 ? o.p : 1 - o.p, 1e-9)), 0) / obs.length;

  const goalMarketCalibration: unknown[] = [];
  console.log("\n" + "═".repeat(78));
  console.log("CALIBRATION DES MARCHÉS DE BUTS — ajustée sur 2023/24 + 2024/25 (§7, §11)");
  console.log("═".repeat(78));
  console.log(`${"configuration".padEnd(30)} ${"marché".padStart(9)} ${"Brier av.".padStart(10)} ${"Brier ap.".padStart(10)} ${"T".padStart(6)} ${"LL av.".padStart(8)} ${"LL ap.".padStart(8)}`);
  for (const config of CONFIGS) {
    const records = pick(config.key);
    const fitSet = records.filter((r) => FIT_SEASONS.includes(r.season));
    const validationSet = records.filter((r) => r.season === VALIDATION_SEASON);
    const markets: { name: string; obs: (r: Snapshot12) => BinaryObservation }[] = [
      { name: "O/U 2,5", obs: (r) => ({ p: r.totals[2]!, y: r.totalGoals > 2.5 ? 1 : 0 }) },
      { name: "O/U 3,5", obs: (r) => ({ p: r.totals[3]!, y: r.totalGoals > 3.5 ? 1 : 0 }) },
      { name: "BTTS", obs: (r) => ({ p: r.btts, y: r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0 }) },
    ];
    for (const market of markets) {
      const fitObs = fitSet.map(market.obs);
      const validationObs = validationSet.map(market.obs);
      if (fitObs.length < 100 || validationObs.length < 100) continue;
      const fitted = binaryFitT(fitObs);
      const after = validationObs.map((o) => ({ p: binaryApplyT(o.p, fitted.t), y: o.y }));
      const entry = {
        config: config.key,
        market: market.name,
        t: fitted.t,
        fitLogLoss: fitted.loss,
        validationMatches: validationObs.length,
        before: { brier: binaryMetrics(validationObs).brier, logLoss: binaryLoss(validationObs), ece: binaryMetrics(validationObs).ece },
        after: { brier: binaryMetrics(after).brier, logLoss: binaryLoss(after), ece: binaryMetrics(after).ece },
      };
      goalMarketCalibration.push(entry);
      if (config.key === "W0" || config.key === "moteur_w20" || config.key === "recence3_w20") {
        console.log(
          `${config.label.padEnd(30)} ${market.name.padStart(9)} ${entry.before.brier.toFixed(4).padStart(10)} ` +
            `${entry.after.brier.toFixed(4).padStart(10)} ${fitted.t.toFixed(2).padStart(6)} ` +
            `${entry.before.logLoss.toFixed(4).padStart(8)} ${entry.after.logLoss.toFixed(4).padStart(8)}`,
        );
      }
    }
  }

  // --- Stabilité du calibrateur (§8) ---------------------------------------
  const stability: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("STABILITÉ DU CALIBRATEUR — même ajustement, périodes différentes (§8)");
  console.log("─".repeat(78));
  for (const config of CONFIGS.filter((c) => ["W0", "moteur_w20", "recence3_w20"].includes(c.key))) {
    const records = pick(config.key);
    const folds: { label: string; seasons: string[] }[] = [
      { label: "2023/24 seul", seasons: ["2023/2024"] },
      { label: "2024/25 seul", seasons: ["2024/2025"] },
      { label: "les deux", seasons: FIT_SEASONS },
    ];
    const row: Record<string, unknown> = { config: config.key, folds: [] };
    for (const fold of folds) {
      const obs = records.filter((r) => fold.seasons.includes(r.season)).map((r) => ({ p: r.ensemble, y: r.y }));
      if (obs.length < 200) continue;
      const vector = fitVector(obs);
      (row.folds as unknown[]).push({ label: fold.label, n: obs.length, t: vector.t, c: vector.c });
      console.log(
        `${config.key.padEnd(16)} ${fold.label.padEnd(14)} n=${String(obs.length).padStart(4)} · T=${vector.t.toFixed(2)} · c(nul)=${vector.c[1]!.toFixed(3)} · c(ext)=${vector.c[2]!.toFixed(3)}`,
      );
    }
    stability.push(row);
  }

  // --- Architecture hybride (§19, §23) -------------------------------------
  // « 1X2 sans xG + marchés de buts avec xG » — composition explicite, et
  // mesure du coût de cohérence qu'elle introduit.
  const hybrid: unknown[] = [];
  console.log("\n" + "═".repeat(78));
  console.log("ARCHITECTURE HYBRIDE — 1X2 sans xG, buts avec xG (§19)");
  console.log("═".repeat(78));
  console.log(`${"variante hybride".padEnd(40)} ${"1X2".padStart(9)} ${"O/U2.5".padStart(9)} ${"BTTS".padStart(9)} ${"incohérence".padStart(13)}`);
  {
    const base = pick("W0", eligibleIds);
    const baseIndex = new Map(base.map((r) => [r.id, r]));
    const incoherence = (a: Snapshot12[], b: Snapshot12[]) =>
      a.reduce((s, r, i) => {
        const other = b[i]!;
        return s + 0.5 * (Math.abs(r.ensemble[0]! - other.fromMatrix[0]!) + Math.abs(r.ensemble[1]! - other.fromMatrix[1]!) + Math.abs(r.ensemble[2]! - other.fromMatrix[2]!));
      }, 0) / (a.length || 1);

    for (const key of ["moteur_w20", "recence3_w20", "recence3_w30"]) {
      const goalRecords = pick(key, eligibleIds);
      const goals = aggregate(goalRecords);
      const value = {
        hybrid: `1X2 = A · buts = ${key}`,
        oneXTwo: { brier: resultsEligible.W0!.ensemble.brier, logLoss: resultsEligible.W0!.ensemble.logLoss },
        oneXTwoMatrix: { brier: resultsEligible.W0!.fromMatrix.brier, logLoss: resultsEligible.W0!.fromMatrix.logLoss },
        totals: { "2.5": goals.totals["2.5"]!.brier },
        btts: goals.btts.brier,
        incoherence: incoherence(base, goalRecords),
      };
      hybrid.push(value);
      console.log(
        `${value.hybrid.padEnd(40)} ${value.oneXTwo.brier.toFixed(4).padStart(9)} ${goals.totals["2.5"]!.brier.toFixed(4).padStart(9)} ` +
          `${goals.btts.brier.toFixed(4).padStart(9)} ${value.incoherence.toFixed(5).padStart(13)}`,
      );
    }
    // Référence : la même mesure pour une architecture 100 % cohérente.
    console.log(
      `${"cohérent : A seul (matrice)".padEnd(40)} ${resultsEligible.W0!.fromMatrix.brier.toFixed(4).padStart(9)} ` +
        `${resultsEligible.W0!.totals["2.5"]!.brier.toFixed(4).padStart(9)} ${resultsEligible.W0!.btts.brier.toFixed(4).padStart(9)} ` +
        `${"0".padStart(13)}`,
    );
  }

  // --- Comparaison finale : calibré A contre calibré xG, hors échantillon ----
  const finalComparison: unknown[] = [];
  console.log("\n" + "═".repeat(78));
  console.log("COMPARAISON FINALE — 1X2 calibré, validé sur 2025/26 (hors échantillon)");
  console.log("═".repeat(78));
  console.log(`${"configuration".padEnd(34)} ${"chemin".padStart(8)} ${"brut".padStart(8)} ${"calibré".padStart(9)} ${"Δ calibré vs A".padStart(16)} ${"IC 95 %".padStart(22)}`);
  {
    const validationIds = new Set(
      pick("moteur_w20").filter((r) => r.season === VALIDATION_SEASON).map((r) => r.id),
    );
    const perMatch = (records: Snapshot12[], path: "ensemble" | "fromMatrix", calibrator: ReturnType<typeof fitVector>) =>
      records.map((r) => {
        const p = path === "ensemble" ? r.ensemble : r.fromMatrix;
        const q = vectorApply(p, calibrator.t, calibrator.c);
        return q.reduce((s, v, i) => s + (v - (i === r.y ? 1 : 0)) ** 2, 0);
      });

    const referenceCalibrator = {
      ensemble: fitVector(pick("W0").filter((r) => FIT_SEASONS.includes(r.season)).map((r) => ({ p: r.ensemble, y: r.y }))),
      fromMatrix: fitVector(pick("W0").filter((r) => FIT_SEASONS.includes(r.season)).map((r) => ({ p: r.fromMatrix, y: r.y }))),
    };

    for (const key of ["W0", "moteur_w10", "moteur_w20", "moteur_w30", "recence3_w20", "recence3_w30"]) {
      for (const path of ["ensemble", "fromMatrix"] as const) {
        const records = pick(key).filter((r) => validationIds.has(r.id));
        const calibrator = fitVector(
          pick(key).filter((r) => FIT_SEASONS.includes(r.season)).map((r) => ({ p: path === "ensemble" ? r.ensemble : r.fromMatrix, y: r.y })),
        );
        const raw = path === "ensemble" ? multiclassBrierPerMatch(records.map((r) => ({ p: r.ensemble, y: r.y }))) : multiclassBrierPerMatch(records.map((r) => ({ p: r.fromMatrix, y: r.y })));
        const calibrated = perMatch(records, path, calibrator);
        const referenceCalibrated = perMatch(records, path, referenceCalibrator[path]);
        const comparison = pairedBootstrap(referenceCalibrated, calibrated);
        const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
        const entry = {
          config: key,
          path,
          n: records.length,
          rawBrier: mean(raw),
          calibratedBrier: mean(calibrated),
          referenceCalibratedBrier: mean(referenceCalibrated),
          delta: comparison.meanDifference,
          lower: comparison.lower,
          upper: comparison.upper,
          probabilityBetter: comparison.probabilityBetter,
        };
        finalComparison.push(entry);
        console.log(
          `${key.padEnd(34)} ${(path === "ensemble" ? "moyenné" : "matrice").padStart(8)} ${entry.rawBrier.toFixed(4).padStart(8)} ` +
            `${entry.calibratedBrier.toFixed(4).padStart(9)} ${(entry.delta >= 0 ? "+" : "") + entry.delta.toFixed(5)}`.padStart(16) +
            ` [${entry.lower >= 0 ? "+" : ""}${entry.lower.toFixed(5)}; ${entry.upper >= 0 ? "+" : ""}${entry.upper.toFixed(5)}]`.padStart(22),
        );
      }
    }
  }

  // --- Écriture -------------------------------------------------------------
  const compact = {
    generatedAt: new Date().toISOString(),
    creditsSpent: 0,
    protocol: {
      testSeasons: TEST_SEASONS,
      fitSeasons: FIT_SEASONS,
      validationSeason: VALIDATION_SEASON,
      weights: WEIGHTS,
      eligibleMatches: eligibleIds.size,
      totalMatches: processed,
    },
    sweep: CONFIGS.map((config) => {
      const all12 = results[config.key]!;
      const elig = resultsEligible[config.key]!;
      return {
        key: config.key,
        label: config.label,
        requestedWeight: config.weight,
        effectiveWeight: elig.meanXgWeight,
        n: all12.n,
        all: {
          ensemble: { brier: all12.ensemble.brier, logLoss: all12.ensemble.logLoss, ece: all12.ensemble.ece },
          fromMatrix: { brier: all12.fromMatrix.brier, logLoss: all12.fromMatrix.logLoss, ece: all12.fromMatrix.ece },
          totals: Object.fromEntries(Object.entries(all12.totals).map(([l, m]) => [l, m.brier])),
          btts: all12.btts.brier,
          exact: all12.exact,
        },
        eligible: {
          ensemble: { brier: elig.ensemble.brier, logLoss: elig.ensemble.logLoss, ece: elig.ensemble.ece },
          fromMatrix: { brier: elig.fromMatrix.brier, logLoss: elig.fromMatrix.logLoss, ece: elig.fromMatrix.ece },
          totals: Object.fromEntries(Object.entries(elig.totals).map(([l, m]) => [l, m.brier])),
          btts: elig.btts.brier,
          exact: elig.exact,
          classBrier: elig.classBrier,
          drawMean: elig.drawMean,
          lambdas: { home: elig.meanLambdaHome, away: elig.meanLambdaAway },
          agreement: elig.meanAgreement,
        },
      };
    }),
    deltas: deltaTable,
    calibration,
    drawAnalysis,
    goalMarkets,
    architecture,
    errorAnalysis,
    goalMarketCalibration,
    stability,
    hybrid,
    finalComparison,
    modelDetail: Object.fromEntries(
      [...modelDetail.entries()].map(([key, value]) => [
        key,
        { weights: value.weights, lambdas: value.lambdas, outcomes: value.outcomes },
      ]),
    ),
  };
  writeFileSync(`${outDir}/phase12.json`, JSON.stringify(compact, null, 2), "utf8");

  const jsonl = CONFIGS.flatMap((config) =>
    snapshots.get(config.key)!.map((r) =>
      JSON.stringify({
        c: config.key,
        m: r.id,
        o: r.competition,
        s: r.season,
        h: r.half,
        y: r.y,
        e: r.ensemble.map((v) => Number(v.toFixed(6))),
        x: r.fromMatrix.map((v) => Number(v.toFixed(6))),
        t: r.totals.map((v) => Number(v.toFixed(6))),
        b: Number(r.btts.toFixed(6)),
        tg: r.totalGoals,
        hg: r.homeGoals,
        ag: r.awayGoals,
        xw: Number(r.xgWeight.toFixed(4)),
        lg: Number(r.exact.logLoss.toFixed(6)),
      }),
    ),
  );
  writeFileSync(`${outDir}/records.jsonl`, jsonl.join("\n"), "utf8");

  console.log(`\nRapport : ${outDir}/phase12.json`);
  console.log(`Rejeu par rencontre : ${outDir}/records.jsonl`);
  console.log("Coût de la phase 12 : 0 crédit.\n");
}

main().catch((error) => {
  console.error("Échec de la phase 12 :", error);
  process.exit(1);
});
