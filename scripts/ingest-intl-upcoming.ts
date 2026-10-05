/**
 * ============================================================================
 * SOLEIL — Import international : matchs à venir et historique récent
 * ============================================================================
 * Complète l'historique UEFA/CONCACAF là où le plan gratuit API-SPORTS
 * s'arrête (saisons 2025-2026 non accessibles) : les matchs de la fenêtre
 * internationale courante et l'historique récent des équipes concernées.
 *
 * Source : apifootball.com APIv3 (quota horaire de l'abonnement existant —
 * aucun crédit unitaire, aucun achat).
 *
 *   GET https://apiv3.apifootball.com/?action=get_events&from=&to=&league_id=
 *   GET https://apiv3.apifootball.com/?action=get_events&from=&to=&team_id=
 *
 * Couverture :
 *   1. UEFA Nations League (league_id 633) et CONCACAF Nations League (664)
 *      sur l'année courante — joués et à venir ;
 *   2. l'historique 2025→fin année des équipes qui jouent dans les 24 h à
 *      venir (toutes compétitions confondues) : c'est le contexte réellement
 *      utilisé par `buildMatchContext` pour les prédictions de demain.
 *
 * 🔒 Aucun crédit LFA. Aucun achat. Import ADDITIF et idempotent :
 *    `ingestFixtures` fusionne sur (équipes, jour ± 1) — une rencontre déjà
 *    présente (quelle que soit sa source) est mise à jour, jamais dupliquée.
 *    Aucune donnée existante n'est supprimée ni remplacée par une valeur vide.
 *
 * Usage : npx tsx scripts/ingest-intl-upcoming.ts [--check]
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ingestFixtures } from "../src/server/data/ingest";
import type { NormalizedFixture } from "../src/server/data/providers/types";

const BASE_URL = "https://apiv3.apifootball.com/";
const THROTTLE_MS = 1_500; // respect du quota horaire

const NATIONAL_LEAGUES = [
  { code: "UNL", name: "UEFA Nations League", country: "Europe", leagueId: 633 },
  { code: "CCNL", name: "CONCACAF Nations League", country: "North & Central America", leagueId: 664 },
];

interface ApiEvent {
  match_id: string;
  league_id: string;
  league_name: string;
  match_date: string;
  match_time: string;
  match_hometeam_id: string;
  match_hometeam_name: string;
  match_awayteam_id: string;
  match_awayteam_name: string;
  match_hometeam_ft_score: string;
  match_awayteam_ft_score: string;
  match_hometeam_ht_score: string;
  match_awayteam_ht_score: string;
  match_status: string;
  match_live: string;
  statistics?: { type: string; home: string; away: string }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stat(ev: ApiEvent, type: string, side: "home" | "away"): number | null {
  const row = ev.statistics?.find((s) => s.type === type);
  return toNumber(row ? row[side] : undefined);
}

function mapStatus(ev: ApiEvent): NormalizedFixture["status"] {
  const s = (ev.match_status ?? "").trim();
  if (["FT", "AET", "PEN"].includes(s)) return "finished";
  if (["Postp.", "PST"].includes(s)) return "postponed";
  if (["Cancelled", "CAN", "Aban.", "ABD", "AWD", "WO"].includes(s)) return "cancelled";
  if (["1H", "2H", "HT", "ET", "P", "BT", "INT", "LIVE"].includes(s) || ev.match_live === "1") return "live";
  return "scheduled";
}

function toFixture(ev: ApiEvent, competition: { code: string; name: string; country: string }): NormalizedFixture {
  const status = mapStatus(ev);
  const played = status === "finished" || status === "live";
  return {
    externalId: `apifootball:event:${ev.match_id}`,
    sourceRef: `apifootball:event:${ev.match_id}`,
    competition,
    utcDate: new Date(`${ev.match_date}T${ev.match_time || "00:00"}:00Z`),
    status,
    homeTeamName: ev.match_hometeam_name,
    awayTeamName: ev.match_awayteam_name,
    homeScore: played ? toNumber(ev.match_hometeam_ft_score) : null,
    awayScore: played ? toNumber(ev.match_awayteam_ft_score) : null,
    halfTimeHomeScore: played ? toNumber(ev.match_hometeam_ht_score) : null,
    halfTimeAwayScore: played ? toNumber(ev.match_awayteam_ht_score) : null,
    homeXg: null, // apifootball ne fournit pas d'xG — jamais estimé.
    awayXg: null,
    homeShots: played ? stat(ev, "Shots Total", "home") : null,
    awayShots: played ? stat(ev, "Shots Total", "away") : null,
    homeShotsOnTarget: played ? stat(ev, "Shots On Goal", "home") : null,
    awayShotsOnTarget: played ? stat(ev, "Shots On Goal", "away") : null,
    homeCorners: played ? stat(ev, "Corners", "home") : null,
    awayCorners: played ? stat(ev, "Corners", "away") : null,
    homeYellowCards: played ? stat(ev, "Yellow Cards", "home") : null,
    awayYellowCards: played ? stat(ev, "Yellow Cards", "away") : null,
    venue: null,
    referee: null,
  };
}

async function fetchEvents(params: Record<string, string>, apiKey: string): Promise<ApiEvent[]> {
  const qs = new URLSearchParams({ action: "get_events", APIkey: apiKey, ...params });
  const res = await fetch(`${BASE_URL}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as ApiEvent[] | { error: number; message: string };
  if (!Array.isArray(body)) {
    const msg = (body as { message: string }).message ?? "réponse invalide";
    if (/No event found/i.test(msg)) return [];
    throw new Error(msg.slice(0, 120));
  }
  return body;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const check = process.argv.includes("--check");
  const apiKey = (process.env.APIFOOTBALL_KEY ?? "").trim();
  if (!apiKey) {
    console.error("❌ APIFOOTBALL_KEY absente de .env.");
    process.exit(1);
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const today = isoDay(now);
  const tomorrow = isoDay(new Date(now.getTime() + 86_400_000));

  // ---------------------------------------------------------------------
  // 1. Les deux Nations League sur l'année courante (joués + à venir).
  // ---------------------------------------------------------------------
  const fixtures: NormalizedFixture[] = [];
  for (const league of NATIONAL_LEAGUES) {
    const events = await fetchEvents(
      { from: `${year}-01-01`, to: `${year}-12-31`, league_id: String(league.leagueId) },
      apiKey,
    );
    console.log(`${league.code} ${year} · ${events.length} rencontre(s) reçue(s).`);
    fixtures.push(...events.map((ev) => toFixture(ev, { code: league.code, name: league.name, country: league.country })));
    await sleep(THROTTLE_MS);
  }

  // ---------------------------------------------------------------------
  // 2. Historique récent des équipes qui jouent dans les 24 h (toutes
  //    compétitions) — le contexte réel des prédictions de demain.
  // ---------------------------------------------------------------------
  const soon = fixtures.filter((f) => {
    const t = f.utcDate.getTime();
    return t >= now.getTime() - 6 * 3600_000 && t < now.getTime() + 24 * 3600_000;
  });
  const teamIds = new Set<string>();
  const competitions = new Map<string, { code: string; name: string; country: string }>();
  for (const league of NATIONAL_LEAGUES) competitions.set(String(league.leagueId), { code: league.code, name: league.name, country: league.country });

  console.log(`Fenêtre demain : ${soon.length} rencontre(s) — recherche des identifiants d'équipes…`);
  const rawSoon = new Map<string, ApiEvent>();
  for (const league of NATIONAL_LEAGUES) {
    const events = await fetchEvents(
      { from: isoDay(new Date(now.getTime() - 6 * 3600_000)), to: tomorrow, league_id: String(league.leagueId) },
      apiKey,
    );
    for (const ev of events) {
      rawSoon.set(ev.match_id, ev);
      teamIds.add(ev.match_hometeam_id);
      teamIds.add(ev.match_awayteam_id);
    }
    await sleep(THROTTLE_MS);
  }

  console.log(`${teamIds.size} équipe(s) à étoffer — historique ${year - 1}→${year} (toutes compétitions).`);
  for (const teamId of teamIds) {
    try {
      const events = await fetchEvents(
        { from: `${year - 1}-01-01`, to: `${year}-12-31`, team_id: teamId },
        apiKey,
      );
      for (const ev of events) {
        const leagueId = ev.league_id;
        if (!competitions.has(leagueId)) {
          competitions.set(leagueId, {
            code: `APF${leagueId}`,
            name: ev.league_name || `Compétition ${leagueId}`,
            country: "International",
          });
        }
        fixtures.push(toFixture(ev, competitions.get(leagueId)!));
      }
      console.log(`  équipe ${teamId} · ${events.length} rencontre(s).`);
      await sleep(THROTTLE_MS);
    } catch (error) {
      console.log(`  équipe ${teamId} · erreur ${(error as Error).message}`);
    }
  }

  // Déduplication par externalId (les fetchs par ligue/équipe se recoupent).
  const unique = [...new Map(fixtures.map((f) => [f.externalId, f])).values()];

  if (check) {
    console.log(`\n[check] ${unique.length} rencontre(s) uniques, aucune écriture.`);
    for (const f of unique.slice(0, 30)) {
      console.log("  ", isoDay(f.utcDate), f.status.padEnd(9), f.competition.code.padEnd(6), f.homeTeamName, "-", f.awayTeamName);
    }
    return;
  }

  console.log(`\nIngestion de ${unique.length} rencontre(s)…`);
  let inserted = 0;
  let updated = 0;
  let merged = 0;
  let teams = 0;
  // Une passe par compétition (contrat `ingestFixtures`).
  const byCompetition = new Map<string, NormalizedFixture[]>();
  for (const f of unique) {
    const list = byCompetition.get(f.competition.code) ?? [];
    list.push(f);
    byCompetition.set(f.competition.code, list);
  }
  for (const [code, list] of byCompetition) {
    const stats = await ingestFixtures({
      provider: "apifootball",
      competitionCode: code,
      season: String(year),
      fixtures: list,
    });
    inserted += stats.inserted;
    updated += stats.updated;
    merged += stats.duplicatesMerged;
    teams += stats.teamsCreated;
    console.log(
      `  ${code} · reçus ${String(stats.received).padStart(4)} · insérés ${String(stats.inserted).padStart(4)} · ` +
        `màj ${String(stats.updated).padStart(4)} · fusions ${String(stats.duplicatesMerged).padStart(4)} · équipes +${stats.teamsCreated}` +
        (stats.errors.length ? ` · ⚠ ${stats.errors.length} erreur(s)` : ""),
    );
  }
  console.log(`Insérés ${inserted} · màj ${updated} (dont ${merged} fusions) · équipes +${teams}`);
  console.log("🔒 Import additif et idempotent. Rien de supprimé, rien d'écrasé (§34).");
}

main().catch((e) => {
  console.error("ERREUR:", e.message);
  process.exit(1);
});
