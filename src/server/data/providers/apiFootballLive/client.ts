/**
 * ============================================================================
 * API FOOTBALL LIVE — Client HTTP protégé
 * ============================================================================
 * Toutes les requêtes du fournisseur passent par ici. Le client applique
 * cinq garde-fous, dans cet ordre :
 *
 *   1. CACHE          — une information déjà obtenue n'est jamais redemandée.
 *   2. SINGLE-FLIGHT  — vingt consultations simultanées = un seul appel réseau.
 *   3. BUDGET         — plafond quotidien de crédits, refus au-delà.
 *   4. ROTATION       — bascule sur une autre clé en cas d'épuisement ou de 429.
 *   5. DÉDUPLICATION  — la même URL sur la même fenêtre de temps est mutualisée.
 *
 * Aucune de ces protections ne contourne une limite du fournisseur : le budget
 * est un plafond, jamais un contournement.
 */

import { cached, cacheGet } from "../../cache";
import { KeyRing, type CredentialStatus } from "./credentials";
import type { ProviderPreset } from "./presets";

/** Nom technique du fournisseur, utilisé pour le suivi en base. */
export const PROVIDER_NAME = "api-football-live";

export interface CallOptions {
  /** Paramètres de requête. */
  params?: Record<string, string | number | undefined | null>;
  /** Durée de vie du cache en secondes. */
  ttlSeconds?: number;
  /** Coût en crédits (déduit de l'empreinte si absent). */
  cost?: number;
  /** Autorise la réutilisation d'une valeur périmée en cas d'échec réseau. */
  allowStale?: boolean;
  /** Force l'appel réseau même si une valeur fraîche est en cache. */
  force?: boolean;
}

export interface CallResult<T = unknown> {
  data: T;
  fromCache: boolean;
  stale: boolean;
  creditsSpent: number;
  statusCode: number;
  /** Enveloppe brute, pour l'audit (diagnostic des champs disponibles). */
  raw: unknown;
  headers: Record<string, string>;
}

/** Erreur enrichie : permet à l'appelant de décider s'il faut réessayer. */
export class ApiFootballLiveError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no-credentials"
      | "budget-exceeded"
      | "rate-limited"
      | "quota-exhausted"
      | "unauthorized"
      | "not-found"
      | "server-error"
      | "network"
      | "invalid-response",
    public readonly statusCode: number | null = null,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "ApiFootballLiveError";
  }
}

export class ApiFootballLiveClient {
  private readonly ring: KeyRing;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly preset: ProviderPreset,
    options: { globalDailyBudget?: number } = {},
  ) {
    // Le plafond global vient de l'environnement. Par défaut, ZÉRO : aucune
    // requête ne peut être émise sans autorisation explicite. C'est la
    // garantie que rien ne consomme de crédits par accident.
    const budget = options.globalDailyBudget ?? Number(process.env.SOLEIL_API_DAILY_BUDGET ?? 0);
    this.ring = new KeyRing(PROVIDER_NAME, budget);
  }

  get credentials(): KeyRing {
    return this.ring;
  }

  get providerPreset(): ProviderPreset {
    return this.preset;
  }

  /** Initialisation explicite. Idempotente. */
  async init(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * Initialise le portefeuille de clés au premier besoin.
   *
   * `loading` retient la promesse en cours : si dix appels partent en même
   * temps sur un client neuf, `load()` n'est exécuté qu'une fois. Sans cela,
   * dix chargements concurrents tenteraient tous de créer les mêmes
   * enregistrements de clés.
   */
  private async ensureReady(): Promise<void> {
    if (this.ring.isLoaded) return;
    this.loading ??= this.ring.load();
    await this.loading;
  }

  /**
   * Exécute un appel d'endpoint.
   *
   * @param endpoint chemin relatif, ex. « fixtures »
   */
  async call<T = unknown>(endpoint: string, options: CallOptions = {}): Promise<CallResult<T>> {
    // Aucun appel ne part tant que le portefeuille n'est pas prêt : c'est ce
    // qui garantit que la rotation et le plafond sont toujours appliqués.
    await this.ensureReady();

    const cost = options.cost ?? this.preset.creditPerCall;
    const ttl = options.ttlSeconds ?? 3600;
    const url = this.buildUrl(endpoint, options.params ?? {});
    const cacheKey = `${PROVIDER_NAME}:${url}`;

    // --- 1. Cache : si une valeur fraîche existe, aucun crédit n'est engagé ---
    if (!options.force) {
      const hit = await cacheGet<T>(cacheKey);
      if (hit?.fresh) {
        return {
          data: hit.value,
          fromCache: true,
          stale: false,
          creditsSpent: 0,
          statusCode: 200,
          raw: hit.value,
          headers: {},
        };
      }
    }

    // --- 2. Budget : refus explicite si le plafond est atteint ---
    if (!this.ring.canSpend(cost)) {
      const reason = this.ring.isEmpty
        ? "Aucune clé configurée (API_FOOTBALL_LIVE_KEYS)."
        : `Plafond de crédits atteint : ${this.ring.usedToday}/${this.ring.budgetRemaining + this.ring.usedToday} consommés aujourd'hui. ` +
          `Ajustez SOLEIL_API_DAILY_BUDGET si vous souhaitez autoriser davantage.`;
      throw new ApiFootballLiveError(reason, this.ring.isEmpty ? "no-credentials" : "budget-exceeded", null, endpoint);
    }

    // --- 3. Single-flight + cache : délégué à `cached()` ---
    //    En cas d'échec réseau, une valeur périmée est préférée à une absence
    //    de donnée, et signalée comme telle.
    const result = await cached<{ data: T; statusCode: number; raw: unknown; headers: Record<string, string> }>(
      cacheKey,
      ttl,
      () => this.performRequest<T>(endpoint, url, cost),
      { allowStaleOnError: options.allowStale ?? true },
    );

    return {
      data: result.value.data,
      fromCache: result.fromCache,
      stale: result.stale,
      creditsSpent: result.fromCache ? 0 : cost,
      statusCode: result.value.statusCode,
      raw: result.value.raw,
      headers: result.value.headers,
    };
  }

  /** Émet réellement la requête HTTP, avec rotation de clé si nécessaire. */
  private async performRequest<T>(
    endpoint: string,
    url: string,
    cost: number,
  ): Promise<{ data: T; statusCode: number; raw: unknown; headers: Record<string, string> }> {
    const attempted = new Set<string>();

    // Deux tentatives au maximum : la clé courante, puis une autre si elle
    // est épuisée. Au-delà, on remonte l'erreur — pas de boucle de retrait.
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = this.ring.pick(cost);
      if (!credential) {
        throw new ApiFootballLiveError(
          "Toutes les clés sont épuisées ou plafonnées pour aujourd'hui.",
          "quota-exhausted",
          null,
          endpoint,
        );
      }
      if (attempted.has(credential.hash)) break;
      attempted.add(credential.hash);

      const startedAt = Date.now();
      // L'authentification en query est appliquée ici, sur l'URL réellement
      // appelée. La clé du cache, elle, ne contient jamais de secret.
      const requestUrl = this.applyQueryAuth(url, credential);
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          headers: this.buildHeaders(credential),
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        await this.ring.recordError({
          credential,
          endpoint,
          error: `Échec réseau : ${(error as Error).message}`,
          statusCode: null,
          fatal: false,
        });
        throw new ApiFootballLiveError(
          `Échec réseau sur ${endpoint} : ${(error as Error).message}`,
          "network",
          null,
          endpoint,
        );
      }

      const durationMs = Date.now() - startedAt;
      const headers = captureQuotaHeaders(response.headers, this.preset);
      const quota = parseQuota(headers, this.preset);

      // --- Rotation : quota épuisé côté fournisseur ---
      if (response.status === 429) {
        credential.dailyRemaining = 0;
        await this.ring.recordError({
          credential,
          endpoint,
          error: "Quota du fournisseur atteint (HTTP 429)",
          statusCode: 429,
          fatal: false,
        });
        // Si une autre clé existe, on bascule immédiatement.
        if (this.ring.all.filter((c) => !c.disabled).length > attempted.size) continue;
        throw new ApiFootballLiveError(
          "Quota du fournisseur atteint (HTTP 429). Aucune autre clé disponible.",
          "rate-limited",
          429,
          endpoint,
        );
      }

      // --- Clé invalide : désactivation définitive de cette clé ---
      if (response.status === 401 || response.status === 403) {
        // Le message du fournisseur est la seule explication disponible : on le
        // conserve au lieu de le perdre (403 peut signifier « crédits
        // insuffisants », « plafond journalier » ou « clé inactive » — trois
        // causes très différentes à diagnostiquer).
        const providerMessage = await readErrorMessage(response);
        await this.ring.recordError({
          credential,
          endpoint,
          error: `Clé refusée (HTTP ${response.status})${providerMessage ? ` — ${providerMessage}` : ""}`,
          statusCode: response.status,
          fatal: true,
        });
        if (this.ring.all.filter((c) => !c.disabled).length > 0) continue;
        throw new ApiFootballLiveError(
          `Clé refusée par le fournisseur (HTTP ${response.status})${providerMessage ? ` — « ${providerMessage} »` : ""}. ` +
            `Vérifiez le solde de crédits, le plafond journalier et l'état de la clé.`,
          "unauthorized",
          response.status,
          endpoint,
        );
      }

      if (response.status === 404) {
        await this.ring.recordUsage({
          credential, endpoint, cost: 0, statusCode: 404, durationMs, fromCache: false, quota,
        });
        throw new ApiFootballLiveError(
          `Endpoint introuvable sur cette empreinte : « ${endpoint} » (HTTP 404).`,
          "not-found",
          404,
          endpoint,
        );
      }

      if (response.status >= 500) {
        await this.ring.recordError({
          credential,
          endpoint,
          error: `Erreur serveur (HTTP ${response.status})`,
          statusCode: response.status,
          fatal: false,
        });
        throw new ApiFootballLiveError(
          `Erreur serveur du fournisseur (HTTP ${response.status}).`,
          "server-error",
          response.status,
          endpoint,
        );
      }

      if (!response.ok) {
        await this.ring.recordError({
          credential,
          endpoint,
          error: `HTTP ${response.status}`,
          statusCode: response.status,
          fatal: false,
        });
        throw new ApiFootballLiveError(
          `Réponse HTTP ${response.status} sur ${endpoint}.`,
          "server-error",
          response.status,
          endpoint,
        );
      }

      // --- Réponse exploitable : le crédit est facturé ---
      // Le corps est lu AVANT l'enregistrement : LiveFootballApi publie son
      // solde dans la réponse (`credits_remaining`), pas dans les en-têtes.
      // Se fier aux en-têtes laissait `ApiCallLog.quotaAfter` vide, donc tout
      // suivi de crédits impossible — or la phase 10 l'exige.
      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch {
        // Corps illisible : le crédit est quand même consommé, on le trace.
        raw = null;
      }
      const bodyQuota = readBodyQuota(raw);

      await this.ring.recordUsage({
        credential,
        endpoint,
        cost,
        statusCode: response.status,
        durationMs,
        fromCache: false,
        quota: {
          ...quota,
          dailyRemaining: bodyQuota?.remaining ?? quota.dailyRemaining,
        },
      });

      const data = extractData<T>(raw as T, this.preset);

      return { data, statusCode: response.status, raw, headers };
    }

    throw new ApiFootballLiveError(
      "Aucune clé exploitable après rotation.",
      "quota-exhausted",
      null,
      endpoint,
    );
  }

  /** Construit l'URL complète, en plaçant la clé si l'authentification est en query. */
  private buildUrl(endpoint: string, params: Record<string, string | number | undefined | null>): string {
    const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
    const url = new URL(`${this.preset.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    // La clé en query est injectée au dernier moment par `buildHeaders` via
    // `applyQueryAuth`, donc l'URL de cache reste stable entre les clés — c'est
    // indispensable pour que le cache soit mutualisé entre elles.
    return url.toString();
  }

  private buildHeaders(credential: CredentialStatus): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "SOLEIL/1.0 (+analyse statistique)",
    };
    if (this.preset.authStyle === "header" && this.preset.authHeader) {
      headers[this.preset.authHeader] = credential.secret;
    }
    return headers;
  }

  /**
   * Applique la clé en query sur l'URL réelle.
   * Séparé de `buildUrl` pour que la clé du cache ne contienne jamais de secret.
   */
  private applyQueryAuth(url: string, credential: CredentialStatus): string {
    if (this.preset.authStyle !== "query" || !this.preset.authParam) return url;
    const u = new URL(url);
    u.searchParams.set(this.preset.authParam, credential.secret);
    return u.toString();
  }

  /**
   * Alias explicite pour les empreintes utilisant l'authentification en query.
   * Le chemin de traitement est identique : cache, budget, rotation et
   * journalisation s'appliquent de la même façon.
   */
  async fetchWithAuth<T = unknown>(endpoint: string, options: CallOptions = {}): Promise<CallResult<T>> {
    return this.call<T>(endpoint, options);
  }
}

// ---------------------------------------------------------------------------
// Extraction générique et lecture des quotas
// ---------------------------------------------------------------------------

/**
 * Extrait le tableau utile de la réponse, selon le chemin déclaré par
 * l'empreinte. Le chemin est générique afin de ne rien supposer de la forme
 * exacte avant l'audit.
 */
export function extractData<T>(raw: unknown, preset: ProviderPreset): T {
  let cursor: unknown = raw;
  for (const segment of preset.responseShape.dataPath) {
    if (cursor && typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      // Chemin absent : on renvoie la réponse entière plutôt que `undefined`.
      // L'adaptateur décidera de l'interprétation après l'audit.
      return raw as T;
    }
  }
  return cursor as T;
}

/**
 * Solde publié dans le CORPS de la réponse.
 *
 * LiveFootballApi renvoie `credits_remaining` dans l'enveloppe. On le lit ici
 * plutôt que dans les en-têtes (qui n'en contiennent aucun). Une absence reste
 * une absence : la fonction renvoie `null`, elle n'estime jamais un solde.
 */
export function readBodyQuota(raw: unknown): { remaining: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const remaining = toFiniteNumber(body.credits_remaining ?? body.creditsRemaining);
  if (remaining === null) return null;
  return { remaining };
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function captureQuotaHeaders(
  headers: Headers,
  preset: ProviderPreset,
): Record<string, string> {
  const captured: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.includes("ratelimit") || lower.includes("quota") || lower.includes("credit")) {
      captured[lower] = value;
    }
  });
  void preset;
  return captured;
}

export function parseQuota(
  headers: Record<string, string>,
  preset: ProviderPreset,
): {
  dailyLimit?: number;
  dailyRemaining?: number;
  minuteLimit?: number;
  minuteRemaining?: number;
} {
  const read = (name?: string) => {
    if (!name) return undefined;
    const value = headers[name.toLowerCase()];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    dailyLimit: read(preset.quotaHeaders?.dailyLimit),
    dailyRemaining: read(preset.quotaHeaders?.dailyRemaining),
    minuteLimit: read(preset.quotaHeaders?.minuteLimit),
    minuteRemaining: read(preset.quotaHeaders?.minuteRemaining),
  };
}

/**
 * Lit le message d'erreur publié par le fournisseur (`{ success:false, message }`).
 *
 * Cette lecture est **best effort** : une réponse illisible ne doit jamais
 * masquer le code HTTP, qui reste l'information principale. Le texte renvoyé est
 * tronqué, car il finit dans un journal.
 */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      const message = parsed.message ?? parsed.error;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
    } catch {
      // Réponse non JSON (page d'erreur HTML) : on garde un extrait brut utile.
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}
