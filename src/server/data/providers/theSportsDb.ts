/**
 * ============================================================================
 * Fournisseur — TheSportsDB (calendrier)
 * ============================================================================
 * Source : https://www.thesportsdb.com/
 * Utilise la clé publique de test documentée par l'éditeur (`3`).
 * Pour un usage intensif, une clé payante est requise — elle se renseigne
 * dans `THESPORTSDB_KEY` et ce fichier n'a pas besoin d'être modifié.
 *
 * Ce que ce fournisseur sait fournir :
 *   ✔ matchs à venir (calendrier)
 *   ✔ résultats récents avec scores
 *   ✘ statistiques avancées (tirs, xG…)
 */

import { cached } from "../cache";
import { ProviderError, type DataProvider, type NormalizedFixture } from "./types";

const BASE_URL = "https://www.thesportsdb.com/api/v1/json";

/** Correspondance entre nos codes de compétition et les identifiants TheSportsDB. */
export const TSDB_LEAGUE_IDS: Record<string, number> = {
  E0: 4328, // English Premier League
  E1: 4329, // English League Championship
  SP1: 4335, // Spanish La Liga
  D1: 4331, // German Bundesliga
  I1: 4332, // Italian Serie A
  F1: 4334, // French Ligue 1
  N1: 4337, // Dutch Eredivisie
  P1: 4344, // Portuguese Primeira Liga
  B1: 4338, // Belgian First Division A
  T1: 4339, // Turkish Süper Lig
  G1: 4336, // Greek Super League
  SC0: 4330, // Scottish Premiership
};

interface TsdbEvent {
  idEvent: string;
  strTimestamp?: string | null;
  dateEvent?: string | null;
  strTime?: string | null;
  strEvent: string;
  strHomeTeam: string;
  strAwayTeam: string;
  intHomeScore: string | null;
  intAwayScore: string | null;
  intRound?: string | null;
  strVenue?: string | null;
  strStatus?: string | null;
}

function apiKey(): string {
  return process.env.THESPORTSDB_KEY || "3";
}

async function fetchEvents(path: string, cacheKey: string, ttl: number) {
  const { value, fromCache } = await cached<TsdbEvent[]>(cacheKey, ttl, async () => {
    const url = `${BASE_URL}/${apiKey()}/${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "SOLEIL/1.0" },
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      throw new ProviderError("thesportsdb", `Échec réseau : ${(e as Error).message}`);
    }
    if (!response.ok) {
      throw new ProviderError("thesportsdb", `Réponse HTTP ${response.status}`);
    }
    const json = (await response.json()) as { events: TsdbEvent[] | null };
    return json.events ?? [];
  });
  return { value, fromCache };
}

function toFixture(e: TsdbEvent, code: string, name: string, country: string): NormalizedFixture | null {
  const raw = e.strTimestamp ?? (e.dateEvent ? `${e.dateEvent}T${e.strTime || "15:00:00"}` : null);
  if (!raw) return null;
  const utcDate = new Date(raw.endsWith("Z") || raw.includes("+") ? raw : `${raw}Z`);
  if (Number.isNaN(utcDate.getTime())) return null;

  const hs = e.intHomeScore !== null && e.intHomeScore !== "" ? Number(e.intHomeScore) : null;
  const as = e.intAwayScore !== null && e.intAwayScore !== "" ? Number(e.intAwayScore) : null;

  const status: NormalizedFixture["status"] =
    hs !== null && as !== null ? "finished"
    : e.strStatus === "Match Postponed" || e.strStatus === "Postponed" ? "postponed"
    : "scheduled";

  return {
    externalId: `tsdb:${e.idEvent}`,
    sourceRef: `tsdb:${code}`,
    competition: { code, name, country },
    utcDate,
    status,
    homeTeamName: e.strHomeTeam,
    awayTeamName: e.strAwayTeam,
    homeScore: hs,
    awayScore: as,
    halfTimeHomeScore: null,
    halfTimeAwayScore: null,
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
    venue: e.strVenue || null,
    referee: null,
  };
}

export const theSportsDbProvider: DataProvider = {
  name: "thesportsdb",
  displayName: "TheSportsDB",
  priority: 2,
  rateLimitPerMinute: 30,
  capabilities: {
    results: true,
    fixtures: true,
    matchStats: false,
    xg: false,
    halfTimeScores: false,
  },

  isConfigured() {
    return true;
  },

  async fetchCompetition({ competitionCode }) {
    const leagueId = TSDB_LEAGUE_IDS[competitionCode];
    if (!leagueId) {
      throw new ProviderError(
        "thesportsdb",
        `Compétition non couverte : ${competitionCode}`,
        false,
      );
    }

    const league = { code: competitionCode, name: competitionCode, country: "" };

    // Deux appels : prochains matchs + 15 derniers résultats.
    const [next, past] = await Promise.all([
      fetchEvents(
        `eventsnextleague.php?id=${leagueId}`,
        `tsdb:next:${leagueId}`,
        15 * 60,
      ),
      fetchEvents(
        `eventspastleague.php?id=${leagueId}`,
        `tsdb:past:${leagueId}`,
        60 * 60,
      ),
    ]);

    const merged = [...next.value, ...past.value];
    const seen = new Set<string>();
    const fixtures: NormalizedFixture[] = [];

    for (const e of merged) {
      if (!e?.idEvent || seen.has(e.idEvent)) continue; // déduplication (§4)
      seen.add(e.idEvent);
      const f = toFixture(e, league.code, league.name, league.country);
      if (f) fixtures.push(f);
    }

    return {
      data: fixtures.sort((a, b) => a.utcDate.getTime() - b.utcDate.getTime()),
      requestCount: next.fromCache && past.fromCache ? 0 : 2,
      fromCache: next.fromCache && past.fromCache,
      fetchedAt: new Date(),
    };
  },
};
