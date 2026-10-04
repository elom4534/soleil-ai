/**
 * ============================================================================
 * SOLEIL — Amorçage local de la base (Phase 14)
 * ============================================================================
 * Le redéploiement du bac à sable a vidé la base de données de développement.
 * Ce script la reconstitue **exclusivement depuis les fichiers déjà présents**
 * dans `data/` :
 *
 *   data/normalized/fdcouk/<CODE>/<saison>.json  → 8 360 rencontres réelles
 *   data/features/live-football-api/<CODE>/…      → 460 xG réels (Phase 11)
 *
 * 🔒 AUCUN ACCÈS RÉSEAU. Aucun crédit API consommé. Les clés ne sont pas lues.
 * Aucune donnée n'est inventée : un champ absent reste `null`.
 *
 * Usage :
 *   npx tsx scripts/bootstrap-local.ts            → ingère tout
 *   npx tsx scripts/bootstrap-local.ts --check    → n'écrit rien, compte
 */

import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { ingestFixtures } from "../src/server/data/ingest";
import type { NormalizedFixture } from "../src/server/data/providers/types";

const DATA_ROOT = "data";
const PROVIDER = "football-data-co-uk";
const COMPETITIONS = ["E0", "SP1"] as const;

const COMPETITION_META: Record<string, { name: string; country: string }> = {
  E0: { name: "Premier League", country: "England" },
  SP1: { name: "La Liga", country: "Spain" },
};

interface LocalMatch {
  id: string;
  season: string;
  date: string;
  competition: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  homeGoals: number | null;
  awayGoals: number | null;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  homeXg: number | null;
  awayXg: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  source: string;
}

/** xG réellement collectés en Phase 11 — relus depuis le disque, coût 0. */
function loadXg(): Map<string, { homeXg: number | null; awayXg: number | null }> {
  const map = new Map<string, { homeXg: number | null; awayXg: number | null }>();
  for (const competition of COMPETITIONS) {
    const path = join(DATA_ROOT, "features", "live-football-api", competition, "2024-2025.json");
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      records: { matchId: string; homeXg: number | null; awayXg: number | null }[];
    };
    for (const record of payload.records) {
      map.set(record.matchId, { homeXg: record.homeXg, awayXg: record.awayXg });
    }
  }
  return map;
}

/** Convertit une rencontre locale au contrat `NormalizedFixture`. */
function toFixture(m: LocalMatch, xgApplied: boolean): NormalizedFixture {
  const meta = COMPETITION_META[m.competition] ?? { name: m.competition, country: "" };
  const finished = m.homeGoals !== null && m.awayGoals !== null;
  return {
    externalId: m.id,
    sourceRef: m.id,
    competition: { code: m.competition, name: meta.name, country: meta.country },
    utcDate: new Date(m.date),
    status: finished ? "finished" : "scheduled",
    homeTeamName: m.homeTeamName,
    awayTeamName: m.awayTeamName,
    homeScore: m.homeGoals,
    awayScore: m.awayGoals,
    halfTimeHomeScore: m.halfTimeHomeGoals,
    halfTimeAwayScore: m.halfTimeAwayGoals,
    // Un xG n'est repris que s'il provient d'une collecte réelle.
    homeXg: xgApplied ? m.homeXg : null,
    awayXg: xgApplied ? m.awayXg : null,
    homeShots: m.homeShots,
    awayShots: m.awayShots,
    homeShotsOnTarget: m.homeShotsOnTarget,
    awayShotsOnTarget: m.awayShotsOnTarget,
    homeCorners: m.homeCorners,
    awayCorners: m.awayCorners,
    homeYellowCards: m.homeYellowCards,
    awayYellowCards: m.awayYellowCards,
    venue: null,
    referee: null,
  };
}

async function main() {
  const check = process.argv.includes("--check");

  console.log("═".repeat(78));
  console.log("SOLEIL — AMORÇAGE LOCAL (aucun réseau, aucun crédit)");
  console.log("═".repeat(78));

  const xg = loadXg();
  console.log(`xG réels disponibles sur disque : ${xg.size} rencontres (saison 2024/2025)`);
  console.log("");

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalReceived = 0;
  let totalTeams = 0;
  let xgApplied = 0;

  for (const competition of COMPETITIONS) {
    const dir = join(DATA_ROOT, "normalized", "fdcouk", competition);
    if (!existsSync(dir)) continue;
    const seasons = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort();

    for (const season of seasons) {
      const payload = JSON.parse(readFileSync(join(dir, `${season}.json`), "utf8")) as {
        matches: LocalMatch[];
      };
      const fixtures = payload.matches.map((m) => {
        const record = xg.get(m.id);
        const applied = record !== undefined;
        if (applied) xgApplied += 1;
        return toFixture(applied ? { ...m, homeXg: record!.homeXg, awayXg: record!.awayXg } : m, applied);
      });

      if (check) {
        totalReceived += fixtures.length;
        console.log(`  [lecture] ${competition} ${season} : ${fixtures.length} rencontres`);
        continue;
      }

      const stats = await ingestFixtures({
        provider: PROVIDER,
        competitionCode: competition,
        season,
        fixtures,
      });

      totalReceived += stats.received;
      totalInserted += stats.inserted;
      totalUpdated += stats.updated;
      totalTeams += stats.teamsCreated;
      console.log(
        `  ${competition} ${season.padEnd(9)} · reçues ${String(stats.received).padStart(4)} · ` +
          `insérées ${String(stats.inserted).padStart(4)} · màj ${String(stats.updated).padStart(4)} · ` +
          `équipes +${stats.teamsCreated}` +
          (stats.errors.length > 0 ? ` · ⚠ ${stats.errors.length} avertissement(s)` : ""),
      );
    }
  }

  if (check) {
    console.log(`\nTotal lisible : ${totalReceived} rencontres. Aucune écriture effectuée.`);
    await prisma.$disconnect();
    return;
  }

  const [leagues, teams, matches, withXg] = await Promise.all([
    prisma.league.count(),
    prisma.team.count(),
    prisma.match.count(),
    prisma.matchLiveData.count({ where: { homeXg: { not: null } } }),
  ]);

  console.log("");
  console.log("─".repeat(78));
  console.log(`Rencontres lues      : ${totalReceived}`);
  console.log(`  insérées           : ${totalInserted}`);
  console.log(`  mises à jour       : ${totalUpdated}`);
  console.log(`  équipes créées     : ${totalTeams}`);
  console.log(`  xG réels appliqués : ${xgApplied}`);
  console.log("─".repeat(78));
  console.log(`Base : ${leagues} compétitions · ${teams} équipes · ${matches} rencontres · ${withXg} avec xG`);
  console.log("");
  console.log("🔒 Aucun appel réseau. Aucun crédit consommé.");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ Échec :", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
