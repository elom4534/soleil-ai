/**
 * ============================================================================
 * API FOOTBALL LIVE — Empreintes de fournisseurs
 * ============================================================================
 * Le nom commercial « API Football Live » recouvre plusieurs services
 * distincts. Plutôt que de supposer lequel est utilisé, le connecteur accepte
 * une empreinte explicite : URL de base, style d'authentification et forme de
 * la réponse. Le reste du code est indépendant de ce choix.
 *
 * ⚠️ Aucune requête n'est émise tant que l'empreinte n'est pas confirmée par
 * la sonde (`npm run probe`).
 */

export type AuthStyle = "header" | "query";

/** Empreinte d'un fournisseur : tout ce qui dépend du service, isolé ici. */
export interface ProviderPreset {
  /** Identifiant interne. */
  id: string;
  /** Nom affiché dans l'administration. */
  displayName: string;
  /** URL de base, sans barre oblique finale. */
  baseUrl: string;
  /** Comment la clé est transmise. */
  authStyle: AuthStyle;
  /** Nom de l'en-tête (authStyle = header). */
  authHeader?: string;
  /** Nom du paramètre de requête (authStyle = query). */
  authParam?: string;
  /** Grille de lecture de la réponse : où se trouvent les données utiles. */
  responseShape: {
    /** Chemin vers le tableau de résultats, ex. ["response"]. */
    dataPath: string[];
    /** Chemin vers le bloc d'erreurs, s'il existe. */
    errorPath?: string[];
  };
  /** En-têtes indiquant le quota restant, s'ils sont fournis. */
  quotaHeaders?: {
    dailyLimit?: string;
    dailyRemaining?: string;
    minuteLimit?: string;
    minuteRemaining?: string;
  };
  /** Coût en crédits d'un appel (1 par défaut). */
  creditPerCall: number;
  /** Documentation, pour la traçabilité de l'audit. */
  docsUrl?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  /**
   * API-SPORTS / API-Football — le service le plus répandu sous ce nom.
   * Modèle de quota : requêtes/jour + requêtes/minute.
   */
  "api-football": {
    id: "api-football",
    displayName: "API-Football (API-SPORTS)",
    baseUrl: "https://v3.football.api-sports.io",
    authStyle: "header",
    authHeader: "x-apisports-key",
    responseShape: { dataPath: ["response"], errorPath: ["errors"] },
    quotaHeaders: {
      dailyLimit: "x-ratelimit-requests-limit",
      dailyRemaining: "x-ratelimit-requests-remaining",
      minuteLimit: "x-ratelimit-limit",
      minuteRemaining: "x-ratelimit-remaining",
    },
    creditPerCall: 1,
    docsUrl: "https://www.api-football.com/documentation-v3",
  },

  /**
   * API-Football via la place de marché RapidAPI.
   * Utile si les clés proviennent d'un abonnement RapidAPI plutôt que direct.
   */
  "api-football-rapid": {
    id: "api-football-rapid",
    displayName: "API-Football (via RapidAPI)",
    baseUrl: "https://api-football-v1.p.rapidapi.com/v3",
    authStyle: "header",
    authHeader: "X-RapidAPI-Key",
    responseShape: { dataPath: ["response"], errorPath: ["errors"] },
    creditPerCall: 1,
    docsUrl: "https://rapidapi.com/api-sports/api/api-football",
  },

  /**
   * LiveFootballApi — FOURNISSEUR RETENU PAR L'UTILISATEUR (29/09/2026).
   *
   * Particularités vérifiées dans la documentation officielle :
   *   · facturation explicite : 1 crédit par appel, crédits non expirants ;
   *   · le solde est annoncé DANS le corps de la réponse (`credits_remaining`),
   *     pas dans un en-tête — c'est ce qui permet de vérifier le coût réel ;
   *   · les échecs arrivent en HTTP 400/401/403/429/500/503 avec
   *     `{ success: false, message }` ;
   *   · les identifiants sont opaques (match_id de type « lfa… ») : ils ne
   *     peuvent pas être devinés, ils doivent provenir d'une réponse.
   */
  "live-football-api": {
    id: "live-football-api",
    displayName: "LiveFootballApi (live-football-api.com)",
    baseUrl: "https://live-football-api.com/api/v1",
    authStyle: "query",
    authParam: "api_key",
    responseShape: { dataPath: ["data"], errorPath: ["message"] },
    creditPerCall: 1,
    docsUrl: "https://www.live-football-api.com/docs",
  },

  /**
   * API Football (footballapi.com) — authentification par X-API-Key.
   */
  "apifootball-co": {
    id: "apifootball-co",
    displayName: "API Football (footballapi.com)",
    baseUrl: "https://api.footballapi.com/v3",
    authStyle: "header",
    authHeader: "X-API-Key",
    responseShape: { dataPath: ["response"] },
    creditPerCall: 1,
    docsUrl: "https://apifootball.co/documentation",
  },
};

/** Empreinte définie manuellement pour un service non répertorié. */
export interface CustomPresetInput {
  baseUrl: string;
  authStyle: AuthStyle;
  authHeader?: string;
  authParam?: string;
  dataPath?: string[];
  quotaHeaders?: ProviderPreset["quotaHeaders"];
  creditPerCall?: number;
}

export function buildCustomPreset(input: CustomPresetInput): ProviderPreset {
  return {
    id: "custom",
    displayName: `Fournisseur personnalisé (${new URL(input.baseUrl).hostname})`,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    authStyle: input.authStyle,
    authHeader: input.authHeader,
    authParam: input.authParam,
    responseShape: { dataPath: input.dataPath ?? ["response"] },
    quotaHeaders: input.quotaHeaders,
    creditPerCall: input.creditPerCall ?? 1,
  };
}

export function resolvePreset(id: string): ProviderPreset {
  const preset = PROVIDER_PRESETS[id];
  if (!preset) {
    const known = Object.keys(PROVIDER_PRESETS).join(", ");
    throw new Error(`Empreinte inconnue « ${id} ». Valeurs acceptées : ${known}, custom.`);
  }
  return preset;
}
