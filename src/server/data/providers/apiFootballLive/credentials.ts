/**
 * ============================================================================
 * API FOOTBALL LIVE — Gestion des clés et protection des crédits
 * ============================================================================
 * §13 ROTATION DES CLÉS
 *   Plusieurs clés du même fournisseur peuvent exister. Elles sont utilisées
 *   en rotation séquentielle : la clé 1 sert jusqu'à épuisement, puis la clé 2
 *   prend le relais.
 *
 * ⚠️ LIMITE VOLONTAIRE
 *   Cette rotation ne contourne aucune limite : elle agrège des quotas
 *   légitimement acquis. Le fournisseur applique de toute façon une limite
 *   par IP, et l'usage de plusieurs clés doit être autorisé par les conditions
 *   du service. SOLEIL ne fait rien pour dissimuler son identité réseau.
 *
 * §30 SÉCURITÉ
 *   Les clés ne sont jamais écrites en base. Seule leur empreinte SHA-256 est
 *   stockée, pour permettre le suivi de consommation sans exposer le secret.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export interface CredentialStatus {
  /** Index dans la liste fournie par l'environnement. */
  index: number;
  /** Libellé affiché. */
  label: string;
  /** Empreinte, jamais la clé. */
  hash: string;
  /** Clé en clair — conservée en mémoire uniquement. */
  secret: string;
  usedToday: number;
  usedTotal: number;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
  /** Vrai si la clé a été désactivée à la suite d'une erreur définitive. */
  disabled: boolean;
  lastError: string | null;
}

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Lit les clés depuis l'environnement.
 *
 * Formats acceptés :
 *   API_FOOTBALL_LIVE_KEYS="clé1,clé2,clé3"
 *   API_FOOTBALL_LIVE_KEY_1 / _2 / _3 … (numérotation libre)
 *   API_FOOTBALL_KEY, API_SPORTS_KEY (rétrocompatibilité)
 *
 * Les doublons et les valeurs vides sont écartés.
 */
export function readKeysFromEnv(): string[] {
  const keys: string[] = [];

  const multi = process.env.API_FOOTBALL_LIVE_KEYS;
  if (multi) {
    keys.push(...multi.split(/[,\n;]+/).map((k) => k.trim()));
  }

  // Clés numérotées, triées par index croissant.
  const numbered = Object.entries(process.env)
    .filter(([name]) => /^API_FOOTBALL_LIVE_KEY_\d+$/.test(name))
    .sort(([a], [b]) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
    .map(([, value]) => value ?? "");
  keys.push(...numbered);

  // Rétrocompatibilité avec les emplacements créés lors de la V1.
  for (const legacy of ["API_FOOTBALL_KEY", "API_SPORTS_KEY", "FOOTBALL_DATA_API_KEY"]) {
    const value = process.env[legacy];
    if (value && value.trim()) keys.push(value.trim());
  }

  return [...new Set(keys.filter((k) => k.length >= 8))];
}

/**
 * Anneau de clés. Sélectionne une clé disponible et tient à jour les compteurs
 * de consommation, avec remise à zéro quotidienne.
 */
export class KeyRing {
  private statuses: CredentialStatus[] = [];
  private loaded = false;

  constructor(
    private readonly provider: string,
    /** Plafond absolu de requêtes par jour, toutes clés confondues. */
    private readonly globalDailyBudget: number,
  ) {}

  /** Charge (ou crée) le suivi de chaque clé en base. */
  async load(): Promise<void> {
    const secrets = readKeysFromEnv();
    const today = startOfDayUtc(new Date());

    const records = await prisma.apiCredential.findMany({ where: { provider: this.provider } });

    this.statuses = await Promise.all(
      secrets.map(async (secret, index) => {
        const hash = hashKey(secret);
        let record = records.find((r) => r.keyHash === hash);

        if (!record) {
          record = await prisma.apiCredential.create({
            data: {
              provider: this.provider,
              keyHash: hash,
              label: `Clé ${index + 1}`,
            },
          });
        }

        // Remise à zéro du compteur si le jour a changé.
        if (record.usageDay < today) {
          record = await prisma.apiCredential.update({
            where: { id: record.id },
            data: { usedToday: 0, usageDay: today, usageByEndpoint: {}, consecutiveErrors: 0 },
          });
        }

        return {
          index,
          label: record.label ?? `Clé ${index + 1}`,
          hash,
          secret,
          usedToday: record.usedToday,
          usedTotal: record.usedTotal,
          dailyLimit: record.dailyLimit,
          dailyRemaining: record.dailyRemaining,
          minuteRemaining: record.minuteRemaining,
          disabled: !record.isActive,
          lastError: record.lastError,
        };
      }),
    );

    this.loaded = true;
  }

  /**
   * Le portefeuille est-il prêt ?
   *
   * Cet accesseur existe pour que les appelants puissent TESTER l'état sans
   * déclencher d'exception. Le garde-fou « if (!ring.all) » de l'ancien code
   * lisait `all`, qui lève quand le portefeuille n'est pas chargé : le contrôle
   * échouait donc au lieu d'initialiser. Un contrôle qui plante au lieu de
   * vérifier n'est pas un contrôle.
   */
  get isLoaded(): boolean {
    return this.loaded;
  }

  get all(): CredentialStatus[] {
    if (!this.loaded) throw new Error("KeyRing non initialisé : appelez load() au préalable.");
    return this.statuses;
  }

  get isEmpty(): boolean {
    return this.loaded && this.statuses.length === 0;
  }

  /** Total consommé aujourd'hui, toutes clés confondues. */
  get usedToday(): number {
    return this.statuses.reduce((a, s) => a + s.usedToday, 0);
  }

  /** Budget restant avant plafond global. */
  get budgetRemaining(): number {
    return Math.max(0, this.globalDailyBudget - this.usedToday);
  }

  /**
   * Vrai si au moins une clé peut encore servir, compte tenu du plafond global
   * et des quotas connus.
   */
  canSpend(credits = 1): boolean {
    if (!this.loaded || this.statuses.length === 0) return false;
    if (this.budgetRemaining < credits) return false;
    return this.statuses.some(
      (s) =>
        !s.disabled &&
        (s.dailyRemaining === null || s.dailyRemaining >= credits) &&
        (s.dailyLimit === null || s.usedToday + credits <= s.dailyLimit),
    );
  }

  /**
   * Sélectionne la prochaine clé utilisable, en respectant la rotation :
   * l'ordre de déclaration détermine la priorité, une clé épuisée est ignorée.
   */
  pick(credits = 1): CredentialStatus | null {
    if (!this.canSpend(credits)) return null;
    for (const status of this.statuses) {
      if (status.disabled) continue;
      if (status.dailyRemaining !== null && status.dailyRemaining < credits) continue;
      if (status.dailyLimit !== null && status.usedToday + credits > status.dailyLimit) continue;
      return status;
    }
    return null;
  }

  /** Enregistre une consommation réussie et met à jour les quotas connus. */
  async recordUsage(input: {
    credential: CredentialStatus;
    endpoint: string;
    cost: number;
    statusCode: number;
    durationMs: number;
    fromCache: boolean;
    quota?: {
      dailyLimit?: number | null;
      dailyRemaining?: number | null;
      minuteLimit?: number | null;
      minuteRemaining?: number | null;
    };
  }): Promise<void> {
    const { credential, endpoint, cost, statusCode, durationMs, fromCache, quota } = input;

    if (!fromCache) {
      credential.usedToday += cost;
      credential.usedTotal += cost;
      if (quota?.dailyLimit != null) credential.dailyLimit = quota.dailyLimit;
      if (quota?.dailyRemaining != null) credential.dailyRemaining = quota.dailyRemaining;
      if (quota?.minuteRemaining != null) credential.minuteRemaining = quota.minuteRemaining;
    }

    await Promise.all([
      fromCache
        ? Promise.resolve()
        : prisma.apiCredential.update({
            where: { provider_keyHash: { provider: this.provider, keyHash: credential.hash } },
            data: {
              usedToday: credential.usedToday,
              usedTotal: credential.usedTotal,
              dailyLimit: credential.dailyLimit,
              dailyRemaining: credential.dailyRemaining,
              minuteLimit: quota?.minuteLimit ?? undefined,
              minuteRemaining: credential.minuteRemaining,
              lastUsedAt: new Date(),
              consecutiveErrors: 0,
              lastError: null,
              usageByEndpoint: await this.incrementEndpoint(credential.hash, endpoint, cost),
            },
          }),
      prisma.apiCallLog.create({
        data: {
          provider: this.provider,
          credentialId: null,
          endpoint,
          cost: fromCache ? 0 : cost,
          statusCode,
          durationMs,
          fromCache,
          quotaAfter: credential.dailyRemaining,
        },
      }),
    ]);
  }

  /** Conserve la répartition de consommation par endpoint pour l'administration. */
  private async incrementEndpoint(keyHash: string, endpoint: string, cost: number) {
    const record = await prisma.apiCredential.findUnique({
      where: { provider_keyHash: { provider: this.provider, keyHash } },
      select: { usageByEndpoint: true },
    });
    const current = (record?.usageByEndpoint as Record<string, number> | null) ?? {};
    current[endpoint] = (current[endpoint] ?? 0) + cost;
    return current as never;
  }

  /**
   * Consigne une erreur. Une clé invalide ou révoquée est désactivée
   * définitivement ; une erreur transitoire incrémente le compteur.
   */
  async recordError(input: {
    credential: CredentialStatus;
    endpoint: string;
    error: string;
    statusCode: number | null;
    fatal: boolean;
  }): Promise<void> {
    const { credential, endpoint, error, statusCode, fatal } = input;

    const record = await prisma.apiCredential.findUnique({
      where: { provider_keyHash: { provider: this.provider, keyHash: credential.hash } },
    });
    const consecutive = (record?.consecutiveErrors ?? 0) + 1;
    if (fatal) credential.disabled = true;
    credential.lastError = error;

    await Promise.all([
      prisma.apiCredential.update({
        where: { provider_keyHash: { provider: this.provider, keyHash: credential.hash } },
        data: {
          isActive: fatal ? false : undefined,
          lastError: error,
          lastErrorAt: new Date(),
          consecutiveErrors: consecutive,
        },
      }),
      prisma.apiCallLog.create({
        data: {
          provider: this.provider,
          endpoint,
          cost: 0,
          statusCode,
          error,
        },
      }),
    ]);
  }

  /** Rapport lisible, utilisé par la sonde et le tableau de bord. */
  async report(): Promise<string> {
    // Un rapport doit dire la vérité sur son propre état : afficher « 0 utilisé »
    // quand rien n'a été chargé laisserait croire à un portefeuille vide alors
    // qu'il est simplement non initialisé.
    if (!this.loaded) return "Portefeuille non initialisé (load() non appelé).";
    if (this.isEmpty) return "Aucune clé configurée.";
    const lines = this.statuses.map((s) => {
      const parts = [
        `${s.label}`,
        s.disabled ? "DÉSACTIVÉE" : "active",
        `utilisée aujourd'hui : ${s.usedToday}`,
      ];
      if (s.dailyLimit !== null) parts.push(`plafond/jour : ${s.dailyLimit}`);
      if (s.dailyRemaining !== null) parts.push(`restant annoncé : ${s.dailyRemaining}`);
      if (s.lastError) parts.push(`dernière erreur : ${s.lastError}`);
      return `  · ${parts.join(" · ")}`;
    });
    return [
      ...lines,
      `  Budget global : ${this.usedToday}/${this.globalDailyBudget} crédits consommés aujourd'hui`,
    ].join("\n");
  }
}

export function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
