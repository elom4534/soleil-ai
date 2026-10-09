/**
 * ============================================================================
 * SOLEIL — Contrat des fournisseurs de données
 * ============================================================================
 * §3 / §29 : l'architecture multi-source permet de remplacer un fournisseur
 * sans réécrire l'application. Chaque fournisseur implémente `DataProvider`
 * et déclare honnêtement ce qu'il sait fournir.
 */

/** Capacités déclarées d'un fournisseur — évite de lui demander l'impossible. */
export interface ProviderCapabilities {
  /** Résultats de matchs terminés. */
  results: boolean;
  /** Calendrier des matchs à venir. */
  fixtures: boolean;
  /** Statistiques avancées par match (tirs, corners, cartons…). */
  matchStats: boolean;
  /** Expected goals. */
  xg: boolean;
  /** Scores à la mi-temps. */
  halfTimeScores: boolean;
}

export interface NormalizedFixture {
  /** Identifiant du fournisseur. */
  externalId: string;
  /** Clé stable côté SOLEIL (fdcouk:slug ou tsdb:id). */
  sourceRef: string;
  competition: { code: string; name: string; country: string };
  utcDate: Date;
  status: "scheduled" | "finished" | "postponed" | "cancelled" | "live";
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number | null;
  awayScore: number | null;
  halfTimeHomeScore: number | null;
  halfTimeAwayScore: number | null;
  /** Statistiques avancées — `null` quand la source ne les fournit pas. */
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
  homeRedCards: number | null;
  awayRedCards: number | null;
  venue: string | null;
  referee: string | null;
}

export interface ProviderFetchResult<T> {
  data: T;
  /** Nombre de requêtes réseau réellement effectuées (économie d'API, §29). */
  requestCount: number;
  /** Vrai si la réponse provenait du cache. */
  fromCache: boolean;
  fetchedAt: Date;
}

export interface DataProvider {
  /** Identifiant technique, ex. « football-data-co-uk ». */
  readonly name: string;
  /** Libellé affiché dans l'administration. */
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Priorité : 1 = source principale de vérité. */
  readonly priority: number;
  /** Ligue réglementaire indicative (requêtes/minute), `null` si inconnue. */
  readonly rateLimitPerMinute: number | null;
  /** Vrai si le fournisseur est configuré (clé présente, etc.). */
  isConfigured(): boolean;
  /** Récupère les rencontres d'une compétition et d'une saison. */
  fetchCompetition(input: {
    competitionCode: string;
    season: string;
  }): Promise<ProviderFetchResult<NormalizedFixture[]>>;
}

/** Erreur typée pour distinguer les échecs réseau des échecs de données. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean = true,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}
