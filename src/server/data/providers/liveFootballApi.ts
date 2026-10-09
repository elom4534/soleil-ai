/**
 * ============================================================================
 * SOLEIL — Phase 16 · §4 et §10 · Connecteur LiveFootballApi (calendriers)
 * ============================================================================
 * Le connecteur `apiFootballLive` existait déjà (1 893 lignes : client protégé,
 * portefeuille de clés, normalisation) mais n'était **pas branché au registre
 * des fournisseurs** : seuls des scripts d'audit l'utilisaient. Ce fichier
 * l'inscrit dans l'architecture multi-source sans réécrire une ligne de ce qui
 * fonctionnait déjà.
 *
 * Ce qu'il apporte par rapport aux fournisseurs gratuits :
 *
 *   ✔ le **calendrier au jour le jour** (`/matches?date=…`) ;
 *   ✔ les **identifiants fournisseur** des équipes et des compétitions ;
 *   ✔ les **logos officiels** des deux équipes et des compétitions ;
 *   ✔ le **pays** de la compétition, tel que publié par la source ;
 *   ✔ les statuts normalisés (`preGame`, `postponed`, `cancelled`, …).
 *
 * Ce qu'il coûte : **1 crédit par journée interrogée.** Le coût est annoncé
 * avant l'appel, jamais découvert après. Le budget quotidien
 * (`SOLEIL_API_DAILY_BUDGET`) reste le plafond absolu : à 0, aucune requête ne
 * peut être émise, même par accident.
 */

import { ApiFootballLiveClient, PROVIDER_NAME } from "./apiFootballLive/client";
import { getMatches, type NormalizedMatch } from "./apiFootballLive/adapter";
import { resolvePreset } from "./apiFootballLive/presets";
import { ProviderError, type DataProvider, type NormalizedFixture } from "./types";

/**
 * Nom technique de la source, écrit dans `Match.dataSources`, `DataSource`,
 * `ApiCallLog`, `ApiCredential` et `providerRefs`.
 *
 * ⚠️ Ce nom est **celui du portefeuille de clés** (`api-football-live`), pas le
 * nom commercial du service. Deux noms pour une seule source rendraient le
 * journal (§26) ambigu : les clés, les appels et les rencontres doivent porter
 * la même étiquette.
 */
export const LFA_PROVIDER_NAME = PROVIDER_NAME;

/** Identifiant du preset du service (registre `PROVIDER_PRESETS`). */
export const LFA_SERVICE_PRESET = "live-football-api";

/**
 * Correspondance entre les codes internes de compétition (ceux de
 * football-data.co.uk, utilisés par tout l'historique) et les identifiants
 * opaques de LiveFootballApi.
 *
 * ⚠️ Ces identifiants doivent provenir d'une réponse réelle : ils ne sont donc
 * **pas figés dans le code**. Ils sont lus dans `LFA_LEAGUE_MAP`
 * (format `E0=lfa…,SP1=lfa…`), renseigné après vérification sur une réponse du
 * fournisseur. Sans cette variable, le connecteur refuse d'appeler plutôt que
 * de deviner une compétition.
 */
export function leagueMap(): Record<string, string> {
  const fromEnv = process.env.LFA_LEAGUE_MAP;
  const map: Record<string, string> = {};
  if (!fromEnv) return map;
  for (const pair of fromEnv.split(/[,\n;]+/)) {
    const [code, id] = pair.split("=").map((s) => s?.trim());
    if (code && id) map[code] = id;
  }
  return map;
}

/** Compétitions que ce connecteur sait interroger aujourd'hui. */
export function lfaSupportedCompetitions(): string[] {
  return Object.keys(leagueMap());
}

// ---------------------------------------------------------------------------
// Temps : date + heure + fuseau → horodatage
// ---------------------------------------------------------------------------

/**
 * Reconstruit l'horodatage UTC d'une rencontre.
 *
 * La source publie séparément `date` (`2026-10-03`) et `kickoff` (`14:00`), et
 * annonce `timezone: "UTC"` dans l'enveloppe. On n'interprète donc **jamais**
 * l'heure locale du serveur : tout est assemblé en UTC, explicitement.
 *
 * Renvoie `null` si l'un des deux composants manque : une rencontre sans heure
 * fiable n'est pas importée (§3, §8).
 */
export function kickoffToUtc(date: string | null, kickoff: string | null): Date | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = kickoff && /^\d{1,2}:\d{2}$/.test(kickoff) ? kickoff.padStart(5, "0") : null;
  if (!time) return null;
  const iso = `${date}T${time}:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Correspondance des statuts
// ---------------------------------------------------------------------------

/**
 * Traduit un statut de l'adaptateur vers le contrat commun `NormalizedFixture`.
 *
 * `unknown` n'est **jamais** rangé dans « programmé » par confort : une
 * rencontre dont l'état n'est pas reconnu reste inclassable, et
 * `mapStatus` (ingestion) la refusera plutôt que d'inventer un statut.
 */
export function toCommonStatus(status: NormalizedMatch["status"]): NormalizedFixture["status"] | "unknown" {
  switch (status) {
    case "finished":
      return "finished";
    case "live":
    case "half-time":
      return "live";
    case "postponed":
      return "postponed";
    case "cancelled":
      return "cancelled";
    case "scheduled":
      return "scheduled";
    default:
      return "unknown";
  }
}

/**
 * Une rencontre de l'adaptateur devient une rencontre du contrat commun.
 * Aucune statistique n'est inventée : le calendrier n'en fournit aucune
 * (le détail d'un match coûte 1 crédit à part), donc elles restent `null` (§13).
 */
export function toNormalizedFixture(
  match: NormalizedMatch,
  competition: { code: string; name: string; country: string },
): NormalizedFixture | null {
  const utcDate = kickoffToUtc(match.date, match.kickoff);
  if (!utcDate) return null;

  const home = match.home?.name?.trim() ?? "";
  const away = match.away?.name?.trim() ?? "";
  if (!home || !away) return null;

  const status = toCommonStatus(match.status);
  if (status === "unknown") return null;

  const finalScore = match.finalScore;

  return {
    externalId: match.providerId ? `${LFA_PROVIDER_NAME}:${match.providerId}` : "",
    sourceRef: `lfa:${competition.code}`,
    competition,
    utcDate,
    status,
    homeTeamName: home,
    awayTeamName: away,
    homeScore: finalScore?.home ?? null,
    awayScore: finalScore?.away ?? null,
    halfTimeHomeScore: match.halftime?.home ?? null,
    halfTimeAwayScore: match.halftime?.away ?? null,
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

// ---------------------------------------------------------------------------
// Identités et visuels non portés par le contrat commun
// ---------------------------------------------------------------------------

/**
 * Le contrat `NormalizedFixture` a été conçu pour football-data.co.uk, qui ne
 * fournit ni identifiant fournisseur ni logo. Ces informations circulent donc
 * **à côté** des rencontres, sans modifier le contrat existant — ce qui évite
 * de toucher à l'ingestion, au moteur et aux tests déjà validés.
 */
export interface SideloadTeam {
  providerRef: string;
  providerId: string;
  providerName: string;
  logo: string | null;
}

export interface SideloadLeague {
  providerRef: string;
  providerId: string;
  providerName: string;
  country: string;
  /** Libellé fournisseur de la compétition, tel que publié. */
  rawName: string;
}

export interface FixtureSideload {
  teams: SideloadTeam[];
  leagues: SideloadLeague[];
  /** `externalId` de rencontre → références fournisseur des deux équipes. */
  teamRefsByMatch: Record<string, { homeRef: string; awayRef: string }>;
  /** `externalId` de rencontre → référence fournisseur de la rencontre. */
  competitionByMatch: Record<string, { providerRef: string; country: string }>;
  /** `externalId` de rencontre → journée publiée par la source ("week"). */
  weekByMatch: Record<string, string>;
}

export function extractSideload(matches: NormalizedMatch[]): FixtureSideload {
  const teams = new Map<string, SideloadTeam>();
  const teamRefsByMatch: Record<string, { homeRef: string; awayRef: string }> = {};
  const leagues = new Map<string, SideloadLeague>();
  const competitionByMatch: Record<string, { providerRef: string; country: string }> = {};
  const weekByMatch: Record<string, string> = {};

  for (const match of matches) {
    const externalId = match.providerId ? `${LFA_PROVIDER_NAME}:${match.providerId}` : null;

    const leagueId = match.competition?.providerId;
    if (leagueId) {
      leagues.set(leagueId, {
        providerRef: `${LFA_PROVIDER_NAME}:${leagueId}`,
        providerId: leagueId,
        providerName: match.competition.name,
        country: match.competition.country ?? "",
        rawName: match.competition.name,
      });
    }
    if (externalId) {
      competitionByMatch[externalId] = {
        providerRef: leagueId ? `${LFA_PROVIDER_NAME}:${leagueId}` : "",
        country: match.competition?.country ?? "",
      };
      if (match.round) weekByMatch[externalId] = match.round;
    }

    if (externalId && match.home?.providerId && match.away?.providerId) {
      teamRefsByMatch[externalId] = {
        homeRef: `${LFA_PROVIDER_NAME}:${match.home.providerId}`,
        awayRef: `${LFA_PROVIDER_NAME}:${match.away.providerId}`,
      };
    }

    for (const side of [match.home, match.away]) {
      const id = side?.providerId;
      const name = side?.name;
      if (!id || !name) continue;
      const existing = teams.get(id);
      // Un logo déjà connu n'est jamais remplacé par une absence (§13).
      const logo = side.logo ?? existing?.logo ?? null;
      teams.set(id, {
        providerRef: `${LFA_PROVIDER_NAME}:${id}`,
        providerId: id,
        providerName: name,
        logo,
      });
    }
  }

  return {
    teams: [...teams.values()],
    leagues: [...leagues.values()],
    teamRefsByMatch,
    competitionByMatch,
    weekByMatch,
  };
}

// ---------------------------------------------------------------------------
// Fournisseur
// ---------------------------------------------------------------------------

let sharedClient: ApiFootballLiveClient | null = null;

/** Client partagé : un seul portefeuille de clés pour toute l'application. */
export async function lfaClient(): Promise<ApiFootballLiveClient> {
  if (!sharedClient) {
    // Le nom `api-football-live` désigne le portefeuille de clés ; le service
    // interrogé est LiveFootballApi, dont le preset porte l'identifiant `live-football-api`.
    sharedClient = new ApiFootballLiveClient(resolvePreset(LFA_SERVICE_PRESET));
    await sharedClient.init();
  }
  return sharedClient;
}

export interface LfaFixturesResult {
  fixtures: NormalizedFixture[];
  sideload: FixtureSideload;
  requestCount: number;
  fromCache: boolean;
  creditsSpent: number;
  creditsRemaining: number | null;
  /** Rencontres reçues toutes compétitions confondues, avant filtrage local. */
  received: number;
}

/**
 * Récupère les rencontres d'une journée, puis **ne conserve que les
 * compétitions demandées**.
 *
 * Le filtrage local est essentiel : une journée mondiale compte ~800 rencontres
 * dont l'immense majorité n'a aucun historique exploitable. Les importer toutes
 * gonflerait la base sans permettre une seule prédiction honnête
 * (§32 : pas d'import massif).
 */
export async function fetchFixturesForDate(input: {
  date: string;
  competitionCodes: string[];
  /** Autorise l'appel réseau. `false` = lecture du cache uniquement. */
  allowNetwork: boolean;
}): Promise<LfaFixturesResult> {
  const map = leagueMap();
  const wanted = input.competitionCodes.filter((code) => map[code]);
  if (wanted.length === 0) {
    throw new ProviderError(
      LFA_PROVIDER_NAME,
      "Aucune compétition mappée. Renseignez LFA_LEAGUE_MAP (ex. « E0=lfa…,SP1=lfa… ») après vérification sur une réponse réelle.",
      false,
    );
  }

  const codeByProviderId = new Map(wanted.map((code) => [map[code]!, code]));

  const client = await lfaClient();
  const result = await getMatches(client, input.date);

  if (!input.allowNetwork && !result.fromCache) {
    throw new ProviderError(
      LFA_PROVIDER_NAME,
      "Appel réseau refusé (mode hors ligne) et aucune valeur en cache : aucun crédit n'a été engagé.",
      false,
    );
  }

  const kept = result.data.filter((m) => codeByProviderId.has(m.competition?.providerId ?? ""));

  const fixtures: NormalizedFixture[] = [];
  for (const match of kept) {
    const code = codeByProviderId.get(match.competition.providerId)!;
    const fixture = toNormalizedFixture(match, {
      code,
      name: match.competition.name || code,
      country: match.competition.country ?? "",
    });
    if (fixture) fixtures.push(fixture);
  }

  const sideload = extractSideload(kept);
  sideload.leagues = sideload.leagues.filter((l) => codeByProviderId.has(l.providerId));

  const raw = result.raw as { credits_remaining?: unknown } | null;
  const remaining = raw && typeof raw === "object" ? Number(raw.credits_remaining) : NaN;

  return {
    fixtures,
    sideload,
    requestCount: result.fromCache ? 0 : 1,
    fromCache: result.fromCache,
    creditsSpent: result.fromCache ? 0 : 1,
    creditsRemaining: Number.isFinite(remaining) ? remaining : null,
    received: result.data.length,
  };
}

/**
 * Inscription dans le registre multi-source.
 *
 * `fetchCompetition` est imposée par le contrat `DataProvider`, mais ce
 * fournisseur raisonne par **journée**, pas par saison : la méthode échoue
 * explicitement plutôt que de renvoyer un résultat vide trompeur. Le pipeline
 * l'appelle via `fetchFixturesForDate`.
 */
export const liveFootballApiProvider: DataProvider = {
  name: LFA_PROVIDER_NAME,
  displayName: "LiveFootballApi",
  priority: 0,
  rateLimitPerMinute: 2,
  capabilities: {
    results: true,
    fixtures: true,
    matchStats: true,
    xg: true,
    halfTimeScores: true,
  },

  isConfigured() {
    return Boolean(process.env.API_FOOTBALL_LIVE_KEYS ?? process.env.API_FOOTBALL_LIVE_KEY_1);
  },

  async fetchCompetition() {
    throw new ProviderError(
      LFA_PROVIDER_NAME,
      "Ce fournisseur s'interroge par journée : utilisez fetchFixturesForDate({ date, competitionCodes }).",
      false,
    );
  },
};
