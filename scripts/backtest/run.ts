/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Lanceur de backtest A/B
 * ============================================================================
 * Usage :
 *   npm run backtest                      → exécution complète
 *   npm run backtest -- --quick           → échantillon réduit (mise au point)
 *   npm run backtest -- --competitions E0
 *   npm run backtest -- --models A,B1_xg_all
 *
 * Protocole (§5, §6) :
 *   · validation TEMPORELLE — jamais de tirage aléatoire ;
 *   · l'historique disponible s'étend au fil du temps : chaque rencontre est
 *     prédite à partir des seules rencontres antérieures (fenêtre glissante) ;
 *   · les saisons de test sont postérieures à la période d'historique utilisée
 *     pour les paramètres globaux du moteur.
 *
 * §2 — Le pare-feu temporel (`context.ts`) est le seul point d'entrée des
 * données. §21 — Tout est écrit dans `data/backtests/<runId>/`. §22 — Même
 * graine, mêmes entrées, mêmes résultats.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { buildModelContext, xgModel } from "../../src/server/engine/models";
import type { MatchContext, MatchRecord, TeamSnapshot } from "../../src/server/engine/types";
import {
  COMPETITIONS,
  applyXg,
  featuresPath,
  loadCompetition,
  type BacktestMatch,
  type XgRecord,
} from "./dataset";
import { auditContextLeakage, buildBacktestContext } from "./context";
import { runPipeline, type MarketProbabilities } from "./pipeline";
import {
  VARIANTS,
  VARIANT_BY_ID,
  variantModel,
  type SignalVariant,
} from "./variants";
import {
  binaryBrierPerMatch,
  binaryMetrics,
  exactScoreMetrics,
  multiclassBrierPerMatch,
  multiclassMetrics,
  pairedBootstrap,
  type BinaryObservation,
  type ExactScoreObservation,
  type MarketMetrics,
  type MulticlassObservation,
} from "./metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Historique chargé : tout ce que la source gratuite publie pour ces ligues. */
const HISTORY_SEASONS = [
  "2015/2016", "2016/2017", "2017/2018", "2018/2019", "2019/2020", "2020/2021",
  "2021/2022", "2022/2023", "2023/2024", "2024/2025", "2025/2026",
];

/** Période d'évaluation — postérieure à la période d'historique. */
const DEFAULT_TEST_SEASONS = ["2023/2024", "2024/2025", "2025/2026"];

const BOOTSTRAP_SEED = 20260929;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function slugDate(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Applique les xG payants au contexte — SEUL écart autorisé entre A et B. */
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

interface ModelConfig {
  key: string;
  label: string;
  /** `null` = Modèle A (aucun signal xG). */
  variant: SignalVariant | null;
  /** Vrai si le modèle consomme des données payantes. */
  paid: boolean;
}

function buildConfigs(only: string[] | null): ModelConfig[] {
  const configs: ModelConfig[] = [
    { key: "A_sans_xg", label: "A — moteur actuel, sans xG (baseline)", variant: null, paid: false },
    { key: "B_engine", label: "B — moteur actuel + xG tel quel", variant: null, paid: true },
  ];
  for (const variant of VARIANTS) {
    configs.push({ key: variant.id, label: variant.label, variant, paid: variant.metric === "xg" });
  }
  return only ? configs.filter((c) => only.includes(c.key)) : configs;
}

// ---------------------------------------------------------------------------
// Observations par marché
// ---------------------------------------------------------------------------

interface MatchObservation {
  match: BacktestMatch;
  competition: string;
  season: string;
  /** Part de saison : « première » ou « seconde » moitié (robustesse §13). */
  halfOfSeason: string;
  outcomes: MulticlassObservation;
  totals: { line: number; obs: BinaryObservation }[];
  teamHome: { line: number; obs: BinaryObservation }[];
  teamAway: { line: number; obs: BinaryObservation }[];
  btts: BinaryObservation;
  exact: ExactScoreObservation;
  /** Marchés mi-temps — `null` si la source ne fournit pas le score HT (§9). */
  firstHalf: { line: number; obs: BinaryObservation }[] | null;
  firstHalfAtLeastOne: BinaryObservation | null;
  /** Poids du modèle xG dans le consensus : 0 = modèle inapplicable. */
  xgWeight: number;
}

function observe(probs: MarketProbabilities, match: BacktestMatch, halfOfSeason: string): MatchObservation {
  const totalGoals = match.homeGoals + match.awayGoals;
  const outcomeIndex = match.homeGoals > match.awayGoals ? 0 : match.homeGoals === match.awayGoals ? 1 : 2;

  const htAvailable = match.halfTimeHomeGoals !== null && match.halfTimeAwayGoals !== null;
  const htGoals = htAvailable ? match.halfTimeHomeGoals! + match.halfTimeAwayGoals! : 0;

  return {
    match,
    competition: match.competition,
    season: match.season,
    halfOfSeason,
    outcomes: { p: [probs.outcomes.home, probs.outcomes.draw, probs.outcomes.away], y: outcomeIndex },
    totals: probs.totals.map((t) => ({
      line: t.line,
      obs: { p: t.over, y: totalGoals > t.line ? 1 : 0 },
    })),
    teamHome: probs.teamGoals.home.map((t) => ({
      line: t.line,
      obs: { p: t.over, y: match.homeGoals > t.line ? 1 : 0 },
    })),
    teamAway: probs.teamGoals.away.map((t) => ({
      line: t.line,
      obs: { p: t.over, y: match.awayGoals > t.line ? 1 : 0 },
    })),
    btts: {
      p: probs.btts.yes,
      y: match.homeGoals > 0 && match.awayGoals > 0 ? 1 : 0,
    },
    exact: { matrix: probs.matrix, home: match.homeGoals, away: match.awayGoals },
    firstHalf: htAvailable
      ? probs.firstHalf.overUnder.map((t) => ({
          line: t.line,
          obs: { p: t.over, y: htGoals > t.line ? 1 : 0 },
        }))
      : null,
    firstHalfAtLeastOne: htAvailable ? { p: probs.firstHalf.probAtLeastOneGoal, y: htGoals > 0 ? 1 : 0 } : null,
    xgWeight: probs.xgWeight,
  };
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

export interface MarketSet {
  outcomes: MarketMetrics;
  totals: Record<string, MarketMetrics>;
  teamGoalsHome: Record<string, MarketMetrics>;
  teamGoalsAway: Record<string, MarketMetrics>;
  btts: MarketMetrics;
  exactScore: ReturnType<typeof exactScoreMetrics>;
  firstHalfTotals: Record<string, MarketMetrics> | null;
  firstHalfAtLeastOne: MarketMetrics | null;
}

function scopeKey(match: BacktestMatch, scope: "global" | "competition" | "season" | "half"): string {
  switch (scope) {
    case "global":
      return "global";
    case "competition":
      return match.competition;
    case "season":
      return match.season;
    default:
      return `${match.season}:${match.homeGoals + match.awayGoals >= 3 ? "prolifique" : "sobre"}`;
  }
}

function computeMarketSet(observations: MatchObservation[]): MarketSet {
  const lines = ["0.5", "1.5", "2.5", "3.5", "4.5"];
  const teamLines = ["0.5", "1.5", "2.5"];
  const firstHalfObs = observations.filter((o) => o.firstHalf !== null);

  return {
    outcomes: multiclassMetrics(observations.map((o) => o.outcomes)),
    totals: Object.fromEntries(
      lines.map((line) => [
        line,
        binaryMetrics(observations.flatMap((o) => o.totals.filter((t) => String(t.line) === line).map((t) => t.obs))),
      ]),
    ),
    teamGoalsHome: Object.fromEntries(
      teamLines.map((line) => [
        line,
        binaryMetrics(observations.flatMap((o) => o.teamHome.filter((t) => String(t.line) === line).map((t) => t.obs))),
      ]),
    ),
    teamGoalsAway: Object.fromEntries(
      teamLines.map((line) => [
        line,
        binaryMetrics(observations.flatMap((o) => o.teamAway.filter((t) => String(t.line) === line).map((t) => t.obs))),
      ]),
    ),
    btts: binaryMetrics(observations.map((o) => o.btts)),
    exactScore: exactScoreMetrics(observations.map((o) => o.exact)),
    firstHalfTotals:
      firstHalfObs.length === 0
        ? null
        : Object.fromEntries(
            ["0.5", "1.5", "2.5"].map((line) => [
              line,
              binaryMetrics(
                firstHalfObs.flatMap((o) => o.firstHalf!.filter((t) => String(t.line) === line).map((t) => t.obs)),
              ),
            ]),
          ),
    firstHalfAtLeastOne:
      firstHalfObs.length === 0
        ? null
        : binaryMetrics(firstHalfObs.map((o) => o.firstHalfAtLeastOne!)),
  };
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

async function main() {
  const quick = hasFlag("--quick");
  const onlyCompetitions = argValue("--competitions")?.split(",") ?? ["E0", "SP1"];
  const testSeasons = argValue("--test-seasons")?.split(",") ?? DEFAULT_TEST_SEASONS;
  const requested = buildConfigs(argValue("--models")?.split(",") ?? null);

  const competitions = Object.keys(COMPETITIONS).filter((c) => onlyCompetitions.includes(c));
  const runId = `${slugDate()}-backtest-phase11`;
  const outDir = `data/backtests/${runId}`;
  mkdirSync(outDir, { recursive: true });

  console.log("☀️  SOLEIL — backtest A/B (phase 11)");
  console.log("═".repeat(78));
  console.log(`Historique      : ${HISTORY_SEASONS[0]} → ${HISTORY_SEASONS.at(-1)}`);
  console.log(`Saisons de test : ${testSeasons.join(", ")}`);
  console.log(`Compétitions    : ${competitions.join(", ")}`);
  console.log(`Modèles         : ${requested.length} demandés`);
  console.log(`Mode            : ${quick ? "RAPIDE (échantillon réduit)" : "complet"}`);

  // --- Chargement des datasets (gratuit) ---
  const datasetHashes: Record<string, string> = {};
  const all: BacktestMatch[] = [];

  for (const competition of competitions) {
    const matches = await loadCompetition(competition, HISTORY_SEASONS);
    all.push(...matches);

    const file = `data/normalized/fdcouk/${competition}/${"2025-2026"}.json`;
    if (existsSync(file)) datasetHashes[competition] = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
    console.log(`   ${competition} : ${matches.length} rencontres chargées (${COMPETITIONS[competition]!.name})`);
  }

  // xG payant déjà collecté — jamais inventé, jamais deviné. On parcourt toutes
  // les saisons chargées : le xG peut n'avoir été payé que sur certaines d'entre
  // elles, et c'est cette couverture réelle qui décide de l'évaluabilité.
  const xgLookup = new Map<string, XgRecord>();
  for (const competition of competitions) {
    for (const season of HISTORY_SEASONS) {
      const path = featuresPath(competition, season);
      if (!existsSync(path)) continue;
      const payload = JSON.parse(readFileSync(path, "utf8")) as { records: XgRecord[] };
      for (const record of payload.records) xgLookup.set(record.matchId, record);
      const withXg = payload.records.filter((r) => r.homeXg !== null && r.awayXg !== null).length;
      console.log(`   xG ${competition} ${season} : ${withXg}/${payload.records.length} rencontres enrichies`);
    }
  }
  const coveredMatches = applyXg(all, xgLookup);
  const xgAvailable = coveredMatches > 0;
  console.log(`\nRencontres portant des xG : ${coveredMatches}`);
  if (!xgAvailable) {
    console.log("\n   ⚠️  Aucun xG en base : les variantes consommant du xG ne sont PAS évaluables.");
    console.log("       Elles sont écartées au lieu d'être affichées comme égales au Modèle A —");
    console.log("       un modèle inapplicable n'est pas un modèle mesuré.");
    console.log("       Restent évalués : Modèle A + les contrôles gratuits (tirs, tirs cadrés).");
  }

  const configs = xgAvailable ? requested : requested.filter((c) => !c.paid);

  // --- Périmètre de test ---
  let testMatches = all.filter((m) => testSeasons.includes(m.season));
  testMatches.sort((a, b) => a.date.getTime() - b.date.getTime());
  if (quick) testMatches = testMatches.filter((_, i) => i % 12 === 0);

  console.log(`\nRencontres de test : ${testMatches.length}`);

  // --- Boucle d'évaluation ---
  const observationsByModel = new Map<string, MatchObservation[]>();
  const failures: { model: string; matchId: string; error: string }[] = [];
  const leakageSample: string[] = [];
  let auditCount = 0;

  for (const config of configs) {
    observationsByModel.set(config.key, []);
  }

  // Matchday approché : rang de la rencontre dans sa saison.
  const rankingBySeason = new Map<string, Map<string, number>>();
  for (const match of testMatches) {
    const key = `${match.competition}:${match.season}`;
    if (!rankingBySeason.has(key)) {
      const ordered = all
        .filter((m) => m.competition === match.competition && m.season === match.season)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      rankingBySeason.set(key, new Map(ordered.map((m, index) => [m.id, index])));
    }
  }

  let processed = 0;
  for (const match of testMatches) {
    const rank = rankingBySeason.get(`${match.competition}:${match.season}`)!.get(match.id) ?? 0;
    const seasonLength = rankingBySeason.get(`${match.competition}:${match.season}`)!.size || 380;
    const halfOfSeason = rank < seasonLength / 2 ? "premiere" : "seconde";

    let baseContext: MatchContext;
    try {
      baseContext = buildBacktestContext(match, all, { leagueName: COMPETITIONS[match.competition]!.name });
    } catch (error) {
      failures.push({ model: "*", matchId: match.id, error: `contexte : ${(error as Error).message}` });
      continue;
    }

    // Audit anti-fuite sur un échantillon borné (les tests couvrent le reste).
    if (auditCount < 120 && processed % 17 === 0) {
      auditCount += 1;
      const findings = auditContextLeakage(baseContext, all);
      if (findings.length > 0) leakageSample.push(`${match.id}: ${findings[0]!.detail}`);
    }

    const xgContext = withXg(baseContext, xgLookup);

    for (const config of configs) {
      try {
        const xgVariant =
          config.key === "B_engine"
            ? (ctx: ReturnType<typeof buildModelContext>) => xgModel(ctx)
            : config.variant
              ? (ctx: ReturnType<typeof buildModelContext>) => variantModel(ctx, config.variant!)
              : null;

        const context = config.paid ? xgContext : baseContext;
        const probs = runPipeline(context, xgVariant ? { xgVariant } : {});
        observationsByModel.get(config.key)!.push(observe(probs, match, halfOfSeason));
      } catch (error) {
        failures.push({ model: config.key, matchId: match.id, error: (error as Error).message });
      }
    }

    processed += 1;
    if (processed % 200 === 0) console.log(`   … ${processed}/${testMatches.length} rencontres évaluées`);
  }

  console.log(`\nRencontres évaluées : ${processed}`);
  if (leakageSample.length > 0) {
    console.log(`⚠️  ${leakageSample.length} fuites détectées — voir le rapport.`);
  } else {
    console.log(`Audit anti-fuite : ${auditCount} contextes vérifiés, aucune fuite.`);
  }
  if (failures.length > 0) console.log(`⚠️  ${failures.length} échecs d'exécution.`);

  // --- Métriques ---
  const results: Record<string, unknown> = {};
  const perModelObservations = new Map<string, MatchObservation[]>();

  for (const config of configs) {
    const observations = observationsByModel.get(config.key)!;
    // Un modèle inapplicable (xG absent) produit autant d'observations que les
    // autres : on ne le signale pas comme erreur, on l'identifie comme tel.
    perModelObservations.set(config.key, observations);

    const byCompetition = Object.fromEntries(
      competitions.map((c) => [
        c,
        computeMarketSet(observations.filter((o) => o.competition === c)),
      ]),
    );
    const bySeason = Object.fromEntries(
      testSeasons.map((s) => [s, computeMarketSet(observations.filter((o) => o.season === s))]),
    );

    results[config.key] = {
      label: config.label,
      paid: config.paid,
      matches: observations.length,
      global: computeMarketSet(observations),
      byCompetition,
      bySeason,
    };
  }

  // --- Référence de marché (cotes de clôture dé-marginalisées, gratuites) ---
  // Elle ne sert PAS d'entrée au modèle : elle donne l'échelle du terrain. Un
  // Brier de 0,59 se juge différemment selon que le marché est à 0,58 ou 0,52.
  const withOdds = testMatches.filter((m) => m.closingOdds !== null);
  const marketBenchmark =
    withOdds.length === 0
      ? null
      : {
          matches: withOdds.length,
          outcomes: multiclassMetrics(
            withOdds.map((m) => {
              const odds = m.closingOdds!;
              const index = m.homeGoals > m.awayGoals ? 0 : m.homeGoals === m.awayGoals ? 1 : 2;
              return { p: [odds.home, odds.draw, odds.away], y: index };
            }),
          ),
        };

  // --- Sous-ensemble « xG réellement actif » ---------------------------------
  // Sur les rencontres où le modèle xG est inapplicable (pas assez de xG dans
  // l'historique), le Modèle B est IDENTIQUE au Modèle A. Les inclure dans la
  // comparaison dilue mécaniquement l'effet mesuré vers zéro. On publie donc
  // les deux périmètres : toutes rencontres (réalité de production) et
  // sous-ensemble où le signal a pu agir (isole le mécanisme).
  const eligibleIndexes = (candidate: MatchObservation[]): number[] =>
    candidate.map((o, index) => (o.xgWeight > 0 ? index : -1)).filter((i) => i >= 0);

  for (const config of configs) {
    if (config.key === "A_sans_xg") continue;
    const candidate = perModelObservations.get(config.key)!;
    const indexes = eligibleIndexes(candidate);
    if (indexes.length === 0) {
      (results[config.key] as Record<string, unknown>).eligibleSubset = null;
      continue;
    }
    (results[config.key] as Record<string, unknown>).eligibleSubset = {
      matches: indexes.length,
      global: computeMarketSet(indexes.map((i) => candidate[i]!)),
      byCompetition: Object.fromEntries(
        competitions.map((c) => [c, computeMarketSet(indexes.map((i) => candidate[i]!).filter((o) => o.competition === c))]),
      ),
    };
  }

  // --- Robustesse : A contre chaque variante ---
  const baseline = perModelObservations.get("A_sans_xg") ?? [];
  const robustness: Record<string, unknown> = {};
  for (const config of configs) {
    if (config.key === "A_sans_xg") continue;
    const candidate = perModelObservations.get(config.key)!;
    if (candidate.length !== baseline.length || baseline.length === 0) {
      robustness[config.key] = { evaluable: false, reason: "effectifs différents" };
      continue;
    }

    const perMarket = {
      "1X2": pairedBootstrap(multiclassBrierPerMatch(baseline.map((o) => o.outcomes)), multiclassBrierPerMatch(candidate.map((o) => o.outcomes))),
      "Over/Under 2.5": pairedBootstrap(
        binaryBrierPerMatch(baseline.flatMap((o) => o.totals.filter((t) => t.line === 2.5).map((t) => t.obs))),
        binaryBrierPerMatch(candidate.flatMap((o) => o.totals.filter((t) => t.line === 2.5).map((t) => t.obs))),
      ),
      BTTS: pairedBootstrap(binaryBrierPerMatch(baseline.map((o) => o.btts)), binaryBrierPerMatch(candidate.map((o) => o.btts))),
    };

    // Cohérence par compétition : le signe du gain doit être le même.
    const byCompetition: Record<string, number> = {};
    for (const competition of competitions) {
      const a = baseline.filter((o) => o.competition === competition);
      const b = candidate.filter((o) => o.competition === competition);
      if (a.length === 0 || a.length !== b.length) continue;
      const brierA = multiclassBrierPerMatch(a.map((o) => o.outcomes));
      const brierB = multiclassBrierPerMatch(b.map((o) => o.outcomes));
      byCompetition[competition] =
        brierB.reduce((x, y) => x + y, 0) / brierB.length - brierA.reduce((x, y) => x + y, 0) / brierA.length;
    }

    // Cohérence par période : première contre seconde moitié de saison.
    const byPeriod: Record<string, number> = {};
    for (const half of ["premiere", "seconde"]) {
      const a = baseline.filter((o) => o.halfOfSeason === half);
      const b = candidate.filter((o) => o.halfOfSeason === half);
      if (a.length === 0 || a.length !== b.length) continue;
      const brierA = multiclassBrierPerMatch(a.map((o) => o.outcomes));
      const brierB = multiclassBrierPerMatch(b.map((o) => o.outcomes));
      byPeriod[half] =
        brierB.reduce((x, y) => x + y, 0) / brierB.length - brierA.reduce((x, y) => x + y, 0) / brierA.length;
    }

    // Même calcul, restreint aux rencontres où le xG a pu agir.
    const eligible = eligibleIndexes(candidate);
    const aEligible = eligible.map((i) => baseline[i]!);
    const bEligible = eligible.map((i) => candidate[i]!);
    const perMarketEligible =
      eligible.length === 0
        ? null
        : {
            matches: eligible.length,
            "1X2": pairedBootstrap(
              multiclassBrierPerMatch(aEligible.map((o) => o.outcomes)),
              multiclassBrierPerMatch(bEligible.map((o) => o.outcomes)),
            ),
            "Over/Under 2.5": pairedBootstrap(
              binaryBrierPerMatch(aEligible.flatMap((o) => o.totals.filter((t) => t.line === 2.5).map((t) => t.obs))),
              binaryBrierPerMatch(bEligible.flatMap((o) => o.totals.filter((t) => t.line === 2.5).map((t) => t.obs))),
            ),
            BTTS: pairedBootstrap(
              binaryBrierPerMatch(aEligible.map((o) => o.btts)),
              binaryBrierPerMatch(bEligible.map((o) => o.btts)),
            ),
            byPeriod: Object.fromEntries(
              ["premiere", "seconde"].flatMap((half) => {
                const aHalf = aEligible.filter((o) => o.halfOfSeason === half);
                const bHalf = bEligible.filter((o) => o.halfOfSeason === half);
                if (aHalf.length < 30 || aHalf.length !== bHalf.length) return [];
                return [
                  [
                    half,
                    pairedBootstrap(
                      multiclassBrierPerMatch(aHalf.map((o) => o.outcomes)),
                      multiclassBrierPerMatch(bHalf.map((o) => o.outcomes)),
                    ),
                  ],
                ];
              }),
            ),
            bySeason: Object.fromEntries(
              testSeasons.flatMap((season) => {
                const aSeason = aEligible.filter((o) => o.season === season);
                const bSeason = bEligible.filter((o) => o.season === season);
                if (aSeason.length < 30 || aSeason.length !== bSeason.length) return [];
                return [
                  [
                    season,
                    pairedBootstrap(
                      multiclassBrierPerMatch(aSeason.map((o) => o.outcomes)),
                      multiclassBrierPerMatch(bSeason.map((o) => o.outcomes)),
                    ),
                  ],
                ];
              }),
            ),
          };

    robustness[config.key] = { evaluable: true, perMarket, perMarketEligible, byCompetition, byPeriod };
  }

  // --- Manifeste (§22) ---
  const manifest = {
    runId,
    generatedAt: new Date().toISOString(),
    phase: "11 — backtest A/B xG",
    protocol: {
      validation: "temporelle (fenêtre glissante), aucun tirage aléatoire",
      historySeasons: HISTORY_SEASONS,
      testSeasons,
      competitions,
      bootstrapSeed: BOOTSTRAP_SEED,
      bootstrapIterations: 2000,
    },
    dataset: {
      source: "football-data.co.uk (gratuit)",
      xgSource: xgAvailable ? "LiveFootballApi (payant)" : "aucun — xG indisponible",
      matchesTested: processed,
      hashes: datasetHashes,
    },
    models: configs.map((c) => ({ key: c.key, label: c.label, paid: c.paid })),
    integrity: {
      leakageAudited: auditCount,
      leakageFindings: leakageSample.length,
      executionFailures: failures.length,
      marketBenchmarkMatches: marketBenchmark?.matches ?? 0,
    },
  };

  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  writeFileSync(
    `${outDir}/metrics.json`,
    JSON.stringify({ marketBenchmark, models: results }, null, 2),
  );
  writeFileSync(`${outDir}/robustness.json`, JSON.stringify(robustness, null, 2));

  // Rejeu exact (§22) : un fichier de prédictions par rencontre et par modèle.
  const predictionLines: string[] = [];
  for (const config of configs) {
    for (const observation of perModelObservations.get(config.key)!) {
      predictionLines.push(
        JSON.stringify({
          model: config.key,
          matchId: observation.match.id,
          date: observation.match.date.toISOString().slice(0, 10),
          competition: observation.competition,
          season: observation.season,
          p1x2: observation.outcomes.p,
          actual: observation.outcomes.y,
          pOver25: observation.totals.find((t) => t.line === 2.5)?.obs.p ?? null,
          totals: Object.fromEntries(observation.totals.map((t) => [String(t.line), t.obs.p])),
          teamHome: Object.fromEntries(observation.teamHome.map((t) => [String(t.line), t.obs.p])),
          teamAway: Object.fromEntries(observation.teamAway.map((t) => [String(t.line), t.obs.p])),
          firstHalf: observation.firstHalf ? Object.fromEntries(observation.firstHalf.map((t) => [String(t.line), t.obs.p])) : null,
          firstHalfAtLeastOne: observation.firstHalfAtLeastOne?.p ?? null,
          actualTotal: observation.match.homeGoals + observation.match.awayGoals,
          actualHome: observation.match.homeGoals,
          actualAway: observation.match.awayGoals,
          actualBtts: observation.match.homeGoals > 0 && observation.match.awayGoals > 0 ? 1 : 0,
          actualHt: observation.match.halfTimeHomeGoals !== null ? observation.match.halfTimeHomeGoals + observation.match.halfTimeAwayGoals! : null,
          pBtts: observation.btts.p,
          pActualScore: observation.exact.matrix[Math.min(observation.match.homeGoals, 10)]?.[Math.min(observation.match.awayGoals, 10)] ?? null,
          xgWeight: observation.xgWeight,
        }),
      );
    }
  }
  writeFileSync(`${outDir}/predictions.jsonl`, predictionLines.join("\n"));
  if (failures.length > 0) writeFileSync(`${outDir}/failures.json`, JSON.stringify(failures, null, 2));
  if (leakageSample.length > 0) writeFileSync(`${outDir}/leakage.json`, JSON.stringify(leakageSample, null, 2));

  // --- Affichage ---
  const n = (v: number) => v.toFixed(4);
  console.log("\n" + "═".repeat(78));
  console.log("SYNTHÈSE — toutes rencontres de test");
  console.log("═".repeat(78));
  console.log(
    "Modèle".padEnd(34) + "n".padStart(6) + "Brier 1X2".padStart(12) + "LogLoss 1X2".padStart(14) + "ECE".padStart(9) + "O/U2.5".padStart(10) + "BTTS".padStart(9),
  );
  for (const config of configs) {
    const global = (results[config.key] as { global: MarketSet; matches: number }).global;
    console.log(
      config.key.padEnd(34) +
        String((results[config.key] as { matches: number }).matches).padStart(6) +
        n(global.outcomes.brier).padStart(12) +
        n(global.outcomes.logLoss).padStart(14) +
        n(global.outcomes.ece).padStart(9) +
        n(global.totals["2.5"]!.brier).padStart(10) +
        n(global.btts.brier).padStart(9),
    );
  }
  if (marketBenchmark) {
    console.log(
      `\nRéférence marché (cotes de clôture, ${marketBenchmark.matches} rencontres) : ` +
        `Brier 1X2 ${marketBenchmark.outcomes.brier.toFixed(4)} · LogLoss ${marketBenchmark.outcomes.logLoss.toFixed(4)}`,
    );
  }
  console.log(`\nRapport : ${outDir}/`);
}

main().catch((error) => {
  console.error("\n❌ Backtest interrompu :", error);
  process.exitCode = 1;
});
