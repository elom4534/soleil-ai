/**
 * ============================================================================
 * SOLEIL — Adaptateur LiveFootballApi
 * ============================================================================
 * Seule porte d'entrée vers le fournisseur. Le reste du code (moteur de
 * prédiction, interface, administration) ne voit JAMAIS une réponse brute :
 * il ne manipule que les formes normalisées définies dans `normalize.ts`.
 *
 * Correspondance entre l'interface demandée et les endpoints réellement
 * existants — l'audit du 29/09/2026 a montré que les noms ne sont pas ceux
 * d'API-SPORTS :
 *
 *   getMatches(date)                → /matches
 *   getCompetitionFixtures(id)      → /league_fixtures
 *   getMatchStatistics(id)          → /live_match_details   (statistiques)
 *   getEvents(id)                   → /live_match_details   (événements)
 *   getMatch(id)                    → /live_match_details   (les deux + métadonnées)
 *   getStandings(id)                → /league_standings
 *   getTeamStatistics(teamId)       → /team_matches         (bilan dérivable)
 *   getH2H(matchId)                 → /h2h
 *   getAvailableCompetitions()      → /leagues
 *
 * Une seule fonction par besoin : il n'existe pas d'endpoint « équipe » dédié
 * chez ce fournisseur, et toutes les données d'un match tiennent dans un appel
 * unique — le modèle de coût est donc « 1 crédit par match », pas
 * « 1 crédit par facette ».
 */

import type { ApiFootballLiveClient, CallResult } from "./client";
import {
  normalizeMatch,
  normalizeMatchList,
  normalizeStats,
  normalizeEvents,
  parseScore,
  type NormalizedEvent,
  type NormalizedMatch,
  type NormalizedMatchStats,
} from "./normalize";

/**
 * Les formes normalisées sont réexportées ici : l'adaptateur est la seule porte
 * d'entrée du fournisseur, ses appelants n'ont pas à connaître le module de
 * normalisation ni à en dépendre directement.
 */
export type { NormalizedEvent, NormalizedMatch, NormalizedMatchStats };
export type { NormalizedStatus, NormalizedTeamStats, StatKey } from "./normalize";

// ---------------------------------------------------------------------------
// Compétitions
// ---------------------------------------------------------------------------

export interface Competition {
  providerId: string;
  name: string;
  country: string;
  logo: string | null;
}

export interface CompetitionCatalogue {
  totalCountries: number;
  totalCompetitions: number;
  competitions: Competition[];
}

/** Catalogue complet des compétitions (`/leagues`). */
export async function getAvailableCompetitions(
  client: ApiFootballLiveClient,
): Promise<CallResult<CompetitionCatalogue>> {
  const result = await client.call<{ data?: unknown[] }>("leagues", {
    params: { lang: "en" },
    ttlSeconds: 86_400,
  });

  const groups = Array.isArray(result.data?.data) ? (result.data.data as unknown[]) : [];
  const competitions: Competition[] = [];
  const countries = new Set<string>();

  for (const group of groups) {
    const obj = group && typeof group === "object" ? (group as Record<string, unknown>) : {};
    const country = String(obj.country ?? "");
    if (country) countries.add(country);
    for (const entry of Array.isArray(obj.leagues) ? obj.leagues : []) {
      const league = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      competitions.push({
        providerId: String(league.id ?? ""),
        name: String(league.name ?? ""),
        country,
        logo: typeof league.logo === "string" ? league.logo : null,
      });
    }
  }

  return {
    ...result,
    data: {
      totalCountries: countries.size,
      totalCompetitions: competitions.length,
      competitions,
    },
  };
}

// ---------------------------------------------------------------------------
// Rencontres
// ---------------------------------------------------------------------------

/** Toutes les rencontres d'une date, toutes compétitions confondues (`/matches`). */
export async function getMatches(
  client: ApiFootballLiveClient,
  date: string,
): Promise<CallResult<NormalizedMatch[]>> {
  const result = await client.call<unknown>("matches", {
    params: { date, lang: "en" },
    ttlSeconds: calendarTtlSeconds(date),
  });
  return { ...result, data: normalizeMatchList(result.raw) };
}

/** Saison complète d'une compétition en un appel (`/league_fixtures`). */
export async function getCompetitionFixtures(
  client: ApiFootballLiveClient,
  leagueId: string,
  season?: string,
): Promise<CallResult<{ season: string | null; availableSeasons: string[]; matches: NormalizedMatch[] }>> {
  const result = await client.call<unknown>("league_fixtures", {
    params: { league_id: leagueId, season, lang: "en" },
    ttlSeconds: 3600,
  });

  const body = asBody(result.raw);
  const matches = normalizeMatchList(result.raw).map((match) => ({
    ...match,
    // Le pays est absent des calendriers : il est déjà porté par la compétition
    // demandée, on le rattache pour ne pas perdre la provenance.
    season: match.season ?? (typeof body.season === "string" ? body.season : null),
  }));

  return {
    ...result,
    data: {
      season: typeof body.season === "string" ? body.season : null,
      availableSeasons: Array.isArray(body.available_seasons) ? body.available_seasons.map(String) : [],
      matches,
    },
  };
}

/** Rencontres d'une équipe sur une saison (`/team_matches`). */
export async function getTeamMatches(
  client: ApiFootballLiveClient,
  teamId: string,
  season?: string,
): Promise<CallResult<{ season: string | null; availableSeasons: string[]; matches: NormalizedMatch[] }>> {
  const result = await client.call<unknown>("team_matches", {
    params: { team_id: teamId, season, lang: "en" },
    ttlSeconds: 3600,
  });
  const body = asBody(result.raw);
  return {
    ...result,
    data: {
      season: typeof body.season === "string" ? body.season : null,
      availableSeasons: Array.isArray(body.available_seasons) ? body.available_seasons.map(String) : [],
      matches: normalizeMatchList(result.raw),
    },
  };
}

// ---------------------------------------------------------------------------
// Détail d'un match
// ---------------------------------------------------------------------------

export interface MatchDetails {
  providerId: string;
  home: { providerId: string; name: string; logo: string | null; score: number | null };
  away: { providerId: string; name: string; logo: string | null; score: number | null };
  minute: number | null;
  isLive: boolean;
  stats: NormalizedMatchStats;
  events: NormalizedEvent[];
  venue: string | null;
  referee: string | null;
  playerOfTheMatch: string | null;
  lastUpdated: string | null;
  stale: boolean;
}

/**
 * Détail complet d'un match (`/live_match_details`) : statistiques ET
 * événements ET métadonnées, pour **un seul crédit**.
 *
 * `is_live` est relevé à part car un match terminé garde `stats` et `events`
 * mais perd son état « en direct » : c'est ce qui permet de constituer
 * l'historique après le coup de sifflet final.
 */
export async function getMatch(
  client: ApiFootballLiveClient,
  matchId: string,
  options: { liveTtlSeconds?: number; finishedTtlSeconds?: number } = {},
): Promise<CallResult<MatchDetails>> {
  const result = await client.call<unknown>("live_match_details", {
    params: { match_id: matchId, lang: "en" },
    // Un match en cours change en permanence ; un match terminé est définitif.
    ttlSeconds: options.finishedTtlSeconds ?? 3600,
  });

  const body = asBody(result.raw);
  const header = isObject(body.header) ? body.header : {};
  const home = isObject(header.home) ? header.home : {};
  const away = isObject(header.away) ? header.away : {};
  const status = isObject(header.status) ? header.status : {};
  const venue = isObject(body.venue) ? body.venue : {};

  const data: MatchDetails = {
    providerId: String(body.match_id ?? matchId),
    home: {
      providerId: String(home.id ?? ""),
      name: String(home.name ?? ""),
      logo: typeof home.logo === "string" ? home.logo : null,
      score: parseScore(home.score),
    },
    away: {
      providerId: String(away.id ?? ""),
      name: String(away.name ?? ""),
      logo: typeof away.logo === "string" ? away.logo : null,
      score: parseScore(away.score),
    },
    minute: status.minute === undefined || status.minute === null ? null : Number(status.minute),
    isLive: status.is_live === true,
    stats: normalizeStats(body.stats),
    events: normalizeEvents(body.events),
    venue: venue.name ? String(venue.name) : null,
    referee: body.referee ? String(body.referee) : null,
    playerOfTheMatch: isObject(body.player_of_the_match)
      ? String((body.player_of_the_match as Record<string, unknown>).name ?? "") || null
      : null,
    lastUpdated: body.last_updated ? String(body.last_updated) : null,
    stale: body.stale === true,
  };

  return { ...result, data };
}

/** Statistiques seules — même appel que `getMatch`, exposé pour la lisibilité. */
export async function getMatchStatistics(
  client: ApiFootballLiveClient,
  matchId: string,
): Promise<CallResult<NormalizedMatchStats>> {
  const result = await getMatch(client, matchId);
  return { ...result, data: result.data.stats };
}

/** Événements seuls — même appel que `getMatch`. */
export async function getEvents(
  client: ApiFootballLiveClient,
  matchId: string,
): Promise<CallResult<NormalizedEvent[]>> {
  const result = await getMatch(client, matchId);
  return { ...result, data: result.data.events };
}

// ---------------------------------------------------------------------------
// Classements
// ---------------------------------------------------------------------------

export interface StandingsRow {
  rank: number | null;
  team: { providerId: string; name: string; logo: string | null };
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  goalDiff: number | null;
  points: number | null;
  form: string | null;
  zone: string | null;
}

export interface Standings {
  season: string | null;
  availableSeasons: string[];
  stale: boolean;
  /** Classement général. */
  overall: StandingsRow[];
  /** Classement établi sur les seuls matchs à domicile. */
  home: StandingsRow[];
  /** Classement établi sur les seuls matchs à l'extérieur. */
  away: StandingsRow[];
}

function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toStandingsRows(groups: unknown): StandingsRow[] {
  const list = Array.isArray(groups) ? groups : [];
  const rows: StandingsRow[] = [];
  for (const group of list) {
    const obj = isObject(group) ? group : {};
    for (const entry of Array.isArray(obj.table) ? obj.table : []) {
      const row = isObject(entry) ? entry : {};
      const team = isObject(row.team) ? row.team : {};
      const zone = isObject(row.zone) ? row.zone : {};
      rows.push({
        rank: toNumber(row.rank),
        team: {
          providerId: String(team.id ?? ""),
          name: String(team.name ?? ""),
          logo: typeof team.logo === "string" ? team.logo : null,
        },
        played: toNumber(row.played),
        won: toNumber(row.won),
        drawn: toNumber(row.drawn),
        lost: toNumber(row.lost),
        goalsFor: toNumber(row.goals_for),
        goalsAgainst: toNumber(row.goals_against),
        goalDiff: toNumber(row.goal_diff),
        points: toNumber(row.points),
        form: typeof row.form === "string" && row.form !== "" ? row.form : null,
        zone: zone.name ? String(zone.name) : null,
      });
    }
  }
  return rows;
}

/** Classement complet d'une compétition (`/league_standings`). */
export async function getStandings(
  client: ApiFootballLiveClient,
  leagueId: string,
  season?: string,
): Promise<CallResult<Standings>> {
  const result = await client.call<unknown>("league_standings", {
    params: { league_id: leagueId, season, lang: "en" },
    ttlSeconds: 3600,
  });
  const body = asBody(result.raw);

  return {
    ...result,
    data: {
      season: typeof body.season === "string" ? body.season : null,
      availableSeasons: Array.isArray(body.available_seasons) ? body.available_seasons.map(String) : [],
      stale: body.stale === true,
      overall: toStandingsRows(body.standings),
      home: toStandingsRows(body.home_standings),
      away: toStandingsRows(body.away_standings),
    },
  };
}

// ---------------------------------------------------------------------------
// Confrontations directes
// ---------------------------------------------------------------------------

export interface H2H {
  providerId: string;
  homeForm: { date: string | null; home: string; away: string; score: string | null }[];
  awayForm: { date: string | null; home: string; away: string; score: string | null }[];
  meetings: { date: string | null; home: string; away: string; score: string | null }[];
  summary: { homeWins: number | null; awayWins: number | null; draws: number | null };
}

/**
 * Confrontations directes (`/h2h`).
 *
 * ⚠️ Ce endpoint est indexé par **identifiant de match**, pas par couple
 * d'équipes : il faut donc connaître le match pour interroger l'historique.
 */
export async function getH2H(
  client: ApiFootballLiveClient,
  matchId: string,
): Promise<CallResult<H2H>> {
  const result = await client.call<unknown>("h2h", {
    params: { match_id: matchId, lang: "en" },
    ttlSeconds: 3600,
  });
  const body = asBody(result.raw);
  const summary = isObject(body.h2h_summary) ? body.h2h_summary : {};

  const mapForms = (raw: unknown) =>
    (Array.isArray(raw) ? raw : []).map((entry) => {
      const obj = isObject(entry) ? entry : {};
      const home = isObject(obj.home) ? obj.home : {};
      const away = isObject(obj.away) ? obj.away : {};
      return {
        date: typeof obj.date === "string" ? obj.date : null,
        home: String(home.name ?? ""),
        away: String(away.name ?? ""),
        score: obj.score ? String(obj.score) : null,
      };
    });

  return {
    ...result,
    data: {
      providerId: String(body.match_id ?? matchId),
      homeForm: mapForms(body.home_form),
      awayForm: mapForms(body.away_form),
      meetings: mapForms(body.h2h),
      summary: {
        homeWins: toNumber(summary.home_wins),
        awayWins: toNumber(summary.away_wins),
        draws: toNumber(summary.draws),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function asBody(raw: unknown): Record<string, unknown> {
  const root = isObject(raw) ? raw : {};
  return isObject(root.data) ? root.data : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Durée de conservation d'un calendrier, selon la journée visée.
 *
 *   · **journée passée** — le calendrier est figé : 24 h.
 *   · **journée en cours** — elle bouge en continu (coup d'envoi décalé,
 *     report) : 5 minutes, assez court pour ne pas afficher une information
 *     périmée, assez long pour absorber plusieurs lectures d'affilée.
 *   · **journée future** — elle change peu, mais chaque relecture coûte un
 *     crédit si le cache est expiré : 1 heure.
 *
 * Politique volontairement centralisée ici : c'est le seul endroit qui décide
 * combien de temps une donnée payante reste gratuite à consulter.
 */
export function calendarTtlSeconds(date: string, now = new Date()): number {
  const today = now.toISOString().slice(0, 10);
  if (date < today) return 86_400;
  if (date === today) return 300;
  return 3_600;
}

/** Bilan dérivable des rencontres d'une équipe — sans appel supplémentaire. */
export interface TeamRecord {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  homePlayed: number;
}

/**
 * Calcule le bilan d'une équipe à partir de ses rencontres.
 *
 * Les rencontres non jouées sont écartées AVANT toute conversion numérique :
 * `Number(null)` vaut 0, ce qui transformerait chaque match à venir en match
 * nul — l'erreur exacte commise par la première version de la sonde.
 */
export function computeTeamRecord(matches: NormalizedMatch[], teamId: string): TeamRecord {
  const record: TeamRecord = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    homePlayed: 0,
  };

  for (const match of matches) {
    if (!match.finalScore) continue;
    const isHome = match.home.providerId === teamId;
    const isAway = match.away.providerId === teamId;
    if (!isHome && !isAway) continue;

    const own = isHome ? match.finalScore.home : match.finalScore.away;
    const other = isHome ? match.finalScore.away : match.finalScore.home;

    record.played += 1;
    if (isHome) record.homePlayed += 1;
    record.goalsFor += own;
    record.goalsAgainst += other;
    if (own > other) record.wins += 1;
    else if (own === other) record.draws += 1;
    else record.losses += 1;
  }

  return record;
}
