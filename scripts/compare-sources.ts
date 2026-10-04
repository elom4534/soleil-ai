/**
 * ============================================================================
 * SOLEIL — Comparaison des sources de données
 * ============================================================================
 * Compare, pour les MÊMES matchs, la source historique (football-data.co.uk) et
 * la nouvelle source (API Football Live / LiveFootballApi).
 *
 * Règles de la phase 10 respectées :
 *   · aucun import massif — lecture seule, aucune écriture dans les tables métier ;
 *   · aucune source n'est supposée correcte : toute divergence est rapportée ;
 *   · un match n'est JAMAIS fusionné parce que les noms se ressemblent : la
 *     correspondance exige la date, et se fait confirmer par les équipes, la
 *     compétition et le score ;
 *   · une donnée absente reste absente (`null`), jamais zéro.
 *
 * Usage :
 *   npm run compare                       → comparaison complète
 *   npm run compare -- --leagues E0,SP1   → limiter les compétitions
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import { ApiFootballLiveClient } from "../src/server/data/providers/apiFootballLive/client";
import { getCompetitionFixtures, type NormalizedMatch } from "../src/server/data/providers/apiFootballLive/adapter";
import { resolvePreset } from "../src/server/data/providers/apiFootballLive/presets";
import { footballDataCoUkProvider } from "../src/server/data/providers/footballDataCoUk";
import type { NormalizedFixture } from "../src/server/data/providers/types";
import { prisma } from "../src/lib/prisma";

// ---------------------------------------------------------------------------
// Compétitions comparées : identifiant SOLEIL ↔ identifiant fournisseur
// ---------------------------------------------------------------------------

interface Pair {
  /** Code football-data.co.uk. */
  code: string;
  /** Identifiant LiveFootballApi. */
  lfaId: string;
  label: string;
  country: string;
}

const PAIRS: Pair[] = [
  { code: "E0", lfaId: "2kwbbcootiqqgmrzs6o5inle5", label: "Premier League", country: "England" },
  { code: "SP1", lfaId: "34pl8szyvrbwcmfkuocjm3r6t", label: "LaLiga", country: "Spain" },
];

/**
 * Compétitions africaines : aucun équivalent chez football-data.co.uk.
 * Elles sont mesurées en complétude (source unique) et non en cohérence —
 * prétendre comparer ce qui n'a pas de second témoin serait malhonnête.
 */
const AFRICAN: { lfaId: string; label: string; season: string }[] = [
  { lfaId: "8t1t0tyumnnz6q87rvqqnnaw6", label: "Togo — National Championship", season: "2025/2026" },
  { lfaId: "4jg7he1n3rb5dniq6hf49xorq", label: "Ghana — Premier League", season: "2026/2027" },
];

const SEASON = "2025/2026";
const SEASON_LABEL = "2025/2026";

// ---------------------------------------------------------------------------
// Appariement des noms d'équipes, appariement canonique, divergences
// → module partagé `scripts/lib/source-matching.ts` (même logique pour tous
//   les scripts de comparaison de la phase 10).
// ---------------------------------------------------------------------------

import {
  findDivergences,
  matchSources,
  normalizeTeamName,
  type CanonicalMatch,
  type Divergence,
} from "./lib/source-matching";

// ---------------------------------------------------------------------------
// Qualité des sources
// ---------------------------------------------------------------------------

interface QualityReport {
  source: string;
  matches: number;
  /** % de champs renseignés parmi les champs attendus. */
  completeness: number;
  /** % de valeurs cohérentes avec l'autre source, parmi les valeurs comparables. */
  coherence: number | null;
  comparables: number;
  divergences: number;
  freshnessHours: number | null;
  freshnessNote: string;
  stability: string;
}

function completenessOf(fixtures: (NormalizedFixture | NormalizedMatch)[], source: "A" | "B"): number {
  if (fixtures.length === 0) return 0;
  let filled = 0;
  let total = 0;

  for (const fixture of fixtures) {
    if (source === "A") {
      const f = fixture as NormalizedFixture;
      const fields = [
        f.utcDate, f.homeTeamName, f.awayTeamName, f.homeScore, f.awayScore,
        f.halfTimeHomeScore, f.halfTimeAwayScore,
      ];
      total += fields.length;
      filled += fields.filter((v) => v !== null && v !== undefined && v !== "").length;
    } else {
      const m = fixture as NormalizedMatch;
      const fields = [
        m.date, m.home.name, m.away.name, m.finalScore?.home ?? null, m.finalScore?.away ?? null,
        m.halftime.home, m.halftime.away, m.competition.providerId, m.home.logo, m.away.logo,
      ];
      total += fields.length;
      filled += fields.filter((v) => v !== null && v !== undefined && v !== "").length;
    }
  }

  return total === 0 ? 0 : Math.round((filled / total) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--leagues")
    ? argv[argv.indexOf("--leagues") + 1]?.split(",")
    : undefined;
  const pairs = only ? PAIRS.filter((p) => only.includes(p.code)) : PAIRS;

  const client = new ApiFootballLiveClient(resolvePreset("live-football-api"), {
    globalDailyBudget: 40,
  });
  await client.init();

  console.log("☀️  SOLEIL — comparaison des sources");
  console.log("═".repeat(78));
  console.log(`Compétitions comparées : ${pairs.map((p) => p.label).join(", ")}`);
  console.log(`Saison : ${SEASON_LABEL}`);
  console.log("Aucune écriture en base métier — lecture seule.");
  console.log("═".repeat(78));

  const allMatched: CanonicalMatch[] = [];
  const allDivergences: Divergence[] = [];
  const quality: QualityReport[] = [];
  let creditsSpent = 0;

  for (const pair of pairs) {
    console.log(`\n■ ${pair.label} (${pair.country}) — saison ${SEASON_LABEL}`);

    // Source A : football-data.co.uk (gratuit).
    const a = await footballDataCoUkProvider.fetchCompetition({
      competitionCode: pair.code,
      season: SEASON,
    });
    console.log(`   football-data.co.uk : ${a.data.length} rencontres`);

    // Source B : LiveFootballApi (1 crédit pour la saison entière).
    const b = await getCompetitionFixtures(client, pair.lfaId, SEASON);
    creditsSpent += b.creditsSpent;
    console.log(
      `   LiveFootballApi     : ${b.data.matches.length} rencontres (${b.creditsSpent} crédit, saison « ${b.data.season ?? "?"} »)`,
    );

    const outcome = matchSources(a.data, b.data.matches, pair.label);
    const divergences = findDivergences(outcome.matched);

    console.log(`   appariées           : ${outcome.matched.length}`);
    console.log(`   non appariées (LFA) : ${outcome.onlySourceB.length}`);
    console.log(`   ambiguës            : ${outcome.ambiguous.length}`);
    console.log(`   divergences         : ${divergences.length}`);

    // Cohérence : sur les valeurs présentes des deux côtés, part d'accord.
    let comparables = 0;
    for (const pair2 of outcome.matched) {
      const fa = pair2.fdcouk;
      const fb = pair2.lfa;
      if (!fa || !fb) continue;
      const checks: [number | null, number | null][] = [
        [fa.homeScore, fb.finalScore?.home ?? null],
        [fa.awayScore, fb.finalScore?.away ?? null],
        [fa.halfTimeHomeScore, fb.halftime.home],
        [fa.halfTimeAwayScore, fb.halftime.away],
      ];
      for (const [va, vb] of checks) if (va !== null && vb !== null) comparables += 1;
      comparables += 4; // date, domicile, extérieur, compétition : vérifiés par l'appariement
    }

    const divergencesComparables = divergences.filter((d) => d.field.includes("score") || d.field.includes("mi-temps")).length;
    quality.push({
      source: "football-data.co.uk",
      matches: a.data.length,
      completeness: completenessOf(a.data, "A"),
      coherence: comparables === 0 ? null : Math.round(((comparables - divergencesComparables) / comparables) * 1000) / 10,
      comparables,
      divergences: divergences.length,
      freshnessHours: null,
      freshnessNote: "Fichier de saison statique : pas d'horodatage de publication fourni",
      stability: "Non mesurée — exige deux relevés dans le temps (protocole défini)",
    });

    quality.push({
      source: "LiveFootballApi",
      matches: b.data.matches.length,
      completeness: completenessOf(b.data.matches, "B"),
      coherence: comparables === 0 ? null : Math.round(((comparables - divergencesComparables) / comparables) * 1000) / 10,
      comparables,
      divergences: divergences.length,
      freshnessHours: null,
      freshnessNote: "Réponse horodatée par le fournisseur (`timestamp`) ; champ `stale` exposé",
      stability: "Non mesurée — la structure `last_updated` + `stale` permet le suivi",
    });

    allMatched.push(...outcome.matched);
    allDivergences.push(...divergences);
  }

  // --- Compétitions africaines : complétude seule ---
  console.log("\n■ Compétitions africaines (source unique — complétude seulement)");
  const africanReports: { label: string; matches: number; completeness: number; halfTime: number; xg: boolean }[] = [];
  for (const african of AFRICAN) {
    const result = await getCompetitionFixtures(client, african.lfaId, african.season);
    creditsSpent += result.creditsSpent;
    const matches = result.data.matches;
    const halfTimeFilled = matches.filter((m) => m.halftime.home !== null).length;
    africanReports.push({
      label: african.label,
      matches: matches.length,
      completeness: completenessOf(matches, "B"),
      halfTime: matches.length === 0 ? 0 : Math.round((halfTimeFilled / matches.length) * 1000) / 10,
      xg: false,
    });
    console.log(
      `   ${african.label.padEnd(32)} ${matches.length} rencontres · complétude ${africanReports.at(-1)!.completeness} % · mi-temps ${africanReports.at(-1)!.halfTime} % (${result.creditsSpent} crédit)`,
    );
  }

  // --- Agrégation des métriques de qualité par source (et non par compétition) ---
  // Le Source Quality Score porte sur les axes MESURÉS. Fraîcheur et stabilité
  // exigent deux relevés espacés dans le temps : elles ne sont pas inventées,
  // elles sont déclarées non mesurées avec le protocole prévu.
  function aggregateQuality(rows: typeof quality) {
    const bySource = new Map<string, typeof quality>();
    for (const row of rows) {
      const list = bySource.get(row.source) ?? [];
      list.push(row);
      bySource.set(row.source, list);
    }
    return [...bySource.entries()].map(([source, list]) => {
      const merged = {
        source,
        matches: list.reduce((sum, r) => sum + r.matches, 0),
        completeness: Math.round((list.reduce((sum, r) => sum + r.completeness, 0) / list.length) * 10) / 10,
        coherence: Math.round((list.reduce((sum, r) => sum + (r.coherence ?? 0), 0) / list.length) * 10) / 10,
        comparables: list.reduce((sum, r) => sum + r.comparables, 0),
        divergences: list.reduce((sum, r) => sum + r.divergences, 0),
        freshnessHours: null as number | null,
        freshnessNote: list[0]!.freshnessNote,
        stability: list[0]!.stability,
      };
      // Score = moyenne des axes mesurés (complétude, cohérence). Les deux axes
      // non mesurés sont exclus du calcul au lieu d'être estimés.
      const score = Math.round(((merged.completeness + merged.coherence) / 2) * 10) / 10;
      return { ...merged, sourceQualityScore: score, scoreAxes: "complétude + cohérence (2 axes sur 4 mesurés)" };
    });
  }

  // --- Rapport ---
  mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: new Date().toISOString(),
    season: SEASON_LABEL,
    creditsSpent,
    pairs: pairs.map((p) => ({ code: p.code, label: p.label, lfaId: p.lfaId })),
    totals: {
      matched: allMatched.length,
      divergences: allDivergences.length,
      byConfidence: {
        exacte: allMatched.filter((m) => m.confidence === "exacte").length,
        score: allMatched.filter((m) => m.confidence === "confirmée par le score").length,
      },
    },
    divergences: allDivergences,
    quality: aggregateQuality(quality),
    african: africanReports,
  };

  const jsonPath = `reports/comparaison-sources-${stamp}.json`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("\n" + "═".repeat(78));
  console.log(`Rencontres appariées : ${allMatched.length}`);
  console.log(`Divergences relevées : ${allDivergences.length}`);
  console.log(`Crédits consommés    : ${creditsSpent}`);
  console.log(`Rapport              : ${jsonPath}`);

  if (allDivergences.length > 0) {
    console.log("\nDétail des divergences :");
    for (const d of allDivergences.slice(0, 20)) {
      console.log(`   ${d.match.padEnd(46)} ${d.field.padEnd(22)} A=${d.sourceA} B=${d.sourceB}`);
    }
  }
}

main()
  .catch((error) => {
    console.error("\n❌ Comparaison interrompue :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
