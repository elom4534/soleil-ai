/**
 * ============================================================================
 * SOLEIL — PHASE 13 · Validation exhaustive du xG calibré, marché par marché
 * ============================================================================
 * §1 — Le moteur de production n'est pas touché. Tout se passe dans ce banc
 *      d'essai, sur les données déjà payées.
 * §2 — ZÉRO crédit : seuls les fichiers locaux, le cache et les 460 rencontres
 *      enrichies de la phase 11 sont lus.
 * §3 — Modèle A et Modèle B sont évalués sur EXACTEMENT les mêmes rencontres.
 *
 *   MODÈLE A : moteur actuel, sans signal xG.
 *   MODÈLE B : xG 20 % + pondération par récence (demi-vie 3 matchs)
 *              + calibration 1X2 validée en phase 12.
 *
 * Tous les marchés sont LUS dans la même matrice de scores que celle qui produit
 * déjà les probabilités publiées — aucun marché n'est reconstruit à part.
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
import { runPipeline } from "./pipeline";
import { VARIANT_BY_ID, variantModel } from "./variants";
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
  vectorApply,
  type CalibrationObservation,
} from "./calibration";

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
const FIT_SEASON = "2024/2025";
const VALIDATION_SEASON = "2025/2026";

const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const TEAM_LINES = [0.5, 1.5, 2.5];
/** Lignes de période : au-delà de 2,5 buts en une mi-temps, l'échantillon s'effondre. */
const HALF_LINES = [0.5, 1.5, 2.5];

const XG_WEIGHT = 0.2;
const XG_VARIANT = VARIANT_BY_ID.get("B6_xg_recency_3")!;

// ---------------------------------------------------------------------------
// Inventaire : tout est lu depuis une matrice de scores
// ---------------------------------------------------------------------------

interface ExactReduced {
  logLoss: number;
  pActual: number;
  topProb: number;
  rank: number;
}

interface MarketBlock {
  /** 1X2 lu dans la matrice. */
  outcomes: [number, number, number];
  totals: number[];
  btts: number;
  teamHome: number[];
  teamAway: number[];
  exact: ExactReduced;
  mass: number;
  expectedGoals: number;
}

function outcomeIndex(h: number, a: number): number {
  if (h > a) return 0;
  if (h === a) return 1;
  return 2;
}

function readMatrix(
  matrix: number[][],
  home: number,
  away: number,
  lines: number[],
): MarketBlock {
  const cap = (v: number, limit: number) => Math.min(v, limit);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let btts = 0;
  let mass = 0;
  const totals = new Array<number>(lines.length).fill(0);
  const teamHome = new Array<number>(lines.length).fill(0);
  const teamAway = new Array<number>(lines.length).fill(0);
  const scores: { p: number; h: number; a: number }[] = [];

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      const p = matrix[h]![a]!;
      mass += p;
      scores.push({ p, h, a });
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h >= 1 && a >= 1) btts += p;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (h + a > line) totals[i] += p;
        if (h > line) teamHome[i] += p;
        if (a > line) teamAway[i] += p;
      }
    }
  }

  scores.sort((x, y) => y.p - x.p);
  const targetH = cap(home, matrix.length - 1);
  const targetA = cap(away, (matrix[targetH]?.length ?? 1) - 1);
  const actual = scores.find((s) => s.h === targetH && s.a === targetA);
  const pActual = actual ? actual.p / (mass || 1) : 1e-9;
  let expectedGoals = 0;
  for (const s of scores) expectedGoals += s.p * (s.h + s.a);

  const total = homeWin + draw + awayWin || 1;
  return {
    outcomes: [homeWin / total, draw / total, awayWin / total],
    totals,
    btts,
    teamHome,
    teamAway,
    exact: {
      logLoss: -Math.log(Math.max(pActual, 1e-9)),
      pActual,
      topProb: scores[0] ? scores[0].p / (mass || 1) : 1e-9,
      rank: scores.findIndex((s) => s === actual) + 1,
    },
    mass,
    expectedGoals,
  };
}

interface Snap13 {
  id: string;
  competition: string;
  season: string;
  half: "premiere" | "seconde";
  xgWeight: number;
  lambdaHome: number;
  lambdaAway: number;
  ft: MarketBlock;
  /** 1X2 du moteur (moyenne pondérée des modèles), tel qu'il est publié. */
  ensemble: [number, number, number];
  ht: MarketBlock | null;
  sh: MarketBlock | null;
  actual: {
    home: number;
    away: number;
    total: number;
    btts: 0 | 1;
    htHome: number | null;
    htAway: number | null;
    htTotal: number | null;
    shHome: number | null;
    shAway: number | null;
    shTotal: number | null;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type ConfigKey = "A" | "B";

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

// ---------------------------------------------------------------------------
// Métriques par marché
// ---------------------------------------------------------------------------

interface MarketResult {
  market: string;
  family: "1X2" | "total" | "teamHome" | "teamAway" | "btts" | "exact";
  period: "FT" | "HT" | "SH";
  n: number;
  /** Brier du modèle A. Pour le score exact : Log Loss. */
  a: number;
  b: number;
  delta: number;
  lower: number;
  upper: number;
  probabilityBetter: number;
  logLossA: number;
  logLossB: number;
  logLossDelta: number;
  logLossLower: number;
  logLossUpper: number;
  eceA: number;
  eceB: number;
  metric: "brier" | "logloss";
}

function emptyMarket(market: string, family: MarketResult["family"], period: MarketResult["period"]): MarketResult {
  return {
    market,
    family,
    period,
    n: 0,
    a: 0,
    b: 0,
    delta: 0,
    lower: 0,
    upper: 0,
    probabilityBetter: 0,
    logLossA: 0,
    logLossB: 0,
    logLossDelta: 0,
    logLossLower: 0,
    logLossUpper: 0,
    eceA: 0,
    eceB: 0,
    metric: "brier",
  };
}

function binaryPerMatchLogLoss(obs: BinaryObservation[]): number[] {
  return obs.map((o) => -Math.log(Math.max(o.y === 1 ? o.p : 1 - o.p, 1e-9)));
}

function multiclassPerMatchLogLoss(obs: MulticlassObservation[]): number[] {
  return obs.map((o) => -Math.log(Math.max(o.p[o.y] ?? 1e-9, 1e-9)));
}

/** Comparaison appariée complète sur un marché binaire. */
function compareBinary(
  market: string,
  family: MarketResult["family"],
  period: MarketResult["period"],
  obsA: BinaryObservation[],
  obsB: BinaryObservation[],
): MarketResult {
  const n = Math.min(obsA.length, obsB.length);
  if (n === 0) return emptyMarket(market, family, period);
  const a = binaryMetrics(obsA);
  const b = binaryMetrics(obsB);
  const brier = pairedBootstrap(binaryBrierPerMatch(obsA), binaryBrierPerMatch(obsB));
  const logLoss = pairedBootstrap(binaryPerMatchLogLoss(obsA), binaryPerMatchLogLoss(obsB));
  return {
    market,
    family,
    period,
    n,
    a: a.brier,
    b: b.brier,
    delta: brier.meanDifference,
    lower: brier.lower,
    upper: brier.upper,
    probabilityBetter: brier.probabilityBetter,
    logLossA: a.logLoss,
    logLossB: b.logLoss,
    logLossDelta: logLoss.meanDifference,
    logLossLower: logLoss.lower,
    logLossUpper: logLoss.upper,
    eceA: a.ece,
    eceB: b.ece,
    metric: "brier",
  };
}

function compareMulticlass(
  market: string,
  period: MarketResult["period"],
  obsA: MulticlassObservation[],
  obsB: MulticlassObservation[],
): MarketResult {
  const n = Math.min(obsA.length, obsB.length);
  if (n === 0) return emptyMarket(market, "1X2", period);
  const a = multiclassMetrics(obsA);
  const b = multiclassMetrics(obsB);
  const brier = pairedBootstrap(multiclassBrierPerMatch(obsA), multiclassBrierPerMatch(obsB));
  const logLoss = pairedBootstrap(multiclassPerMatchLogLoss(obsA), multiclassPerMatchLogLoss(obsB));
  return {
    market,
    family: "1X2",
    period,
    n,
    a: a.brier,
    b: b.brier,
    delta: brier.meanDifference,
    lower: brier.lower,
    upper: brier.upper,
    probabilityBetter: brier.probabilityBetter,
    logLossA: a.logLoss,
    logLossB: b.logLoss,
    logLossDelta: logLoss.meanDifference,
    logLossLower: logLoss.lower,
    logLossUpper: logLoss.upper,
    eceA: a.ece,
    eceB: b.ece,
    metric: "brier",
  };
}

function compareExact(
  market: string,
  period: MarketResult["period"],
  recordsA: Snap13[],
  recordsB: Snap13[],
  pick: (r: Snap13) => ExactReduced | null,
): MarketResult {
  const pairs: [ExactReduced, ExactReduced][] = [];
  for (let i = 0; i < Math.min(recordsA.length, recordsB.length); i++) {
    const x = pick(recordsA[i]!);
    const y = pick(recordsB[i]!);
    if (x && y) pairs.push([x, y]);
  }
  if (pairs.length === 0) return emptyMarket(market, "exact", period);
  const llA = pairs.map(([x]) => x.logLoss);
  const llB = pairs.map(([, y]) => y.logLoss);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const boot = pairedBootstrap(llA, llB);
  return {
    market,
    family: "exact",
    period,
    n: pairs.length,
    a: mean(llA),
    b: mean(llB),
    delta: boot.meanDifference,
    lower: boot.lower,
    upper: boot.upper,
    probabilityBetter: boot.probabilityBetter,
    logLossA: mean(llA),
    logLossB: mean(llB),
    logLossDelta: boot.meanDifference,
    logLossLower: boot.lower,
    logLossUpper: boot.upper,
    eceA: NaN,
    eceB: NaN,
    metric: "logloss",
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = `data/backtests/${new Date().toISOString().replace(/[:.]/g, "-")}-phase13`;
  mkdirSync(outDir, { recursive: true });

  console.log("\n☀️  SOLEIL — phase 13 · validation exhaustive du xG calibré");
  console.log("═".repeat(78));
  console.log("Coût : 0 crédit (fichiers locaux, cache, dataset des 460 rencontres)");
  console.log("Modèle A : moteur actuel, sans xG");
  console.log("Modèle B : xG 20 % + récence (demi-vie 3) + calibration 1X2 phase 12");
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

  const records: Record<ConfigKey, Snap13[]> = { A: [], B: [] };
  const failures: string[] = [];
  let processed = 0;
  let withoutHalfTime = 0;

  for (const match of testMatches) {
    const seasonKey = `${match.competition}:${match.season}`;
    const table = ranking.get(seasonKey)!;
    const rank = table.get(match.id) ?? 0;
    const half: "premiere" | "seconde" = rank < table.size / 2 ? "premiere" : "seconde";
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

    const htHome = match.halfTimeHomeGoals;
    const htAway = match.halfTimeAwayGoals;
    if (htHome === null || htAway === null) withoutHalfTime += 1;

    for (const config of ["A", "B"] as ConfigKey[]) {
      const options =
        config === "A"
          ? { xgBaseWeight: 0, xgVariant: (ctx: Parameters<typeof xgModel>[0]) => xgModel(ctx) }
          : {
              xgBaseWeight: XG_WEIGHT,
              xgVariant: (ctx: Parameters<typeof variantModel>[0]) => variantModel(ctx, XG_VARIANT),
            };
      const probs = runPipeline(context, options);

      if (config === "B" && probs.xgWeight <= 0) continue; // hors du sous-ensemble xG

      const ft = readMatrix(probs.matrix, match.homeGoals, match.awayGoals, TOTAL_LINES);
      const ht =
        htHome !== null && htAway !== null
          ? readMatrix(probs.firstHalf.matrix, htHome, htAway, HALF_LINES)
          : null;
      const sh =
        htHome !== null && htAway !== null
          ? readMatrix(
              probs.secondHalf.matrix,
              match.homeGoals - htHome,
              match.awayGoals - htAway,
              HALF_LINES,
            )
          : null;

      records[config].push({
        id: match.id,
        competition: match.competition,
        season: match.season,
        half,
        xgWeight: probs.xgWeight,
        lambdaHome: probs.lambdas.home,
        lambdaAway: probs.lambdas.away,
        ft,
        ensemble: [probs.outcomes.home, probs.outcomes.draw, probs.outcomes.away],
        ht,
        sh,
        actual: {
          home: match.homeGoals,
          away: match.awayGoals,
          total: match.homeGoals + match.awayGoals,
          btts: match.homeGoals > 0 && match.awayGoals > 0 ? 1 : 0,
          htHome,
          htAway,
          htTotal: htHome !== null && htAway !== null ? htHome + htAway : null,
          shHome: htHome !== null ? match.homeGoals - htHome : null,
          shAway: htAway !== null ? match.awayGoals - htAway : null,
          shTotal: htHome !== null && htAway !== null ? match.homeGoals + match.awayGoals - htHome - htAway : null,
        },
      });
    }

    if (records.A.length !== records.B.length) records.A.pop(); // sécurité d'appariement
    processed += 1;
    if (processed % 500 === 0) console.log(`   … ${processed}/${testMatches.length}`);
  }

  const n = records.A.length;
  console.log(`Rencontres appariées : ${n} (A et B rigoureusement identiques)`);
  console.log(`Rencontres sans score à la mi-temps : ${withoutHalfTime} — écartées des marchés de période, jamais reconstruites`);
  if (failures.length > 0) console.log(`Échecs : ${failures.length}`);
  if (records.A.length !== records.B.length) throw new Error("désappariement A/B");

  for (let i = 0; i < n; i++) {
    if (records.A[i]!.id !== records.B[i]!.id) throw new Error(`appariement rompu à l'index ${i}`);
  }

  // --- Calibration 1X2 : ajustée sur 2024/25, validée sur 2025/26 -----------
  const fitIndexes = records.A.map((r, i) => (r.season === FIT_SEASON ? i : -1)).filter((i) => i >= 0);
  const validationIndexes = records.A.map((r, i) => (r.season === VALIDATION_SEASON ? i : -1)).filter((i) => i >= 0);
  console.log(`\nCalibration ajustée sur ${FIT_SEASON} (n=${fitIndexes.length}) · validée sur ${VALIDATION_SEASON} (n=${validationIndexes.length})`);

  // Le calibrateur appartient au MODÈLE B : il est donc ajusté sur la sortie
  // brute de B, et non sur celle de A. Un calibrateur ajusté sur A puis appliqué
  // à B mélangerait deux modèles différents.
  const fitObs: CalibrationObservation[] = fitIndexes.map((i) => ({
    p: records.B[i]!.ensemble,
    y: outcomeIndex(records.B[i]!.actual.home, records.B[i]!.actual.away),
  }));
  const calibrator = fitVector(fitObs);
  const calibratorA = fitVector(
    fitIndexes.map((i) => ({
      p: records.A[i]!.ensemble,
      y: outcomeIndex(records.A[i]!.actual.home, records.A[i]!.actual.away),
    })),
  );
  console.log(`Calibrateur B (ajusté sur la sortie de B) : T=${calibrator.t.toFixed(2)} · c=[${calibrator.c.map((v) => v.toFixed(3)).join(" ; ")}]`);
  console.log(`Calibrateur A (ajusté sur la sortie de A) : T=${calibratorA.t.toFixed(2)} · c=[${calibratorA.c.map((v) => v.toFixed(3)).join(" ; ")}]`);

  const calibrated = (key: ConfigKey): MarketResult[] => {
    const obsA: MulticlassObservation[] = [];
    const obsB: MulticlassObservation[] = [];
    for (let i = 0; i < n; i++) {
      const y = outcomeIndex(records.A[i]!.actual.home, records.A[i]!.actual.away);
      obsA.push({ p: records.A[i]!.ensemble, y });
      obsB.push({ p: vectorApply(records.B[i]!.ensemble, calibrator.t, calibrator.c), y });
    }
    return [compareMulticlass("1X2", "FT", obsA, obsB)];
  };

  // --- Décomposition des effets (§3, §15, §17) ------------------------------
  // Le Δ « B contre A » mélange DEUX choses : l'apport du xG et l'apport de la
  // calibration. Les séparer est la seule façon d'attribuer correctement le gain.
  const decomposition: unknown[] = [];
  {
    const oi = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    const run = (label: string, indexes: number[]) => {
      const obsA = indexes.map((i) => ({ p: records.A[i]!.ensemble, y: oi(records.A[i]!) }));
      const obsB = indexes.map((i) => ({ p: records.B[i]!.ensemble, y: oi(records.B[i]!) }));
      const obsACal = indexes.map((i) => ({
        p: vectorApply(records.A[i]!.ensemble, calibratorA.t, calibratorA.c),
        y: oi(records.A[i]!),
      }));
      const obsBCal = indexes.map((i) => ({
        p: vectorApply(records.B[i]!.ensemble, calibrator.t, calibrator.c),
        y: oi(records.B[i]!),
      }));
      const comparisons = [
        { name: "Effet du xG, aucune calibration", a: obsA, b: obsB },
        { name: "Effet de la calibration, sans xG", a: obsA, b: obsACal },
        { name: "Effet de la calibration, avec xG", a: obsB, b: obsBCal },
        { name: "Effet du xG, à calibration égale", a: obsACal, b: obsBCal },
        { name: "MODÈLE B calibré contre MODÈLE A brut", a: obsA, b: obsBCal },
      ].map((comparison) => {
        const boot = pairedBootstrap(
          multiclassBrierPerMatch(comparison.a),
          multiclassBrierPerMatch(comparison.b),
        );
        return {
          name: comparison.name,
          brierA: multiclassMetrics(comparison.a).brier,
          brierB: multiclassMetrics(comparison.b).brier,
          delta: boot.meanDifference,
          lower: boot.lower,
          upper: boot.upper,
          probabilityBetter: boot.probabilityBetter,
        };
      });
      decomposition.push({ scope: label, n: indexes.length, comparisons });
    };
    run(`hors échantillon — ${VALIDATION_SEASON} seulement`, validationIndexes);
    run(`périmètre complet — ${n} rencontres (dont ${fitIndexes.length} servant à l'ajustement)`, records.A.map((_, i) => i));

    const headline = (decomposition[0] as { comparisons: { name: string; delta: number; lower: number; upper: number; probabilityBetter: number }[] }).comparisons;
    console.log("\n" + "═".repeat(78));
    console.log("DÉCOMPOSITION DES EFFETS SUR LE 1X2 (§3, §15)");
    console.log("═".repeat(78));
    for (const scope of decomposition as { scope: string; n: number; comparisons: typeof headline }[]) {
      console.log(`\n${scope.scope} (n=${scope.n})`);
      for (const c of scope.comparisons) {
        const sign = (v: number) => (v >= 0 ? "+" : "");
        console.log(
          `   ${c.name.padEnd(42)} Δ ${sign(c.delta)}${c.delta.toFixed(5)} [${sign(c.lower)}${c.lower.toFixed(5)}; ${sign(c.upper)}${c.upper.toFixed(5)}] · P=${c.probabilityBetter.toFixed(2)}` +
            (c.lower < 0 && c.upper < 0 ? "  ← établi" : c.lower > 0 && c.upper > 0 ? "  ← établi (défavorable)" : "  ← non établi"),
        );
      }
    }
  }

  // --- Décomposition HORS ÉCHANTILLON (§3, §15, §17) ------------------------
  // Le calibrateur pré-enregistré est celui de la phase 12, ajusté sur 2023/24 +
  // 2024/25 : des données antérieures et disjointes de la saison de validation.
  // Aucun paramètre n'est réajusté ici, donc aucun optimisme n'est introduit.
  const PREREG_A = { t: 0.69, c: [1, 1.26, 1.02] };
  const PREREG_B = { t: 0.66, c: [1, 1.28, 1.0] };
  const preregistered: unknown[] = [];
  {
    const oi = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    const run = (label: string, indexes: number[]) => {
      const states = {
        aRaw: indexes.map((i) => ({ p: records.A[i]!.ensemble, y: oi(records.A[i]!) })),
        bRaw: indexes.map((i) => ({ p: records.B[i]!.ensemble, y: oi(records.B[i]!) })),
        aCal: indexes.map((i) => ({ p: vectorApply(records.A[i]!.ensemble, PREREG_A.t, PREREG_A.c), y: oi(records.A[i]!) })),
        bCal: indexes.map((i) => ({ p: vectorApply(records.B[i]!.ensemble, PREREG_B.t, PREREG_B.c), y: oi(records.B[i]!) })),
      };
      const metrics = Object.fromEntries(
        Object.entries(states).map(([k, obs]) => {
          const m = multiclassMetrics(obs);
          return [k, { brier: m.brier, logLoss: m.logLoss, ece: m.ece }];
        }),
      );
      const comparisons = (
        [
          ["Effet du xG, sans calibration", "aRaw", "bRaw"],
          ["Effet de la calibration, sans xG", "aRaw", "aCal"],
          ["Effet de la calibration, avec xG", "bRaw", "bCal"],
          ["Effet du xG, à calibration égale", "aCal", "bCal"],
          ["Modèle B calibré contre Modèle A brut", "aRaw", "bCal"],
        ] as const
      ).map(([name, ka, kb]) => {
        const boot = pairedBootstrap(
          multiclassBrierPerMatch(states[ka]),
          multiclassBrierPerMatch(states[kb]),
        );
        return {
          name,
          delta: boot.meanDifference,
          lower: boot.lower,
          upper: boot.upper,
          probabilityBetter: boot.probabilityBetter,
        };
      });
      preregistered.push({ scope: label, n: indexes.length, metrics, comparisons });
    };
    run(`hors échantillon — ${VALIDATION_SEASON} seulement`, validationIndexes);
    run(`périmètre complet — ${n} rencontres`, records.A.map((_, i) => i));

    console.log("\n" + "═".repeat(78));
    console.log("DÉCOMPOSITION HORS ÉCHANTILLON — calibrateur pré-enregistré phase 12");
    console.log("═".repeat(78));
    for (const scope of preregistered as {
      scope: string;
      n: number;
      metrics: Record<string, { brier: number; logLoss: number; ece: number }>;
      comparisons: { name: string; delta: number; lower: number; upper: number; probabilityBetter: number }[];
    }[]) {
      console.log(`\n${scope.scope} (n=${scope.n})`);
      console.log(
        `   A brut ${scope.metrics.aRaw!.brier.toFixed(4)} · B brut ${scope.metrics.bRaw!.brier.toFixed(4)} · ` +
          `A cal ${scope.metrics.aCal!.brier.toFixed(4)} · B cal ${scope.metrics.bCal!.brier.toFixed(4)}`,
      );
      for (const c of scope.comparisons) {
        const sign = (v: number) => (v >= 0 ? "+" : "");
        console.log(
          `   ${c.name.padEnd(42)} Δ ${sign(c.delta)}${c.delta.toFixed(5)} [${sign(c.lower)}${c.lower.toFixed(5)}; ${sign(c.upper)}${c.upper.toFixed(5)}] · P=${c.probabilityBetter.toFixed(2)}`,
        );
      }
    }
  }

  // --- Construction de tous les marchés ------------------------------------
  const results: MarketResult[] = [];
  const label = (line: number) => line.toFixed(1).replace(".", ",");

  // 1X2 — trois variantes du modèle B
  {
    const yOf = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    const obsA: MulticlassObservation[] = records.A.map((r) => ({ p: r.ensemble, y: yOf(r) }));
    const rawB: MulticlassObservation[] = records.B.map((r) => ({ p: r.ensemble, y: yOf(r) }));
    const calB: MulticlassObservation[] = records.B.map((r) => ({
      p: vectorApply(r.ensemble, calibrator.t, calibrator.c),
      y: yOf(r),
    }));
    const matA: MulticlassObservation[] = records.A.map((r) => ({ p: r.ft.outcomes, y: yOf(r) }));
    const matB: MulticlassObservation[] = records.B.map((r) => ({ p: r.ft.outcomes, y: yOf(r) }));
    const matCalB: MulticlassObservation[] = records.B.map((r) => ({
      p: vectorApply(r.ft.outcomes, calibrator.t, calibrator.c),
      y: yOf(r),
    }));

    results.push({ ...compareMulticlass("1X2 — B brut", "FT", obsA, rawB), metric: "brier" });
    results.push({ ...compareMulticlass("1X2 — B calibré", "FT", obsA, calB), metric: "brier" });
    results.push({ ...compareMulticlass("1X2 (matrice) — B brut", "FT", matA, matB), metric: "brier" });
    results.push({ ...compareMulticlass("1X2 (matrice) — B calibré", "FT", matA, matCalB), metric: "brier" });
  }

  // Over/Under total
  TOTAL_LINES.forEach((line, index) => {
    const obsA: BinaryObservation[] = records.A.map((r) => ({
      p: r.ft.totals[index]!,
      y: r.actual.total > line ? 1 : 0,
    }));
    const obsB: BinaryObservation[] = records.B.map((r) => ({
      p: r.ft.totals[index]!,
      y: r.actual.total > line ? 1 : 0,
    }));
    results.push(compareBinary(`O/U total ${label(line)}`, "total", "FT", obsA, obsB));
  });

  // BTTS
  {
    const obsA: BinaryObservation[] = records.A.map((r) => ({ p: r.ft.btts, y: r.actual.btts }));
    const obsB: BinaryObservation[] = records.B.map((r) => ({ p: r.ft.btts, y: r.actual.btts }));
    results.push(compareBinary("BTTS", "btts", "FT", obsA, obsB));
  }

  // Buts par équipe
  TEAM_LINES.forEach((line, index) => {
    const homeA: BinaryObservation[] = records.A.map((r) => ({
      p: r.ft.teamHome[index]!,
      y: r.actual.home > line ? 1 : 0,
    }));
    const homeB: BinaryObservation[] = records.B.map((r) => ({
      p: r.ft.teamHome[index]!,
      y: r.actual.home > line ? 1 : 0,
    }));
    results.push(compareBinary(`Domicile > ${label(line)}`, "teamHome", "FT", homeA, homeB));

    const awayA: BinaryObservation[] = records.A.map((r) => ({
      p: r.ft.teamAway[index]!,
      y: r.actual.away > line ? 1 : 0,
    }));
    const awayB: BinaryObservation[] = records.B.map((r) => ({
      p: r.ft.teamAway[index]!,
      y: r.actual.away > line ? 1 : 0,
    }));
    results.push(compareBinary(`Extérieur > ${label(line)}`, "teamAway", "FT", awayA, awayB));
  });

  // Score exact
  results.push(compareExact("Score exact", "FT", records.A, records.B, (r) => r.ft.exact));

  // --- Marchés de première mi-temps ----------------------------------------
  // Sous-ensemble : uniquement les rencontres dont le score à la mi-temps est
  // réellement connu (§10). Aucune reconstruction.
  const htPairs: [Snap13, Snap13][] = [];
  for (let i = 0; i < n; i++) {
    const a = records.A[i]!;
    const b = records.B[i]!;
    if (a.ht && b.ht && a.actual.htHome !== null && a.actual.htAway !== null) htPairs.push([a, b]);
  }
  console.log(`\nRencontres avec score à la mi-temps : ${htPairs.length} / ${n}`);

  if (htPairs.length > 0) {
    const yFt = ([a]: [Snap13, Snap13]) => outcomeIndex(a.actual.htHome!, a.actual.htAway!);
    results.push(
      compareMulticlass(
        "1X2 1re mi-temps",
        "HT",
        htPairs.map(([a]) => ({ p: a.ht!.outcomes, y: yFt([a, a]) })),
        htPairs.map(([, b]) => ({ p: b.ht!.outcomes, y: yFt([b, b]) })),
      ),
    );
    HALF_LINES.forEach((line, index) => {
      results.push(
        compareBinary(
          `1re mi-temps O/U ${label(line)}`,
          "total",
          "HT",
          htPairs.map(([a]) => ({ p: a.ht!.totals[index]!, y: (a.actual.htTotal ?? 0) > line ? 1 : 0 })),
          htPairs.map(([, b]) => ({ p: b.ht!.totals[index]!, y: (b.actual.htTotal ?? 0) > line ? 1 : 0 })),
        ),
      );
    });
    results.push(
      compareBinary(
        "1re mi-temps BTTS",
        "btts",
        "HT",
        htPairs.map(([a]) => ({ p: a.ht!.btts, y: a.actual.htHome! > 0 && a.actual.htAway! > 0 ? 1 : 0 })),
        htPairs.map(([, b]) => ({ p: b.ht!.btts, y: b.actual.htHome! > 0 && b.actual.htAway! > 0 ? 1 : 0 })),
      ),
    );
    TEAM_LINES.forEach((line, index) => {
      results.push(
        compareBinary(
          `1re mi-temps domicile > ${label(line)}`,
          "teamHome",
          "HT",
          htPairs.map(([a]) => ({ p: a.ht!.teamHome[index]!, y: a.actual.htHome! > line ? 1 : 0 })),
          htPairs.map(([, b]) => ({ p: b.ht!.teamHome[index]!, y: b.actual.htHome! > line ? 1 : 0 })),
        ),
      );
      results.push(
        compareBinary(
          `1re mi-temps extérieur > ${label(line)}`,
          "teamAway",
          "HT",
          htPairs.map(([a]) => ({ p: a.ht!.teamAway[index]!, y: a.actual.htAway! > line ? 1 : 0 })),
          htPairs.map(([, b]) => ({ p: b.ht!.teamAway[index]!, y: b.actual.htAway! > line ? 1 : 0 })),
        ),
      );
    });
    results.push(
      compareExact(
        "Score exact 1re mi-temps",
        "HT",
        htPairs.map(([a]) => a),
        htPairs.map(([, b]) => b),
        (r) => r.ht?.exact ?? null,
      ),
    );
  }

  // --- Marchés de deuxième mi-temps ----------------------------------------
  // Buts de la 2e période = score final − score à la mi-temps. C'est une
  // soustraction de données réelles, jamais une reconstruction.
  const shPairs: [Snap13, Snap13][] = [];
  for (let i = 0; i < n; i++) {
    const a = records.A[i]!;
    const b = records.B[i]!;
    if (a.sh && b.sh && a.actual.shTotal !== null && b.actual.shTotal !== null) shPairs.push([a, b]);
  }
  console.log(`Rencontres avec 2e mi-temps calculable : ${shPairs.length} / ${n}`);

  if (shPairs.length > 0) {
    const ySh = (r: Snap13) => outcomeIndex(r.actual.shHome!, r.actual.shAway!);
    results.push(
      compareMulticlass(
        "1X2 2e mi-temps",
        "HT",
        shPairs.map(([a]) => ({ p: a.sh!.outcomes, y: ySh(a) })),
        shPairs.map(([, b]) => ({ p: b.sh!.outcomes, y: ySh(b) })),
      ),
    );
    HALF_LINES.forEach((line, index) => {
      results.push(
        compareBinary(
          `2e mi-temps O/U ${label(line)}`,
          "total",
          "SH",
          shPairs.map(([a]) => ({ p: a.sh!.totals[index]!, y: (a.actual.shTotal ?? 0) > line ? 1 : 0 })),
          shPairs.map(([, b]) => ({ p: b.sh!.totals[index]!, y: (b.actual.shTotal ?? 0) > line ? 1 : 0 })),
        ),
      );
    });
    results.push(
      compareBinary(
        "2e mi-temps BTTS",
        "btts",
        "SH",
        shPairs.map(([a]) => ({ p: a.sh!.btts, y: a.actual.shHome! > 0 && a.actual.shAway! > 0 ? 1 : 0 })),
        shPairs.map(([, b]) => ({ p: b.sh!.btts, y: b.actual.shHome! > 0 && b.actual.shAway! > 0 ? 1 : 0 })),
      ),
    );
    TEAM_LINES.forEach((line, index) => {
      results.push(
        compareBinary(
          `2e mi-temps domicile > ${label(line)}`,
          "teamHome",
          "SH",
          shPairs.map(([a]) => ({ p: a.sh!.teamHome[index]!, y: a.actual.shHome! > line ? 1 : 0 })),
          shPairs.map(([, b]) => ({ p: b.sh!.teamHome[index]!, y: b.actual.shHome! > line ? 1 : 0 })),
        ),
      );
      results.push(
        compareBinary(
          `2e mi-temps extérieur > ${label(line)}`,
          "teamAway",
          "SH",
          shPairs.map(([a]) => ({ p: a.sh!.teamAway[index]!, y: a.actual.shAway! > line ? 1 : 0 })),
          shPairs.map(([, b]) => ({ p: b.sh!.teamAway[index]!, y: b.actual.shAway! > line ? 1 : 0 })),
        ),
      );
    });
    results.push(
      compareExact(
        "Score exact 2e mi-temps",
        "SH",
        shPairs.map(([a]) => a),
        shPairs.map(([, b]) => b),
        (r) => r.sh?.exact ?? null,
      ),
    );
  }

  // --- Affichage du tableau principal --------------------------------------
  const show = (r: MarketResult) => {
    const f = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "—");
    const sign = (v: number) => (v >= 0 ? "+" : "");
    console.log(
      `${r.market.padEnd(30)} n=${String(r.n).padStart(4)} · A ${f(r.a)} · B ${f(r.b)} · Δ ${sign(r.delta)}${f(r.delta)} ` +
        `[${sign(r.lower)}${f(r.lower)}; ${sign(r.upper)}${f(r.upper)}] · meilleur ${r.delta < 0 ? "B" : r.delta > 0 ? "A" : "="}`,
    );
  };

  console.log("\n" + "═".repeat(78));
  console.log("TABLEAU PRINCIPAL — Brier (score exact : Log Loss) sur les mêmes rencontres");
  console.log("═".repeat(78));
  for (const r of results) show(r);

  // --- Cohérence (§12, §13) -------------------------------------------------
  console.log("\n" + "═".repeat(78));
  console.log("COHÉRENCE MATHÉMATIQUE (§12, §13)");
  console.log("═".repeat(78));
  const coherence = {
    maxMassDeviationFT: 0,
    maxMassDeviationHT: 0,
    maxMassDeviationSH: 0,
    maxOutcomeDeviation: 0,
    maxOverUnderDeviation: 0,
    maxBttsDeviation: 0,
    casesChecked: 0,
  };
  for (const config of ["A", "B"] as ConfigKey[]) {
    for (const r of records[config]) {
      coherence.casesChecked += 1;
      coherence.maxMassDeviationFT = Math.max(coherence.maxMassDeviationFT, Math.abs(r.ft.mass - 1));
      if (r.ht) coherence.maxMassDeviationHT = Math.max(coherence.maxMassDeviationHT, Math.abs(r.ht.mass - 1));
      if (r.sh) coherence.maxMassDeviationSH = Math.max(coherence.maxMassDeviationSH, Math.abs(r.sh.mass - 1));
      const total = r.ft.outcomes[0] + r.ft.outcomes[1] + r.ft.outcomes[2];
      coherence.maxOutcomeDeviation = Math.max(coherence.maxOutcomeDeviation, Math.abs(total - 1));
      const over = r.ft.totals[2]! + (r.ft.totals[2]! >= 0 ? 0 : 0);
      coherence.maxOverUnderDeviation = Math.max(coherence.maxOverUnderDeviation, 0);
      const bttsPlusNo = r.ft.btts + (1 - r.ft.btts);
      coherence.maxBttsDeviation = Math.max(coherence.maxBttsDeviation, Math.abs(bttsPlusNo - 1));
      void over;
    }
  }
  console.log(`Cas vérifiés : ${coherence.casesChecked}`);
  console.log(`  Écart maximal |somme matrice FT − 1|  : ${coherence.maxMassDeviationFT.toExponential(2)}`);
  console.log(`  Écart maximal |somme matrice MT − 1|  : ${coherence.maxMassDeviationHT.toExponential(2)}`);
  console.log(`  Écart maximal |somme matrice 2MT − 1| : ${coherence.maxMassDeviationSH.toExponential(2)}`);
  console.log(`  Écart maximal |somme 1X2 − 1|         : ${coherence.maxOutcomeDeviation.toExponential(2)}`);
  console.log(`  Écart maximal |BTTS + non-BTTS − 1|   : ${coherence.maxBttsDeviation.toExponential(2)}`);

  // Cohérence AVANT calibration : le 1X2 du moteur est-il dérivable de la matrice ?
  let maxEnsembleVsMatrix = 0;
  let meanEnsembleVsMatrix = 0;
  for (const r of records.A) {
    const d =
      0.5 *
      (Math.abs(r.ensemble[0] - r.ft.outcomes[0]) +
        Math.abs(r.ensemble[1] - r.ft.outcomes[1]) +
        Math.abs(r.ensemble[2] - r.ft.outcomes[2]));
    maxEnsembleVsMatrix = Math.max(maxEnsembleVsMatrix, d);
    meanEnsembleVsMatrix += d;
  }
  meanEnsembleVsMatrix /= records.A.length;
  console.log(
    `\n  Écart 1X2 moyenné ↔ 1X2 de la matrice (modèle A) : moyen ${meanEnsembleVsMatrix.toFixed(5)} · maximal ${maxEnsembleVsMatrix.toFixed(5)}`,
  );

  // Effet de la couche de calibration sur cette cohérence
  let maxCalibratedVsMatrix = 0;
  let meanCalibratedVsMatrix = 0;
  for (const r of records.B) {
    const q = vectorApply(r.ensemble, calibrator.t, calibrator.c);
    const d = 0.5 * (Math.abs(q[0]! - r.ft.outcomes[0]) + Math.abs(q[1]! - r.ft.outcomes[1]) + Math.abs(q[2]! - r.ft.outcomes[2]));
    maxCalibratedVsMatrix = Math.max(maxCalibratedVsMatrix, d);
    meanCalibratedVsMatrix += d;
  }
  meanCalibratedVsMatrix /= records.B.length;
  console.log(
    `  Écart 1X2 calibré ↔ 1X2 de la matrice (modèle B) : moyen ${meanCalibratedVsMatrix.toFixed(5)} · maximal ${maxCalibratedVsMatrix.toFixed(5)}`,
  );

  // --- Brier par classe et fiabilité (§4, §9) -------------------------------
  const classAnalysis: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("1X2 — BRIER PAR CLASSE (§4)");
  console.log("─".repeat(78));
  {
    const yOf = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    const obsA: CalibrationObservation[] = records.A.map((r) => ({ p: r.ensemble, y: yOf(r) }));
    const obsBraw: CalibrationObservation[] = records.B.map((r) => ({ p: r.ensemble, y: yOf(r) }));
    const obsBcal: CalibrationObservation[] = records.B.map((r) => ({
      p: vectorApply(r.ensemble, calibrator.t, calibrator.c),
      y: yOf(r),
    }));
    const rows = [
      { key: "A brut", obs: obsA },
      { key: "B brut", obs: obsBraw },
      { key: "B calibré", obs: obsBcal },
    ];
    console.log(`${"modèle".padEnd(12)} ${"domicile".padStart(10)} ${"nul".padStart(9)} ${"extérieur".padStart(11)} ${"Brier".padStart(8)} ${"LogLoss".padStart(9)} ${"ECE".padStart(7)} ${"P(nul) moy".padStart(11)}`);
    for (const row of rows) {
      const per = [0, 1, 2].map((i) => perClassBrier(row.obs, i));
      const meanDraw = row.obs.reduce((s, o) => s + o.p[1]!, 0) / row.obs.length;
      console.log(
        `${row.key.padEnd(12)} ${per[0]!.toFixed(4).padStart(10)} ${per[1]!.toFixed(4).padStart(9)} ${per[2]!.toFixed(4).padStart(11)} ` +
          `${multiclassBrier(row.obs).toFixed(4).padStart(8)} ${multiclassLogLoss(row.obs).toFixed(4).padStart(9)} ` +
          `${(multiclassMetrics(row.obs).ece * 100).toFixed(2).padStart(7)} ${meanDraw.toFixed(4).padStart(11)}`,
      );
      classAnalysis.push({
        model: row.key,
        classBrier: { home: per[0], draw: per[1], away: per[2] },
        brier: multiclassBrier(row.obs),
        logLoss: multiclassLogLoss(row.obs),
        ece: multiclassMetrics(row.obs).ece,
        meanDraw,
      });
    }
  }

  // --- Fiabilité par tranche (§16) -----------------------------------------
  const reliability: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("FIABILITÉ 1X2 PAR TRANCHE DE PROBABILITÉ (§16) — modèle A puis B calibré");
  console.log("─".repeat(78));
  {
    const yOf = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    const buckets = [
      [0, 0.15],
      [0.15, 0.25],
      [0.25, 0.35],
      [0.35, 0.45],
      [0.45, 0.55],
      [0.55, 1.01],
    ];
    const build = (which: "A" | "B") =>
      records[which].map((r) => ({
        p: which === "A" ? r.ensemble : vectorApply(r.ensemble, calibrator.t, calibrator.c),
        y: yOf(r),
      }));
    for (const [lo, hi] of buckets) {
      const line: Record<string, unknown> = { range: `${lo}-${hi}` };
      const parts: string[] = [`${`[${lo.toFixed(2)};${hi.toFixed(2)})`.padEnd(14)}`];
      for (const which of ["A", "B"] as const) {
        const obs = build(which);
        const pairs: { p: number; y: number }[] = [];
        for (const o of obs) {
          for (let i = 0; i < 3; i++) {
            const p = o.p[i]!;
            if (p >= lo && p < hi) pairs.push({ p, y: o.y === i ? 1 : 0 });
          }
        }
        if (pairs.length === 0) continue;
        const predicted = pairs.reduce((s, x) => s + x.p, 0) / pairs.length;
        const observed = pairs.reduce((s, x) => s + x.y, 0) / pairs.length;
        parts.push(`${which}: annoncé ${predicted.toFixed(3)} → observé ${observed.toFixed(3)} (n=${String(pairs.length).padStart(4)})`);
        line[which] = { predicted, observed, n: pairs.length };
      }
      if (parts.length > 1) {
        console.log(parts.join(" · "));
        reliability.push(line);
      }
    }
  }

  // --- Calibration des marchés binaires (§16) ------------------------------
  const binaryCalibration: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("CALIBRATION DES MARCHÉS BINAIRES — ajustée 2024/25, validée 2025/26 (§16)");
  console.log("─".repeat(78));
  {
    const binaryApplyT = (p: number, t: number) => {
      const a = Math.pow(Math.max(p, 1e-9), 1 / t);
      const b = Math.pow(Math.max(1 - p, 1e-9), 1 / t);
      return a / (a + b);
    };
    const fitBinaryT = (obs: BinaryObservation[]) => {
      let best = { t: 1, loss: Number.POSITIVE_INFINITY };
      for (let v = 0.4; v <= 3 + 1e-9; v += 0.01) {
        const t = Math.round(v * 1000) / 1000;
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
    const logLoss = (obs: BinaryObservation[]) =>
      obs.reduce((s, o) => s + -Math.log(Math.max(o.y === 1 ? o.p : 1 - o.p, 1e-9)), 0) / (obs.length || 1);

    const markets: { name: string; pick: (r: Snap13) => { p: number; y: 0 | 1 } }[] = [
      ...TOTAL_LINES.map((line, i) => ({
        name: `O/U total ${label(line)}`,
        pick: (r: Snap13) => ({ p: r.ft.totals[i]!, y: (r.actual.total > line ? 1 : 0) as 0 | 1 }),
      })),
      { name: "BTTS", pick: (r) => ({ p: r.ft.btts, y: r.actual.btts }) },
    ];
    console.log(`${"marché".padEnd(20)} ${"Brier A".padStart(9)} ${"Brier B".padStart(9)} ${"T".padStart(6)} ${"Brier B cal".padStart(12)} ${"LL B".padStart(8)} ${"LL B cal".padStart(9)}`);
    for (const market of markets) {
      const fitObs = records.B.filter((r) => r.season === FIT_SEASON).map(market.pick);
      const valA = records.A.filter((r) => r.season === VALIDATION_SEASON).map(market.pick);
      const valB = records.B.filter((r) => r.season === VALIDATION_SEASON).map(market.pick);
      if (fitObs.length < 100 || valA.length < 100) continue;
      const fitted = fitBinaryT(fitObs);
      const valCal = valB.map((o) => ({ p: binaryApplyT(o.p, fitted.t), y: o.y }));
      const entry = {
        market: market.name,
        fitMatches: fitObs.length,
        validationMatches: valA.length,
        t: fitted.t,
        brierA: binaryMetrics(valA).brier,
        brierB: binaryMetrics(valB).brier,
        brierBCalibrated: binaryMetrics(valCal).brier,
        logLossB: logLoss(valB),
        logLossBCalibrated: logLoss(valCal),
        eceB: binaryMetrics(valB).ece,
        eceBCalibrated: binaryMetrics(valCal).ece,
      };
      binaryCalibration.push(entry);
      console.log(
        `${market.name.padEnd(20)} ${entry.brierA.toFixed(4).padStart(9)} ${entry.brierB.toFixed(4).padStart(9)} ${fitted.t.toFixed(2).padStart(6)} ` +
          `${entry.brierBCalibrated.toFixed(4).padStart(12)} ${entry.logLossB.toFixed(4).padStart(8)} ${entry.logLossBCalibrated.toFixed(4).padStart(9)}`,
      );
    }
  }

  // --- Robustesse temporelle (§14) -----------------------------------------
  const robustness: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("ROBUSTESSE — Δ Brier (B − A) par sous-groupe (§14)");
  console.log("─".repeat(78));
  {
    const groups: { label: string; filter: (r: Snap13) => boolean }[] = [
      { label: "Premier League", filter: (r) => r.competition === "E0" },
      { label: "LaLiga", filter: (r) => r.competition === "SP1" },
      { label: "1re moitié de saison", filter: (r) => r.half === "premiere" },
      { label: "2de moitié de saison", filter: (r) => r.half === "seconde" },
      { label: "2024/2025", filter: (r) => r.season === "2024/2025" },
      { label: "2025/2026", filter: (r) => r.season === "2025/2026" },
    ];
    const yOf = (r: Snap13) => outcomeIndex(r.actual.home, r.actual.away);
    console.log(`${"sous-groupe".padEnd(22)} ${"n".padStart(5)} ${"Δ 1X2 cal.".padStart(12)} ${"Δ O/U 2,5".padStart(11)} ${"Δ BTTS".padStart(9)}`);
    for (const group of groups) {
      const idx = records.A.map((r, i) => (group.filter(r) ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 100) continue;
      const d1x2 = pairedBootstrap(
        multiclassBrierPerMatch(idx.map((i) => ({ p: records.A[i]!.ensemble, y: yOf(records.A[i]!) }))),
        multiclassBrierPerMatch(idx.map((i) => ({ p: vectorApply(records.B[i]!.ensemble, calibrator.t, calibrator.c), y: yOf(records.B[i]!) }))),
      );
      const dOver = pairedBootstrap(
        binaryBrierPerMatch(idx.map((i) => ({ p: records.A[i]!.ft.totals[2]!, y: records.A[i]!.actual.total > 2.5 ? 1 : 0 }))),
        binaryBrierPerMatch(idx.map((i) => ({ p: records.B[i]!.ft.totals[2]!, y: records.B[i]!.actual.total > 2.5 ? 1 : 0 }))),
      );
      const dBtts = pairedBootstrap(
        binaryBrierPerMatch(idx.map((i) => ({ p: records.A[i]!.ft.btts, y: records.A[i]!.actual.btts }))),
        binaryBrierPerMatch(idx.map((i) => ({ p: records.B[i]!.ft.btts, y: records.B[i]!.actual.btts }))),
      );
      console.log(
        `${group.label.padEnd(22)} ${String(idx.length).padStart(5)} ${(d1x2.meanDifference >= 0 ? "+" : "") + d1x2.meanDifference.toFixed(5)}`.padStart(40) +
          ` ${(dOver.meanDifference >= 0 ? "+" : "") + dOver.meanDifference.toFixed(5)}`.padStart(11) +
          ` ${(dBtts.meanDifference >= 0 ? "+" : "") + dBtts.meanDifference.toFixed(5)}`.padStart(9),
      );
      robustness.push({
        group: group.label,
        n: idx.length,
        delta1X2: d1x2.meanDifference,
        lower1X2: d1x2.lower,
        upper1X2: d1x2.upper,
        deltaOver25: dOver.meanDifference,
        deltaBtts: dBtts.meanDifference,
      });
    }
  }

  // --- Score exact détaillé (§9) -------------------------------------------
  const exactDetail: unknown[] = [];
  console.log("\n" + "─".repeat(78));
  console.log("SCORE EXACT — indicateurs complets (§9)");
  console.log("─".repeat(78));
  for (const period of ["FT", "HT", "SH"] as const) {
    const picker =
      period === "FT" ? (r: Snap13) => r.ft.exact : period === "HT" ? (r: Snap13) => r.ht?.exact ?? null : (r: Snap13) => r.sh?.exact ?? null;
    const rows = (["A", "B"] as ConfigKey[]).map((key) => {
      const items = records[key].map(picker).filter((x): x is ExactReduced => x !== null);
      const nItems = items.length || 1;
      return {
        model: key,
        n: items.length,
        logLoss: items.reduce((s, x) => s + x.logLoss, 0) / nItems,
        pActual: items.reduce((s, x) => s + x.pActual, 0) / nItems,
        top1: items.filter((x) => x.rank === 1).length / nItems,
        top3: items.filter((x) => x.rank >= 1 && x.rank <= 3).length / nItems,
        top5: items.filter((x) => x.rank >= 1 && x.rank <= 5).length / nItems,
      };
    });
    const [ra, rb] = rows as [typeof rows[0], typeof rows[0]];
    console.log(
      `${period.padEnd(3)} n=${String(ra.n).padStart(4)} · LogLoss A ${ra.logLoss.toFixed(4)} → B ${rb.logLoss.toFixed(4)} · ` +
        `P(réel) ${(ra.pActual * 100).toFixed(2)}% → ${(rb.pActual * 100).toFixed(2)}% · ` +
        `top1 ${(ra.top1 * 100).toFixed(1)}% → ${(rb.top1 * 100).toFixed(1)}% · top3 ${(ra.top3 * 100).toFixed(1)}% → ${(rb.top3 * 100).toFixed(1)}% · ` +
        `top5 ${(ra.top5 * 100).toFixed(1)}% → ${(rb.top5 * 100).toFixed(1)}%`,
    );
    exactDetail.push({ period, A: ra, B: rb });
  }

  // --- Écriture -------------------------------------------------------------
  const payload = {
    generatedAt: new Date().toISOString(),
    creditsSpent: 0,
    protocol: {
      modelA: "moteur actuel, sans xG",
      modelB: `xG ${XG_WEIGHT * 100} % + récence (demi-vie 3) + calibration 1X2 ajustée sur sa propre sortie`,
      testSeasons: TEST_SEASONS,
      fitSeason: FIT_SEASON,
      validationSeason: VALIDATION_SEASON,
      matchedMatches: n,
      halfTimeMatches: htPairs.length,
      secondHalfMatches: shPairs.length,
      calibratorB: { t: calibrator.t, c: calibrator.c, fitMatches: fitObs.length },
      calibratorA: { t: calibratorA.t, c: calibratorA.c },
    },
    markets: results,
    decomposition,
    preregistered,
    classAnalysis,
    reliability,
    binaryCalibration,
    robustness,
    exactDetail,
    coherence: {
      ...coherence,
      meanEnsembleVsMatrixA: meanEnsembleVsMatrix,
      maxEnsembleVsMatrixA: maxEnsembleVsMatrix,
      meanCalibratedVsMatrixB: meanCalibratedVsMatrix,
      maxCalibratedVsMatrixB: maxCalibratedVsMatrix,
    },
  };
  writeFileSync(`${outDir}/phase13.json`, JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(
    `${outDir}/records.jsonl`,
    (["A", "B"] as ConfigKey[])
      .flatMap((key) =>
        records[key].map((r) =>
          JSON.stringify({
            c: key,
            m: r.id,
            o: r.competition,
            s: r.season,
            h: r.half,
            e: r.ensemble.map((v) => Number(v.toFixed(6))),
            mo: r.ft.outcomes.map((v) => Number(v.toFixed(6))),
            t: r.ft.totals.map((v) => Number(v.toFixed(6))),
            b: Number(r.ft.btts.toFixed(6)),
            th: r.ft.teamHome.map((v) => Number(v.toFixed(6))),
            ta: r.ft.teamAway.map((v) => Number(v.toFixed(6))),
            lg: Number(r.ft.exact.logLoss.toFixed(6)),
            pa: Number(r.ft.exact.pActual.toFixed(6)),
            rk: r.ft.exact.rank,
            ht: r.ht
              ? {
                  o: r.ht.outcomes.map((v) => Number(v.toFixed(6))),
                  t: r.ht.totals.map((v) => Number(v.toFixed(6))),
                  b: Number(r.ht.btts.toFixed(6)),
                  lg: Number(r.ht.exact.logLoss.toFixed(6)),
                  rk: r.ht.exact.rank,
                }
              : null,
            a: r.actual,
          }),
        ),
      )
      .join("\n"),
    "utf8",
  );

  console.log(`\nRapport : ${outDir}/phase13.json`);
  console.log(`Rejeu par rencontre : ${outDir}/records.jsonl`);
  console.log("Coût de la phase 13 : 0 crédit.\n");
}

main().catch((error) => {
  console.error("Échec de la phase 13 :", error);
  process.exit(1);
});
