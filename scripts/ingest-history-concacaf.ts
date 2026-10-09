/**
 * ============================================================================
 * SOLEIL — Import de l'historique CONCACAF Nations League
 * ============================================================================
 * CONCACAF Nations League (CCNL) — matchs terminés et à venir, via le quota
 * gratuit API-Football (API-SPORTS), league id 536.
 *
 *   GET https://v3.football.api-sports.io/fixtures?league=536&season=<YYYY>
 *   En-tête : x-apisports-key = API_FOOTBALL_FALLBACK_KEY
 *
 * 🔒 AUCUN crédit LFA. Aucun achat. Aucune modification des modèles IA,
 *    formules ou features de prédiction. Import ADDITIF et idempotent
 *    (mêmes règles que l'historique UEFA). Données minimales : résultat,
 *    buts D/E, score mi-temps, date, équipes, compétition, saison, tour.
 *
 * Usage : npx tsx scripts/ingest-history-concacaf.ts [--check]
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ingestFixtures } from "../src/server/data/ingest";
import type { NormalizedFixture } from "../src/server/data/providers/types";

const BASE_URL = "https://v3.football.api-sports.io";
const PROVIDER = "api-football";

/** Ids API-SPORTS. */
const COMPETITIONS: { code: string; name: string; leagueId: number; seasons: number[] }[] = [
  { code: "CCNL", name: "CONCACAF Nations League", leagueId: 536, seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
];

const FINISHED_SHORT = new Set(["FT", "AET", "PEN"]);
const THROTTLE_MS = 6_500; // 10 requêtes/minute (quota gratuit)

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string; long: string } };
  league: { id: number; name: string; season: number; round: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
  score: { halftime: { home: number | null; away: number | null } };
}

function seasonLabel(year: number): string {
  return `${year}-${year + 1}`;
}

/** Tour « Group Stage - 3 » / « Round of 16 » → journée, tour, groupe. */
function parseRound(round: string): { matchday: number | null; stage: string | null; group: string | null } {
  const groupMatch = /\bGroup ([A-Z])\b/i.exec(round);
  const dayMatch = /(\d+)\s*$/.exec(round);
  return {
    matchday: dayMatch ? Number(dayMatch[1]) : null,
    stage: round || null,
    group: groupMatch ? `Group ${groupMatch[1].toUpperCase()}` : null,
  };
}

function toFixture(
  raw: ApiFixture,
  code: string,
  name: string,
): { fixture: NormalizedFixture; round: { matchday: number | null; stage: string | null; group: string | null } } | null {
  const short = raw.fixture.status.short;
  // Statuts acceptés : terminés (FT/AET/PEN), à venir (NS/TBD…), annulés/ajournés.
  const status: NormalizedFixture["status"] = FINISHED_SHORT.has(short)
    ? "finished"
    : short === "PST"
      ? "postponed"
      : short === "CAN" || short === "ABD" || short === "AWD" || short === "WO"
        ? "cancelled"
        : short === "1H" || short === "2H" || short === "HT" || short === "ET" || short === "BT" || short === "P" || short === "INT" || short === "LIVE"
          ? "live"
          : "scheduled";
  const goalsHome = raw.goals.home;
  const goalsAway = raw.goals.away;
  if (status === "finished" && (goalsHome === null || goalsAway === null)) return null;

  const round = parseRound(raw.league.round ?? "");
  return {
    fixture: {
      externalId: `api-football:fixture:${raw.fixture.id}`,
      sourceRef: `api-football:fixture:${raw.fixture.id}`,
      competition: { code, name, country: "North & Central America" },
      utcDate: new Date(raw.fixture.date),
      status,
      homeTeamName: raw.teams.home.name,
      awayTeamName: raw.teams.away.name,
      homeScore: goalsHome,
      awayScore: goalsAway,
      halfTimeHomeScore: raw.score.halftime.home,
      halfTimeAwayScore: raw.score.halftime.away,
      homeXg: null,
      awayXg: null,
      homeShots: null,
      awayShots: null,
      homeShotsOnTarget: null,
      awayShotsOnTarget: null,
      homeCorners: null,
      awayCorners: null,
      homeYellowCards: null,
      awayYellowCards: null,
      homeRedCards: null,
      awayRedCards: null,
      venue: null,
      referee: null,
    },
    round,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSeason(
  key: string,
  leagueId: number,
  year: number,
): Promise<{ fixtures: ApiFixture[]; remaining: string | null; error: string | null }> {
  const url = `${BASE_URL}/fixtures?league=${leagueId}&season=${year}`;
  const res = await fetch(url, { headers: { "x-apisports-key": key } });
  const remaining = res.headers.get("x-ratelimit-requests-remaining");
  if (res.status === 429) {
    return { fixtures: [], remaining, error: "HTTP 429 (quota minute/jour)" };
  }
  if (!res.ok) {
    return { fixtures: [], remaining, error: `HTTP ${res.status}` };
  }
  const body = (await res.json()) as { response?: ApiFixture[]; errors?: unknown };
  const errors = body.errors ?? {};
  if (body.response === undefined) {
    return { fixtures: [], remaining, error: `réponse invalide ${JSON.stringify(errors).slice(0, 80)}` };
  }
  return { fixtures: body.response, remaining, error: null };
}

async function main() {
  const check = process.argv.includes("--check");
  const key = (process.env.API_FOOTBALL_FALLBACK_KEY ?? "").trim();
  if (!key) {
    console.error("❌ API_FOOTBALL_FALLBACK_KEY absente de l'environnement.");
    process.exit(1);
  }

  console.log("═".repeat(78));
  console.log("SOLEIL — HISTORIQUE UEFA via quota GRATUIT API-Football (0 crédit LFA)");
  console.log("═".repeat(78));

  let totalReceived = 0;
  let totalFinished = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalMerged = 0;
  let totalTeams = 0;
  let totalSkippedStatus = 0;
  const perLeague: Record<string, { received: number; finished: number; seasons: string[] }> = {};
  const roundMeta = new Map<string, { matchday: number | null; stage: string | null; group: string | null }>();

  for (const comp of COMPETITIONS) {
    perLeague[comp.code] = { received: 0, finished: 0, seasons: [] };
    for (const year of comp.seasons) {
      const { fixtures, remaining, error } = await fetchSeason(key, comp.leagueId, year);
      if (error) {
        console.log(`  ${comp.code} ${seasonLabel(year)} · ✖ ${error}`);
        if (error.includes("429")) {
          console.log("  → quota atteint : arrêt immédiat (aucune donnée n'est perdue).");
          break;
        }
        await sleep(THROTTLE_MS);
        continue;
      }

      const parsed = fixtures
        .map((f) => toFixture(f, comp.code, comp.name))
        .filter((x): x is NonNullable<ReturnType<typeof toFixture>> => x !== null);
      const mapped = parsed.map((x) => x.fixture);
      for (const x of parsed) roundMeta.set(x.fixture.externalId, x.round);

      perLeague[comp.code].received += fixtures.length;
      perLeague[comp.code].finished += mapped.length;
      if (mapped.length > 0) perLeague[comp.code].seasons.push(seasonLabel(year));
      totalReceived += fixtures.length;
      totalFinished += mapped.length;
      totalSkippedStatus += fixtures.length - mapped.length;

      if (check) {
        console.log(
          `  [lecture] ${comp.code} ${seasonLabel(year)} : ${fixtures.length} reçus · ${mapped.length} terminés` +
            (remaining !== null ? ` · quota restant ${remaining}` : ""),
        );
        await sleep(THROTTLE_MS);
        continue;
      }

      const stats = await ingestFixtures({
        provider: PROVIDER,
        competitionCode: comp.code,
        season: seasonLabel(year),
        fixtures: mapped,
      });
      totalInserted += stats.inserted;
      totalUpdated += stats.updated;
      totalMerged += stats.duplicatesMerged;
      totalTeams += stats.teamsCreated;
      console.log(
        `  ${comp.code} ${seasonLabel(year)} · reçus ${String(fixtures.length).padStart(4)} · ` +
          `terminés ${String(mapped.length).padStart(4)} · insérés ${String(stats.inserted).padStart(4)} · ` +
          `màj ${String(stats.updated).padStart(4)} · équipes +${stats.teamsCreated}` +
          (remaining !== null ? ` · quota restant ${remaining}` : "") +
          (stats.errors.length > 0 ? ` · ⚠ ${stats.errors.length} avertissement(s)` : ""),
      );
      await sleep(THROTTLE_MS);
    }
  }

  // ---------------------------------------------------------------------
  // Journée / tour / groupe : passe finale CIBLÉE sur les seules rencontres
  // importées (le contrat NormalizedFixture ne les porte pas). §34 : on ne
  // remplit que les cases vides.
  // ---------------------------------------------------------------------
  let roundsFilled = 0;
  for (const [externalId, round] of roundMeta) {
    const match = await prisma.match.findUnique({ where: { externalId } });
    if (!match) continue;
    const patch: { matchday?: number; stage?: string; group?: string } = {};
    if (round.matchday !== null && match.matchday == null) patch.matchday = round.matchday;
    if (round.stage !== null && match.stage == null) patch.stage = round.stage;
    if (round.group !== null && match.group == null) patch.group = round.group;
    if (Object.keys(patch).length === 0) continue;
    await prisma.match.update({ where: { id: match.id }, data: patch });
    roundsFilled += 1;
  }

  console.log("");
  console.log("─".repeat(78));
  for (const [code, info] of Object.entries(perLeague)) {
    console.log(
      `${code} : ${info.finished} matchs terminés sur ${info.received} reçus · saisons [${info.seasons.join(", ")}]`,
    );
  }
  console.log("─".repeat(78));
  console.log(`Reçus ${totalReceived} · terminés ${totalFinished} · non-joués ignorés ${totalSkippedStatus}`);
  console.log(`Insérés ${totalInserted} · màj ${totalUpdated} (dont ${totalMerged} fusions) · équipes +${totalTeams}`);
  console.log(`Journaux/tours renseignés : ${roundsFilled} rencontres`);
  console.log("🔒 0 crédit LFA · 0 € · import additif et idempotent.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
