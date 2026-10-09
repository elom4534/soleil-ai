/**
 * ============================================================================
 * Fournisseur — football-data.org
 * ============================================================================
 * Source : https://www.football-data.org/
 * Nécessite une clé API gratuite : `FOOTBALL_DATA_API_KEY`.
 *
 * Sans clé, ce fournisseur se déclare **non configuré** et n'est jamais
 * interrogé. L'application reste pleinement fonctionnelle sans lui.
 *
 * Ce que ce fournisseur apporte en plus :
 *   ✔ calendrier officiel complet (matchs à venir)
 *   ✔ logos d'équipes et de compétitions
 */

import { cached } from "../cache";
import { ProviderError, type DataProvider, type NormalizedFixture } from "./types";

const BASE_URL = "https://api.football-data.org/v4";

const COMPETITION_CODES: Record<string, string> = {
  E0: "PL",
  E1: "ELC",
  SP1: "PD",
  D1: "BL1",
  I1: "SA",
  F1: "FL1",
  N1: "DED",
  P1: "PPL",
  B1: "BSA",
  T1: "TR1",
  G1: "GSL",
  SC0: "PPL",
};

interface FdoMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  homeTeam: { id: number; name: string; shortName?: string | null; tla?: string | null; crest?: string | null };
  awayTeam: { id: number; name: string; shortName?: string | null; tla?: string | null; crest?: string | null };
  score: {
    winner: string | null;
    fullTime: { home: number | null; away: number | null };
    halfTime: { home: number | null; away: number | null };
  };
  venue?: string | null;
  referees?: { name: string }[];
  competition?: { name: string; area?: { name: string } };
}

const STATUS_MAP: Record<string, NormalizedFixture["status"]> = {
  SCHEDULED: "scheduled",
  TIMED: "scheduled",
  FINISHED: "finished",
  POSTPONED: "postponed",
  SUSPENDED: "postponed",
  CANCELLED: "cancelled",
  IN_PLAY: "live",
  PAUSED: "live",
};

export const footballDataOrgProvider: DataProvider = {
  name: "football-data-org",
  displayName: "football-data.org",
  priority: 1,
  rateLimitPerMinute: 10,
  capabilities: {
    results: true,
    fixtures: true,
    matchStats: false,
    xg: false,
    halfTimeScores: true,
  },

  isConfigured() {
    return Boolean(process.env.FOOTBALL_DATA_API_KEY);
  },

  async fetchCompetition({ competitionCode }) {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "football-data-org",
        "Clé absente : FOOTBALL_DATA_API_KEY non configurée",
        false,
      );
    }

    const code = COMPETITION_CODES[competitionCode];
    if (!code) {
      throw new ProviderError("football-data-org", `Compétition non couverte : ${competitionCode}`, false);
    }

    const { value, fromCache } = await cached<NormalizedFixture[]>(
      `fdo:${code}`,
      30 * 60,
      async () => {
        const url = `${BASE_URL}/competitions/${code}/matches`;
        let response: Response;
        try {
          response = await fetch(url, {
            headers: { "X-Auth-Token": apiKey, "User-Agent": "SOLEIL/1.0" },
            cache: "no-store",
            signal: AbortSignal.timeout(25_000),
          });
        } catch (e) {
          throw new ProviderError("football-data-org", `Échec réseau : ${(e as Error).message}`);
        }
        if (response.status === 429) {
          throw new ProviderError("football-data-org", "Quota d'appels dépassé (HTTP 429)");
        }
        if (!response.ok) {
          throw new ProviderError("football-data-org", `Réponse HTTP ${response.status}`);
        }
        const json = (await response.json()) as { matches: FdoMatch[] };
        return (json.matches ?? []).map((m) => normalize(m, competitionCode));
      },
    );

    return { data: value, requestCount: fromCache ? 0 : 1, fromCache, fetchedAt: new Date() };
  },
};

function normalize(m: FdoMatch, competitionCode: string): NormalizedFixture {
  return {
    externalId: `fdo:${m.id}`,
    sourceRef: "fdo",
    competition: {
      code: competitionCode,
      name: m.competition?.name ?? competitionCode,
      country: m.competition?.area?.name ?? "",
    },
    utcDate: new Date(m.utcDate),
    status: STATUS_MAP[m.status] ?? "scheduled",
    homeTeamName: m.homeTeam.shortName || m.homeTeam.name,
    awayTeamName: m.awayTeam.shortName || m.awayTeam.name,
    homeScore: m.score.fullTime.home,
    awayScore: m.score.fullTime.away,
    halfTimeHomeScore: m.score.halfTime.home,
    halfTimeAwayScore: m.score.halfTime.away,
    homeXg: null,
    awayXg: null,
    homeShots: null,
    awayShots: null,
    homeShotsOnTarget: null,
    awayShotsOnTarget: null,
    homeCorners: null,
    awayCorners: null,
    homeYellowCards: null,
    homeRedCards: null,
    awayRedCards: null,
    awayYellowCards: null,
    venue: m.venue ?? null,
    referee: m.referees?.[0]?.name ?? null,
  };
}
