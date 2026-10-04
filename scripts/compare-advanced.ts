/**
 * ============================================================================
 * SOLEIL — Comparaison des STATISTIQUES AVANCÉES (phase 10, étape 2)
 * ============================================================================
 * Le rapport `compare-sources.ts` compare les résultats (score, mi-temps) à
 * l'échelle d'une saison entière : 760 rencontres, 0 divergence.
 *
 * Ce script répond à la question suivante : sur les statistiques avancées
 * (tirs, tirs cadrés, corners, fautes, cartons), les deux sources racontent-
 * elles la même chose ? Et qu'apporte LiveFootballApi que la source actuelle
 * ne fournit pas du tout ?
 *
 * Coût maîtrisé et traçable :
 *   · périmètre — 2 compétitions (E0, SP1), saison 2025/2026, terminée ;
 *   · échantillon — 4 rencontres par compétition (8 au total), réparties
 *     régulièrement sur la saison, sélection déterministe ;
 *   · 1 crédit par rencontre (`/live_match_details`), soit 8 crédits ;
 *   · la source historique est GRATUITE (fichier CSV) : 0 crédit ;
 *   · plafond `globalDailyBudget` fixé à la taille de l'échantillon ;
 *   · aucun import : écrit uniquement un rapport JSON dans `reports/`.
 *
 * Règle de comparaison : une divergence n'est comptée que si les DEUX sources
 * publient une valeur. Une absence d'un côté est rapportée comme « non
 * comparable » — jamais transformée en zéro, jamais arbitrée.
 *
 * Usage :
 *   npm run compare:advanced                 → 4 rencontres par compétition
 *   npm run compare:advanced -- --sample 2    → 2 rencontres par compétition
 *   npm run compare:advanced -- --leagues E0  → une seule compétition
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import { ApiFootballLiveClient } from "../src/server/data/providers/apiFootballLive/client";
import {
  getCompetitionFixtures,
  getMatch,
  type NormalizedMatch,
} from "../src/server/data/providers/apiFootballLive/adapter";
import { resolvePreset } from "../src/server/data/providers/apiFootballLive/presets";
import { footballDataCoUkProvider } from "../src/server/data/providers/footballDataCoUk";
import { parseCsv } from "../src/server/data/providers/csv";
import type { StatKey } from "../src/server/data/providers/apiFootballLive/normalize";
import type { NormalizedFixture } from "../src/server/data/providers/types";
import { matchSources, normalizeTeamName, type CanonicalMatch } from "./lib/source-matching";
import { prisma } from "../src/lib/prisma";

// ---------------------------------------------------------------------------
// Périmètre
// ---------------------------------------------------------------------------

const SEASON = "2025/2026";
const PAIRS = [
  { code: "E0", label: "Premier League", lfaId: "2kwbbcootiqqgmrzs6o5inle5" },
  { code: "SP1", label: "LaLiga", lfaId: "34pl8szyvrbwcmfkuocjm3r6t" },
];

/**
 * Familles de statistiques comparables entre les deux sources.
 * Colonnes brutes football-data.co.uk ↔ vocabulaire canonique SOLEIL.
 */
const FAMILIES: { name: string; rawHome: string; rawAway: string; key: StatKey }[] = [
  { name: "Tirs", rawHome: "HS", rawAway: "AS", key: "shotsTotal" },
  { name: "Tirs cadrés", rawHome: "HST", rawAway: "AST", key: "shotsOnTarget" },
  { name: "Corners", rawHome: "HC", rawAway: "AC", key: "corners" },
  { name: "Fautes", rawHome: "HF", rawAway: "AF", key: "fouls" },
  { name: "Cartons jaunes", rawHome: "HY", rawAway: "AY", key: "yellowCards" },
  { name: "Cartons rouges", rawHome: "HR", rawAway: "AR", key: "redCards" },
];

/**
 * Statistiques que LiveFootballApi publie et que la source historique ne
 * publie pas. Sert à répondre factuellement à « qu'apporte la nouvelle
 * source ? » — sans lui prêter une supériorité non mesurée.
 */
const LFA_ONLY: StatKey[] = [
  "xg",
  "xgSetPieces",
  "possession",
  "bigChancesMissed",
  "shotsOffTarget",
  "shotsBlocked",
  "passesTotal",
  "passesAccurate",
  "passAccuracy",
  "crosses",
  "duelsWon",
  "aerialDuelsWon",
  "tacklesWon",
  "dribblesWon",
  "clearances",
  "interceptions",
  "touchesInBox",
  "hitWoodwork",
  "throwIns",
  "goalKicks",
  "offsides",
  "ppdaOppositionPasses",
  "ppdaDefensiveActions",
];

interface DivergenceRow {
  match: string;
  date: string;
  competition: string;
  stat: string;
  side: "domicile" | "extérieur";
  sourceA: number;
  apiFootballLive: number;
  ecart: number;
}

interface StatSummary {
  stat: string;
  comparables: number;
  divergences: number;
  ecartMoyen: number;
  ecartMax: number;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/** « 2025/2026 » → « 2526 » (code de saison des fichiers football-data.co.uk). */
function toSeasonCode(season: string): string {
  return season
    .split("/")
    .map((part) => part.slice(-2))
    .join("");
}

/** « 15/08/2025 » ou « 15/08/25 » → « 2025-08-15 ». */
function parseRawDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y!.length === 2 ? `20${y}` : y!;
  return `${year}-${mo}-${d}`;
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Récupère le fichier brut (GRATUIT) de la source historique et l'indexe par
 * `date|domicile|extérieur`. Le cache de l'application ne conserve que les
 * données déjà normalisées, qui ne contiennent ni fautes ni cartons rouges :
 * ces colonnes existent dans le fichier, donc on va les lire à la source
 * plutôt que de déclarer la comparaison impossible.
 */
async function loadRawCsv(code: string): Promise<Map<string, Record<string, string>>> {
  const url = `https://www.football-data.co.uk/mmz4281/${toSeasonCode(SEASON)}/${code}.csv`;
  const response = await fetch(url, {
    headers: { "User-Agent": "SOLEIL/1.0 (plateforme d'analyse statistique)" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`);
  const rows = parseCsv(await response.text());
  const index = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const date = parseRawDate(row.Date ?? "");
    if (!date || !row.HomeTeam || !row.AwayTeam) continue;
    index.set(`${date}|${normalizeTeamName(row.HomeTeam)}|${normalizeTeamName(row.AwayTeam)}`, row);
  }
  return index;
}

/**
 * Échantillon déterministe : on parcourt la saison à pas régulier pour ne pas
 * se contenter des premières journées (août = forme initiale, miroir trompeur).
 */
function evenlySpaced<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (count - 1));
    const item = items[index];
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

async function main() {
  const samplePerLeague = Number(argValue("--sample") ?? 4);
  if (!Number.isInteger(samplePerLeague) || samplePerLeague < 1 || samplePerLeague > 10) {
    throw new Error("--sample doit être un entier entre 1 et 10");
  }
  const only = argValue("--leagues");
  const pairs = only ? PAIRS.filter((p) => only.split(",").includes(p.code)) : PAIRS;
  const maxCredits = samplePerLeague * pairs.length;

  // Le plafond du client est un total JOURNALIER, pas une autorisation
  // ponctuelle : on lit donc ce qui a réellement été consommé aujourd'hui
  // (journal `ApiCallLog`) et on ajoute exactement l'échantillon. Écrire un
  // chiffre arbitraire ici donnerait soit un blocage, soit une dérive.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const spentToday = await prisma.apiCallLog.aggregate({
    _sum: { cost: true },
    where: { createdAt: { gte: startOfDay } },
  });
  const usedToday = spentToday._sum.cost ?? 0;
  const client = new ApiFootballLiveClient(resolvePreset("live-football-api"), {
    // Plafond strict : la comparaison ne peut pas dépasser l'échantillon.
    globalDailyBudget: usedToday + maxCredits,
  });
  await client.init();

  console.log("☀️  SOLEIL — comparaison des statistiques avancées");
  console.log("═".repeat(78));
  console.log(`Saison ${SEASON} · échantillon ${samplePerLeague} rencontre(s) par compétition`);
  console.log(
    `Déjà consommés aujourd'hui : ${usedToday} crédits · plafond porté à ${usedToday + maxCredits} · aucune écriture en base métier.`,
  );
  console.log("═".repeat(78));

  let creditsSpent = 0;
  const divergences: DivergenceRow[] = [];
  const perStat = new Map<string, StatSummary>();
  const lfaOnlySeen = new Map<string, number>();
  const sampleRows: {
    competition: string;
    date: string;
    match: string;
    scoreA: string;
    scoreB: string;
    credit: number;
  }[] = [];
  const notComparable: { match: string; stat: string; reason: string }[] = [];

  for (const pair of pairs) {
    console.log(`\n■ ${pair.label} (${pair.code}) — saison ${SEASON}`);

    const a = await footballDataCoUkProvider.fetchCompetition({
      competitionCode: pair.code,
      season: SEASON,
    });
    const b = await getCompetitionFixtures(client, pair.lfaId, SEASON);
    creditsSpent += b.creditsSpent;

    if (a.data.length === 0 || b.data.matches.length === 0) {
      console.log("   Données insuffisantes d'un côté : compétition écartée de l'échantillon.");
      continue;
    }

    const outcome = matchSources(a.data, b.data.matches, pair.label);
    const played = outcome.matched
      .filter((m) => m.fdcouk?.status === "finished" && m.lfa?.finalScore !== null)
      .sort((x, y) => x.date.localeCompare(y.date));
    const sample = evenlySpaced(played, samplePerLeague);

    console.log(`   rencontres terminées appariées : ${played.length}`);
    console.log(`   échantillon retenu            : ${sample.length}`);

    const raw = await loadRawCsv(pair.code); // gratuit, 0 crédit

    for (const item of sample) {
      await compareOne(item, pair, raw);
    }
  }

  async function compareOne(
    item: CanonicalMatch,
    pair: { code: string; label: string },
    raw: Map<string, Record<string, string>>,
  ) {
    const lfaMatch = item.lfa as NormalizedMatch;
    const scoreA = `${item.fdcouk?.homeScore ?? "?"}-${item.fdcouk?.awayScore ?? "?"}`;
    const scoreB = `${lfaMatch.finalScore?.home ?? "?"}-${lfaMatch.finalScore?.away ?? "?"}`;
    const label = `${item.home} - ${item.away}`;

    const details = await getMatch(client, lfaMatch.providerId);
    creditsSpent += details.creditsSpent;

    const stats = details.data.stats;
    const rawRow = raw.get(
      `${item.date}|${normalizeTeamName(lfaMatch.home.name)}|${normalizeTeamName(lfaMatch.away.name)}`,
    );
    if (!rawRow) {
      notComparable.push({ match: label, stat: "*", reason: "ligne absente du fichier brut (aucune valeur de comparaison)" });
      console.log(`   ⚠️  ${label} : absent du fichier brut — non comparable`);
      return;
    }

    sampleRows.push({
      competition: pair.label,
      date: item.date,
      match: label,
      scoreA,
      scoreB,
      credit: details.creditsSpent,
    });
    console.log(
      `   · ${item.date}  ${label.padEnd(38)} ${scoreA} ↔ ${scoreB}  (1 crédit, ${Object.keys(stats.home.values).length} statistiques)`,
    );

    for (const family of FAMILIES) {
      for (const side of ["home", "away"] as const) {
        const valueA = num(rawRow[side === "home" ? family.rawHome : family.rawAway]);
        const statB = stats[side].values[family.key];
        // `values` porte des objets `{ value, unit, raw }` : on ne compare que
        // des nombres, et jamais un pourcentage avec un décompte.
        const valueB = statB && statB.unit !== "percent" ? statB.value : null;
        const summary =
          perStat.get(family.name) ??
          { stat: family.name, comparables: 0, divergences: 0, ecartMoyen: 0, ecartMax: 0 };

        if (valueA === null || valueB === null) {
          notComparable.push({
            match: label,
            stat: `${family.name} (${side === "home" ? "domicile" : "extérieur"})`,
            reason: valueA === null ? "absente chez football-data.co.uk" : "absente chez LiveFootballApi",
          });
          perStat.set(family.name, summary);
          continue;
        }

        summary.comparables += 1;
        const gap = Math.abs(valueB - valueA);
        summary.ecartMoyen += gap;
        summary.ecartMax = Math.max(summary.ecartMax, gap);
        if (gap > 0) {
          summary.divergences += 1;
          divergences.push({
            match: label,
            date: item.date,
            competition: pair.label,
            stat: family.name,
            side: side === "home" ? "domicile" : "extérieur",
            sourceA: valueA,
            apiFootballLive: valueB,
            ecart: gap,
          });
        }
        perStat.set(family.name, summary);
      }
    }

    for (const key of LFA_ONLY) {
      if (stats.home.values[key] !== undefined || stats.away.values[key] !== undefined) {
        lfaOnlySeen.set(key, (lfaOnlySeen.get(key) ?? 0) + 1);
      }
    }
  }

  // --- Rapport -------------------------------------------------------------

  const perStatFinal = [...perStat.values()].map((s) => ({
    ...s,
    ecartMoyen: s.comparables === 0 ? 0 : Math.round((s.ecartMoyen / s.comparables) * 100) / 100,
    coherencePct:
      s.comparables === 0
        ? null
        : Math.round(((s.comparables - s.divergences) / s.comparables) * 1000) / 10,
  }));

  const totalComparables = perStatFinal.reduce((sum, s) => sum + s.comparables, 0);

  mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    samplePerLeague,
    creditsSpent,
    matchesCompared: sampleRows.length,
    sample: sampleRows,
    comparedFamilies: FAMILIES.map((f) => f.name),
    totals: {
      comparables: totalComparables,
      divergences: divergences.length,
      coherence:
        totalComparables === 0
          ? null
          : Math.round(((totalComparables - divergences.length) / totalComparables) * 1000) / 10,
      notComparable: notComparable.length,
    },
    perStat: perStatFinal,
    divergences,
    lfaOnlyProvided: [...lfaOnlySeen.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([key, matches]) => ({ stat: key, matches })),
    notComparable,
  };

  const jsonPath = `reports/comparaison-avancee-${stamp}.json`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("\n" + "═".repeat(78));
  console.log("SYNTHÈSE — statistiques avancées");
  console.log("═".repeat(78));
  for (const s of perStatFinal) {
    console.log(
      `   ${s.stat.padEnd(18)} valeurs comparables ${String(s.comparables).padStart(3)} · divergences ${String(s.divergences).padStart(3)} · écart moyen ${s.ecartMoyen} · max ${s.ecartMax}`,
    );
  }
  console.log(`\n   Valeurs comparables  : ${totalComparables}`);
  console.log(`   Divergences relevées : ${divergences.length}`);
  console.log(`   Cohérence globale    : ${report.totals.coherence} %`);
  console.log(`   Crédits consommés    : ${creditsSpent}`);
  console.log(`   Rapport              : ${jsonPath}`);

  if (divergences.length > 0) {
    console.log("\n| Match | Statistique | Source A | API Football Live | Écart |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const d of divergences) {
      console.log(
        `| ${d.date} ${d.match} | ${d.stat} (${d.side}) | ${d.sourceA} | ${d.apiFootballLive} | ${d.ecart > 0 ? "+" : ""}${d.ecart} |`,
      );
    }
  }

  if (lfaOnlySeen.size > 0) {
    console.log("\n   Statistiques publiées par LiveFootballApi sans équivalent chez la source actuelle :");
    console.log("   " + [...lfaOnlySeen.keys()].join(", "));
  }
}

main()
  .catch((error) => {
    console.error("\n❌ Comparaison avancée interrompue :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
