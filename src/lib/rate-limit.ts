/**
 * Limitation de débit en mémoire (§30).
 *
 * Suffisant pour une instance unique. En déploiement multi-instances, remplacer
 * le `Map` par Redis (`REDIS_URL` est déjà prévu dans la configuration) sans
 * changer les appels : l'interface `rateLimit` reste identique.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export function rateLimit(
  request: Request,
  options: RateLimitOptions,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  sweep(now);

  // Identification par en-têtes de proxy puis repli sur l'URL.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonyme";

  const bucketKey = `${options.key}:${ip}`;
  const bucket = buckets.get(bucketKey);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
    return { ok: true };
  }

  bucket.count += 1;
  if (bucket.count > options.limit) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true };
}
