/**
 * ============================================================================
 * SOLEIL — Cache serveur
 * ============================================================================
 * §29 « Économie des API » : aucune requête identique ne doit être effectuée
 * deux fois inutilement. Le cache est persistant en base (survit aux
 * redémarrages) et horodaté pour le contrôle de fraîcheur (§4).
 */

import { prisma } from "@/lib/prisma";

export interface CacheEntry<T> {
  value: T;
  storedAt: Date;
  expiresAt: Date;
  fresh: boolean;
}

/** Lit une entrée du cache. Retourne `null` si absente ou expirée. */
/**
 * Réhydrate les chaînes ISO en `Date`.
 * Le cache étant persisté en JSON, les objets `Date` en ressortent sous forme
 * de chaînes : sans cette étape, `fixture.utcDate.getTime()` échouerait.
 * La conversion est volontairement limitée aux clés connues comme temporelles
 * afin de ne jamais transformer une chaîne métier en objet Date par accident.
 */
const TEMPORAL_KEYS = new Set(["utcDate", "fetchedAt", "date"]);

function reviveDates(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && TEMPORAL_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => reviveDates(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = reviveDates(v, k);
    }
    return out;
  }
  return value;
}

export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key: `cache:${key}` } });
  if (!row) return null;

  const payload = row.value as { value: unknown; storedAt: string; expiresAt: string } | null;
  if (!payload) return null;

  const expiresAt = new Date(payload.expiresAt);
  const fresh = expiresAt.getTime() > Date.now();

  return {
    value: reviveDates(payload.value) as T,
    storedAt: new Date(payload.storedAt),
    expiresAt,
    fresh,
  };
}

/** Écrit une entrée dans le cache avec une durée de vie en secondes. */
export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await prisma.systemConfig.upsert({
    where: { key: `cache:${key}` },
    create: {
      key: `cache:${key}`,
      value: { value: value as never, storedAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
      description: `Cache · expire le ${expiresAt.toISOString()}`,
    },
    update: {
      value: { value: value as never, storedAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
      description: `Cache · expire le ${expiresAt.toISOString()}`,
    },
  });
}

export async function cacheDelete(key: string): Promise<void> {
  await prisma.systemConfig.deleteMany({ where: { key: `cache:${key}` } });
}

/** Purge toutes les entrées expirées (appelée par la tâche de maintenance). */
export async function cachePurgeExpired(): Promise<number> {
  const rows = await prisma.systemConfig.findMany({ where: { key: { startsWith: "cache:" } } });
  const expired = rows.filter((r) => {
    const p = r.value as { expiresAt?: string } | null;
    return p?.expiresAt ? new Date(p.expiresAt).getTime() <= Date.now() : true;
  });
  if (expired.length === 0) return 0;
  await prisma.systemConfig.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } });
  return expired.length;
}

/**
 * « Single-flight » : si deux appels demandent la même clé simultanément,
 * une seule requête réseau est émise.
 */
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  options: { allowStaleOnError?: boolean; ttlIfStale?: number } = {},
): Promise<{ value: T; fromCache: boolean; stale: boolean }> {
  const { allowStaleOnError = true, ttlIfStale = 86_400 } = options;

  const hit = await cacheGet<T>(key);
  if (hit?.fresh) return { value: hit.value, fromCache: true, stale: false };

  const existing = inflight.get(key);
  if (existing) return (await existing) as { value: T; fromCache: boolean; stale: boolean };

  const task = (async () => {
    try {
      const value = await loader();
      await cacheSet(key, value, ttlSeconds);
      return { value, fromCache: false, stale: false };
    } catch (error) {
      // En cas d'échec réseau, on réutilise une valeur périmée plutôt que de
      // priver l'utilisateur de toute donnée — en le signalant (`stale: true`).
      if (allowStaleOnError && hit) {
        await cacheSet(key, hit.value, ttlIfStale);
        return { value: hit.value, fromCache: true, stale: true };
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return (await task) as { value: T; fromCache: boolean; stale: boolean };
}
