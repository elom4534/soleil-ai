/**
 * ============================================================================
 * SOLEIL — PHASE 10 · Comparaison des statistiques avancées (grand échantillon)
 * ============================================================================
 * Le comparateur ponctuel (scripts/compare-advanced.ts) portait sur 8 rencontres
 * achetées pour l'occasion. Celui-ci ne dépense AUCUN crédit : il rejoue les
 * 460 fiches détaillées déjà payées et en cache pendant l'enrichissement xG de
 * la phase 11, et les confronte aux fichiers bruts gratuits de
 * football-data.co.uk pour la même saison.
 *
 *   Source A  : football-data.co.uk — fichier brut local (0 crédit, 0 réseau)
 *   Source B  : LiveFootballApi     — /live_match_details en cache (0 crédit)
 *
 * Six familles comparables, identiques à celles du comparateur ponctuel, afin
 * que les deux résultats soient directement superposables :
 *   Tirs · Tirs cadrés · Corners · Fautes · Cartons jaunes · Cartons rouges
 *
 * Règle de mesure : une valeur n'est comparée que si les DEUX sources la
 * fournissent. Une valeur absente d'un côté est comptée comme « non comparable »,
 * jamais comme un accord — sinon l'absence se transformerait en faux succès.
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../src/lib/prisma";
import { parseCsv } from "../src/server/data/providers/csv";
import {
  normalizeStats,
  type StatKey,
} from "../src/server/data/providers/apiFootballLive/normalize";
import { normalizeTeamName } from "./lib/source-matching";
import { DATA_ROOT, loadSeason, toSeasonCode, type BacktestMatch } from "./backtest/dataset";

const SEASON = "2024/2025";
const COMPETITIONS = [
  { code: "E0", label: "Premier League" },
  { code: "SP1", label: "LaLiga" },
];

/** Identiques à scripts/compare-advanced.ts — comparabilité garantie. */
const FAMILIES: { name: string; rawHome: string; rawAway: string; key: StatKey }[] = [
  { name: "Tirs", rawHome: "HS", rawAway: "AS", key: "shotsTotal" },
  { name: "Tirs cadrés", rawHome: "HST", rawAway: "AST", key: "shotsOnTarget" },
  { name: "Corners", rawHome: "HC", rawAway: "AC", key: "corners" },
  { name: "Fautes", rawHome: "HF", rawAway: "AF", key: "fouls" },
  { name: "Cartons jaunes", rawHome: "HY", rawAway: "AY", key: "yellowCards" },
  { name: "Cartons rouges", rawHome: "HR", rawAway: "AR", key: "redCards" },
];

/**
 * Clé d'appariement commune : date + équipes.
 * Les noms passent par le référentiel partagé (`normalizeTeamName`), sinon
 * « Manchester United » et « Man United » ne se rejoindraient jamais.
 */
function joinKey(date: string, home: string, away: string): string {
  return `${date}|${normalizeTeamName(home)}|${normalizeTeamName(away)}`;
}

/** « 2025-08-15 19:00:00 » → « 2025-08-15 ». */
function isoDate(raw: string): string {
  return String(raw ?? "").slice(0, 10);
}

interface Divergence {
  competition: string;
  match: string;
  date: string;
  family: string;
  side: "domicile" | "extérieur";
  sourceA: number;
  sourceB: number;
}

async function main() {
  console.log("\n☀️  SOLEIL — comparaison des statistiques avancées (phase 10, lot étendu)");
  console.log("═".repeat(78));
  console.log(`Saison          : ${SEASON}`);
  console.log("Source A        : football-data.co.uk (fichier brut local)");
  console.log("Source B        : LiveFootballApi (/live_match_details en cache)");
  console.log("Coût            : 0 crédit — aucune requête payante, aucune requête réseau");
  console.log("═".repeat(78));

  // --- 1. Les fiches détaillées payées, relues depuis le cache (0 crédit) ----
  const rows = await prisma.systemConfig.findMany({
    where: { key: { startsWith: "cache:api-football-live:" } },
    select: { key: true, value: true },
  });
  const details = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.key.includes("live_match_details")) continue;
    const wrapped = row.value as { value?: unknown } | unknown;
    const payload =
      typeof wrapped === "string"
        ? JSON.parse(wrapped)
        : ((wrapped as { value?: unknown })?.value ?? wrapped);
    const body = (payload as { raw?: unknown; data?: unknown })?.raw ?? payload;
    const data = (body as { data?: unknown })?.data ?? body;
    const record = data as Record<string, unknown>;
    const id = String(record?.match_id ?? "");
    if (id) details.set(id, record);
  }
  console.log(`\nFiches détaillées relues du cache : ${details.size} (0 crédit)`);

  // --- 2. Les matchs gratuits, lus sur disque -------------------------------
  const report = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    creditsSpent: 0,
    sourceA: "football-data.co.uk",
    sourceB: "live-football-api",
    families: FAMILIES.map((f) => f.name),
    competitions: [] as unknown[],
    totals: {
      matchesJoined: 0,
      matchesUnjoined: 0,
      valuesCompared: 0,
      divergences: 0,
      notComparable: [] as { match: string; family: string; side: string; reason: string }[],
      scoreMismatches: [] as string[],
    },
    lfaOnly: [] as { key: string; label?: string }[],
    unmappedLabels: [] as string[],
    divergenceDetail: [] as Divergence[],
  };

  const perFamily = new Map<
    string,
    { compared: number; divergences: number; gaps: number[]; maxGap: Divergence | null }
  >();
  for (const family of FAMILIES) {
    perFamily.set(family.name, { compared: 0, divergences: 0, gaps: [], maxGap: null });
  }

  for (const competition of COMPETITIONS) {
    const matches = await loadSeason(competition.code, SEASON);
    const rawPath = join(DATA_ROOT, "raw", "fdcouk", toSeasonCode(SEASON), `${competition.code}.csv`);
    if (!existsSync(rawPath)) {
      console.log(`   ⚠️  ${competition.label} : fichier brut introuvable (${rawPath}) — ignoré`);
      continue;
    }
    const rawRows = parseCsv(readFileSync(rawPath, "utf8"));
    const rawIndex = new Map<string, Record<string, string>>();
    for (const row of rawRows) {
      const [day, month, year] = String(row.Date ?? "").split("/");
      if (!day || !month || !year) continue;
      rawIndex.set(
        joinKey(`${year}-${month}-${day}`, row.HomeTeam ?? "", row.AwayTeam ?? ""),
        row,
      );
    }
    const matchIndex = new Map<string, BacktestMatch>();
    for (const match of matches) {
      const iso = match.date.toISOString().slice(0, 10);
      matchIndex.set(joinKey(iso, match.homeTeamName, match.awayTeamName), match);
    }

    let joined = 0;
    let unjoined = 0;
    const comparedFamilies = FAMILIES.map((f) => f.name);

    for (const detail of details.values()) {
      const header = detail.header as Record<string, { name?: string; score?: string }> | undefined;
      const homeName = String(header?.home?.name ?? "");
      const awayName = String(header?.away?.name ?? "");
      const date = isoDate(String(detail.match_date ?? ""));
      if (!homeName || !awayName || !date) continue;

      const key = joinKey(date, homeName, awayName);
      const match = matchIndex.get(key);
      if (!match) continue; // fiche d'une autre compétition ou d'une autre saison
      const raw = rawIndex.get(key);
      if (!raw) continue;

      joined += 1;
      const stats = normalizeStats(detail.stats);
      for (const label of stats.home.unmappedLabels) {
        if (!report.unmappedLabels.includes(label)) report.unmappedLabels.push(label);
      }
      for (const statKey of Object.keys(stats.home.values) as StatKey[]) {
        if (!report.lfaOnly.some((entry) => entry.key === statKey)) report.lfaOnly.push({ key: statKey });
      }

      // Contrôle : les deux sources annoncent-elles le même score ?
      const scoreAHome = Number(raw.FTHG);
      const scoreAAway = Number(raw.FTAG);
      const scoreBHome = Number(header?.home?.score);
      const scoreBAway = Number(header?.away?.score);
      if (scoreAHome !== scoreBHome || scoreAAway !== scoreBAway) {
        report.totals.scoreMismatches.push(
          `${competition.label} ${date} ${homeName} - ${awayName} : ${scoreAHome}-${scoreAAway} ↔ ${scoreBHome}-${scoreBAway}`,
        );
      }

      for (const family of FAMILIES) {
        const bucket = perFamily.get(family.name)!;
        const sides: { side: "domicile" | "extérieur"; raw: string; stat: StatKey; block: "home" | "away" }[] = [
          { side: "domicile", raw: family.rawHome, stat: family.key, block: "home" },
          { side: "extérieur", raw: family.rawAway, stat: family.key, block: "away" },
        ];
        for (const entry of sides) {
          const rawValue = raw[entry.raw];
          // Le côté compte : lire le bloc « domicile » pour les deux côtés
          // fabriquerait mécaniquement un écart sur toutes les équipes invitées.
          const lfaValue = stats[entry.block].values[entry.stat]?.value ?? null;
          const label = `${homeName} - ${awayName}`;
          if (rawValue === undefined || String(rawValue).trim() === "") {
            report.totals.notComparable.push({
              match: label,
              family: family.name,
              side: entry.side,
              reason: "absente du fichier brut football-data.co.uk",
            });
            continue;
          }
          if (lfaValue === null) {
            report.totals.notComparable.push({
              match: label,
              family: family.name,
              side: entry.side,
              reason: "absente de la fiche LiveFootballApi",
            });
            continue;
          }
          const a = Number(rawValue);
          if (!Number.isFinite(a)) continue;
          bucket.compared += 1;
          report.totals.valuesCompared += 1;
          if (a !== lfaValue) {
            const divergence: Divergence = {
              competition: competition.label,
              match: label,
              date,
              family: family.name,
              side: entry.side,
              sourceA: a,
              sourceB: lfaValue,
            };
            bucket.divergences += 1;
            bucket.gaps.push(Math.abs(a - lfaValue));
            report.totals.divergences += 1;
            report.divergenceDetail.push(divergence);
            if (!bucket.maxGap || Math.abs(a - lfaValue) > Math.abs(bucket.maxGap.sourceA - bucket.maxGap.sourceB)) {
              bucket.maxGap = divergence;
            }
          }
        }
      }
    }

    unjoined = matches.length - joined;
    report.totals.matchesJoined += joined;
    report.totals.matchesUnjoined += unjoined;
    report.competitions.push({
      code: competition.code,
      label: competition.label,
      matches: matches.length,
      matchedWithPaidDetails: joined,
      withoutPaidDetails: unjoined,
      families: comparedFamilies,
    });
    console.log(
      `\n■ ${competition.label} : ${joined}/${matches.length} rencontres de ${SEASON} appariées aux fiches payées`,
    );
  }

  // --- 3. Synthèse ----------------------------------------------------------
  console.log("\n" + "─".repeat(78));
  console.log("RÉSULTAT PAR FAMILLE");
  console.log("─".repeat(78));
  console.log(`${"Famille".padEnd(18)} ${"valeurs".padStart(9)} ${"écarts".padStart(8)} ${"taux".padStart(8)} ${"écart moyen".padStart(13)}`);
  const summary = [] as { family: string; compared: number; divergences: number; rate: number; meanGap: number | null; maxGap: Divergence | null }[];
  for (const family of FAMILIES) {
    const bucket = perFamily.get(family.name)!;
    const rate = bucket.compared === 0 ? 0 : (bucket.divergences / bucket.compared) * 100;
    const meanGap = bucket.gaps.length === 0 ? null : bucket.gaps.reduce((s, g) => s + g, 0) / bucket.gaps.length;
    summary.push({
      family: family.name,
      compared: bucket.compared,
      divergences: bucket.divergences,
      rate,
      meanGap,
      maxGap: bucket.maxGap,
    });
    console.log(
      `${family.name.padEnd(18)} ${String(bucket.compared).padStart(9)} ${String(bucket.divergences).padStart(8)} ` +
        `${`${rate.toFixed(1)} %`.padStart(8)} ${(meanGap === null ? "—" : meanGap.toFixed(2)).padStart(13)}`,
    );
  }

  console.log("\n" + "─".repeat(78));
  console.log("BILAN");
  console.log("─".repeat(78));
  console.log(`Rencontres appariées          : ${report.totals.matchesJoined}`);
  console.log(`Valeurs comparées             : ${report.totals.valuesCompared}`);
  console.log(`Divergences                   : ${report.totals.divergences}`);
  console.log(`Scores discordants            : ${report.totals.scoreMismatches.length}`);
  console.log(`Valeurs non comparables       : ${report.totals.notComparable.length}`);
  console.log(`Statistiques propres à la source B (absentes du brut) : ${report.lfaOnly.length}`);
  console.log(`Libellés non reconnus par l'adaptateur : ${report.unmappedLabels.length}`);

  const outDir = new URL("../reports/", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `comparaison-stats-${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ ...report, perFamily: summary }, null, 2),
    "utf8",
  );
  console.log(`\nRapport : ${outPath}`);
  console.log("Coût de cette comparaison : 0 crédit.\n");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("Échec de la comparaison :", error);
  await prisma.$disconnect();
  process.exit(1);
});
