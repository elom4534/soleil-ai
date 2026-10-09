/**
 * ============================================================================
 * SOLEIL — Source de secours gratuite : calendrier à venir TheSportsDB
 * ============================================================================
 * Rôle : fournir au pipeline les **mêmes structures** que `fetchFixturesForDate`
 * (LiveFootballApi) à partir des événements TheSportsDB, pour que les matchs à
 * venir puissent être alimentés même quand le fournisseur payant est bloqué.
 *
 * Garanties conservées :
 *  • §13 — rien n'est inventé : chaque champ absent reste `null` ;
 *  • §15/§16 — les logos sont les URL publiées par la source
 *    (`strHomeTeamBadge`, `strAwayTeamBadge`, `strLeagueBadge`), jamais
 *    construites ;
 *  • §17 — l'identité est `the-sports-db:<idEvent|idTeam|idLeague>`,
 *    conservée dans `providerRefs` ;
 *  • §1 — le moteur n'est pas touché : ce module ne produit que des données.
 *
 * ⚠️ Ce module est **pur** (aucun réseau, aucun accès disque) : l'appelant
 * charge les événements (réseau ou cache) et les passe ici.
 */

import type { NormalizedFixture } from "./types";
import type { FixtureSideload, LfaFixturesResult, SideloadLeague, SideloadTeam } from "./liveFootballApi";

/** Identifiant du fournisseur dans `providerRefs` (aligné sur le registre). */
export const TSDB_PROVIDER_NAME = "the-sports-db";

/** Sous-ensemble utile d'un événement TheSportsDB (tous champs optionnels). */
export interface TsdbEvent {
  idEvent?: string | null;
  idLeague?: string | null;
  strLeague?: string | null;
  strCountry?: string | null;
  strSeason?: string | null;
  intRound?: string | number | null;
  strHomeTeam?: string | null;
  strAwayTeam?: string | null;
  idHomeTeam?: string | number | null;
  idAwayTeam?: string | number | null;
  strHomeTeamBadge?: string | null;
  strAwayTeamBadge?: string | null;
  strLeagueBadge?: string | null;
  dateEvent?: string | null;
  strTime?: string | null;
  strTimestamp?: string | null;
  strStatus?: string | null;
  strPostponed?: string | null;
  intHomeScore?: string | number | null;
  intAwayScore?: string | number | null;
}

/** Code interne ← identifiant de ligue TheSportsDB. */
export const TSDB_LEAGUE_CODES: Record<string, string> = {
  "4328": "E0",
  "4335": "SP1",
};

/** Nom de compétition attendu par l'historique local, par code interne. */
const COMPETITION_LABELS: Record<string, { name: string; country: string }> = {
  E0: { name: "Premier League", country: "England" },
  SP1: { name: "LaLiga", country: "Spain" },
};

/**
 * Statut commun à partir des libellés TheSportsDB.
 * Inconnu → `scheduled` : la page publique n'accepte que les rencontres à
 * venir et le filtre `isPredictable` reste l'arbitre final (§2/§3).
 */
export function tsdbStatusToCommon(event: TsdbEvent): NormalizedFixture["status"] {
  const postponed = (event.strPostponed ?? "").trim().toLowerCase();
  if (postponed && postponed !== "0" && postponed !== "no") return "postponed";
  const s = (event.strStatus ?? "").trim().toUpperCase();
  if (["FT", "AET", "PEN", "AFTER PEN", "AFTER EXTRA TIME", "MATCH FINISHED"].includes(s)) return "finished";
  if (["1H", "HT", "2H", "ET", "P", "LIVE", "INT", "IN PROGRESS"].includes(s)) return "live";
  if (["PST", "POSTPONED"].includes(s)) return "postponed";
  if (["CANCL", "CANC", "CANCELLED", "ABD", "ABANDONED", "SUSP", "AWARDED"].includes(s)) return "cancelled";
  return "scheduled";
}

/**
 * Date/heure UTC d'un événement, sans invention :
 * `strTimestamp` (ISO) d'abord, sinon `dateEvent` + `strTime`, en UTC.
 * Retourne `null` si aucune date exploitable (§13).
 */
export function tsdbEventUtcDate(event: TsdbEvent): Date | null {
  const ts = (event.strTimestamp ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(ts)) {
    return new Date(`${ts.slice(0, 19)}Z`);
  }
  const day = (event.dateEvent ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = (event.strTime ?? "").trim();
  const hhmmss = /^(\d{2}:\d{2})(:\d{2})?$/.test(time) ? (time.length === 5 ? `${time}:00` : time) : "00:00:00";
  return new Date(`${day}T${hhmmss}Z`);
}

/** Score entier depuis les champs TheSportsDB (`null` si absent/non joué). */
function intScore(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Convertit un événement TheSportsDB en `NormalizedFixture` (§13). */
export function tsdbEventToFixture(event: TsdbEvent): NormalizedFixture | null {
  const id = (event.idEvent ?? "").trim();
  const home = (event.strHomeTeam ?? "").trim();
  const away = (event.strAwayTeam ?? "").trim();
  const utcDate = tsdbEventUtcDate(event);
  const code = TSDB_LEAGUE_CODES[(event.idLeague ?? "").trim()] ?? null;
  if (!id || !home || !away || !utcDate || !code) return null;

  const labels = COMPETITION_LABELS[code] ?? { name: (event.strLeague ?? code).trim(), country: (event.strCountry ?? "").trim() };
  return {
    externalId: `${TSDB_PROVIDER_NAME}:${id}`,
    sourceRef: `tsdb:${id}`,
    competition: { code, name: labels.name, country: labels.country },
    utcDate,
    status: tsdbStatusToCommon(event),
    homeTeamName: home,
    awayTeamName: away,
    homeScore: intScore(event.intHomeScore),
    awayScore: intScore(event.intAwayScore),
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
    homeRedCards: null,
    awayRedCards: null,
    awayYellowCards: null,
    venue: null,
    referee: null,
  };
}

/** Construit le sideload (identités + logos publiés) pour un ensemble d'événements. */
export function tsdbEventsToSideload(events: TsdbEvent[]): FixtureSideload {
  const teams = new Map<string, SideloadTeam>();
  const leagues = new Map<string, SideloadLeague>();
  const teamRefsByMatch: Record<string, { homeRef: string; awayRef: string }> = {};
  const competitionByMatch: Record<string, { providerRef: string; country: string }> = {};
  const weekByMatch: Record<string, string> = {};

  for (const event of events) {
    const fixture = tsdbEventToFixture(event);
    if (!fixture) continue;
    const externalId = fixture.externalId;
    const leagueId = (event.idLeague ?? "").trim();

    if (leagueId) {
      leagues.set(leagueId, {
        providerRef: `${TSDB_PROVIDER_NAME}:${leagueId}`,
        providerId: leagueId,
        providerName: (event.strLeague ?? "").trim() || fixture.competition.name,
        country: (event.strCountry ?? "").trim() || fixture.competition.country,
        rawName: (event.strLeague ?? "").trim() || fixture.competition.name,
      });
      competitionByMatch[externalId] = {
        providerRef: `${TSDB_PROVIDER_NAME}:${leagueId}`,
        country: (event.strCountry ?? "").trim() || fixture.competition.country,
      };
    }
    const round = event.intRound;
    if (round !== undefined && round !== null && `${round}`.trim() !== "") {
      weekByMatch[externalId] = `${round}`.trim();
    }

    const sides = [
      { id: event.idHomeTeam, name: event.strHomeTeam, badge: event.strHomeTeamBadge },
      { id: event.idAwayTeam, name: event.strAwayTeam, badge: event.strAwayTeamBadge },
    ];
    const refs: string[] = [];
    for (const side of sides) {
      const id = (side.id ?? "").toString().trim();
      const name = (side.name ?? "").trim();
      if (!id || !name) continue;
      const providerRef = `${TSDB_PROVIDER_NAME}:${id}`;
      refs.push(providerRef);
      const existing = teams.get(id);
      // Un logo déjà connu n'est jamais remplacé par une absence (§13).
      const logo = (side.badge ?? "").trim() || existing?.logo || null;
      teams.set(id, {
        providerRef,
        providerId: id,
        providerName: name,
        logo,
      });
    }
    if (refs.length === 2) teamRefsByMatch[externalId] = { homeRef: refs[0]!, awayRef: refs[1]! };
  }

  return {
    teams: [...teams.values()],
    leagues: [...leagues.values()],
    teamRefsByMatch,
    competitionByMatch,
    weekByMatch,
  };
}

/**
 * Regroupe les événements convertis par journée UTC, et produit une fonction
 * `fetchDay` branchable sur `runUpcomingPipeline` (même contrat que
 * `fetchFixturesForDate`, mais sans réseau ni crédit).
 */
export function tsdbFetchDayFromEvents(events: TsdbEvent[]): (input: {
  date: string;
  competitionCodes: string[];
  allowNetwork: boolean;
}) => Promise<LfaFixturesResult> {
  const usable = events
    .map((event) => ({ event, fixture: tsdbEventToFixture(event) }))
    .filter((row): row is { event: TsdbEvent; fixture: NormalizedFixture } => row.fixture !== null);

  const sideload = tsdbEventsToSideload(usable.map((row) => row.event));
  const codes = new Set<string>();
  const byDate = new Map<string, NormalizedFixture[]>();
  for (const { fixture } of usable) {
    codes.add(fixture.competition.code);
    const key = fixture.utcDate.toISOString().slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push(fixture);
    byDate.set(key, list);
  }

  return async ({ date, competitionCodes }) => {
    const wanted = new Set(competitionCodes);
    const dayFixtures = (byDate.get(date) ?? []).filter((f) => codes.has(f.competition.code) && wanted.has(f.competition.code));
    return {
      fixtures: dayFixtures,
      sideload,
      requestCount: 0,
      fromCache: true,
      creditsSpent: 0,
      creditsRemaining: null,
      received: dayFixtures.length,
    };
  };
}
