/**
 * ============================================================================
 * SOLEIL — §13 à §16 (Phase 15) · Visuels : règles pures
 * ============================================================================
 * Ce module ne touche ni à la base ni au réseau : il peut donc être utilisé
 * par un composant client sans embarquer de code serveur (Prisma, pilote
 * PostgreSQL). Il contient les règles de validation d'une URL et les replis
 * visuels (monogramme, drapeau).
 *
 * La résolution complète — source, cache, provenance — vit dans
 * `src/server/assets/logos.ts`, côté serveur uniquement.
 */

export type AssetEntityType = "team" | "league" | "country" | "player";

export interface ResolvedAsset {
  /** URL à afficher, ou `null` si aucune source n'en fournit. */
  url: string | null;
  /** Provenance : « source », « cache », ou `null` si repli seul. */
  origin: "source" | "cache" | null;
  /** Nom de la source d'origine, pour l'affichage et l'audit. */
  source: string | null;
  /** Repli visuel à utiliser si l'URL est absente ou échoue. */
  fallback: { kind: "monogram" | "flag" | "generic"; label: string };
}

/**
 * Une URL d'image n'est retenue que si elle est exploitable.
 * Refuse : les schémas non HTTP, les chaînes vides, les espaces, les
 * caractères de contrôle, et les gabarits d'URL non résolus.
 */
export function isUsableImageUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return false;
  if (/\s/.test(trimmed)) return false;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Un gabarit non résolu est une URL cassée : on ne l'affiche pas.
  if (/[{}<>]|\$\{|%7B/i.test(trimmed)) return false;
  if (/(undefined|null|placeholder|example\.com)/i.test(trimmed)) return false;
  return true;
}

/** Monogramme stable : 3 lettres au maximum, tirées du nom ou du trigramme. */
export function monogram(name: string, tla?: string | null): string {
  const source = (tla && tla.trim().length >= 2 ? tla : name).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const letters = source.split(/\s+/).filter(Boolean);
  if (letters.length >= 2) return (letters[0]![0]! + letters[1]![0]!).toUpperCase();
  return source.slice(0, 3).toUpperCase();
}

/**
 * Drapeau à partir d'un code pays ISO 3166-1 alpha-2 fourni par la source.
 *
 * Le drapeau est une conversion déterministe du code officiel (indicateurs
 * régionaux Unicode) : ce n'est pas une donnée inventée, c'est la
 * représentation standard du code. Si le code est absent ou invalide, on ne
 * fabrique rien — aucun drapeau n'est affiché, pas de drapeau par défaut.
 */
export function flagFor(countryCode: string | null | undefined): string | null {
  if (typeof countryCode !== "string") return null;
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  // Les codes réservés/techniques ne désignent aucun pays.
  if (["XX", "ZZ", "EU", "UN"].includes(code)) return null;
  return [...code].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

/* -------------------------------------------------------------------------- */
/* Cache local                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Entrée de cache minimale. C'est le sous-ensemble dont la résolution a
 * besoin : l'URL et sa provenance. Le reste (identifiants, date de
 * vérification) appartient au module serveur.
 */
export interface CachedAssetRef {
  logoUrl: string;
  source: string;
}

export interface TeamLike {
  id: string;
  name: string;
  tla?: string | null;
  crest?: string | null;
}

export interface LeagueLike {
  id: string;
  name: string;
  countryCode?: string | null;
  logo?: string | null;
}

/** Logo d'une équipe : source → cache → repli. */
export function resolveTeamLogo(team: TeamLike, fromCache?: CachedAssetRef | null): ResolvedAsset {
  const fallback = { kind: "monogram" as const, label: monogram(team.name, team.tla) };
  if (isUsableImageUrl(team.crest)) {
    return { url: team.crest.trim(), origin: "source", source: "source de données", fallback };
  }
  if (fromCache && isUsableImageUrl(fromCache.logoUrl)) {
    return { url: fromCache.logoUrl, origin: "cache", source: fromCache.source, fallback };
  }
  return { url: null, origin: null, source: null, fallback };
}

/** Logo d'une compétition : source → cache → monogramme. */
export function resolveLeagueLogo(league: LeagueLike, fromCache?: CachedAssetRef | null): ResolvedAsset {
  const fallback = { kind: "monogram" as const, label: monogram(league.name) };
  if (isUsableImageUrl(league.logo)) {
    return { url: league.logo.trim(), origin: "source", source: "source de données", fallback };
  }
  if (fromCache && isUsableImageUrl(fromCache.logoUrl)) {
    return { url: fromCache.logoUrl, origin: "cache", source: fromCache.source, fallback };
  }
  return { url: null, origin: null, source: null, fallback };
}

/**
 * Drapeau d'un pays : uniquement à partir d'un code fourni par la source.
 * `null` si aucun code exploitable — jamais de drapeau déduit du nom.
 */
export function resolveCountryFlag(countryCode: string | null | undefined): string | null {
  return flagFor(countryCode);
}

/** Couverture des visuels, pour le rapport (§23). */
