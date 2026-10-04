/**
 * ============================================================================
 * SOLEIL — §13 à §16 (Phase 15) · Résolution des visuels (serveur)
 * ============================================================================
 * Ordre de priorité, appliqué strictement :
 *
 *   1. logo officiel fourni par la source principale (LiveFootballApi, dont
 *      l'URL est stockée telle quelle dans la base) ;
 *   2. logo mis en cache localement (table `AssetCache`), avec sa provenance ;
 *   3. source secondaire autorisée (football-data.org, TheSportsDB) ;
 *   4. repli visuel — monogramme ou drapeau.
 *
 * Ce que ce module ne fait JAMAIS :
 *  • inventer une URL de logo ;
 *  • fabriquer un faux logo officiel ;
 *  • déduire un pays à partir du nom d'une équipe ;
 *  • afficher une URL cassée : toute URL passe par une validation, et
 *    l'affichage bascule sur le repli dès qu'une image échoue.
 *
 * Les règles pures (validation d'URL, monogramme, drapeau) sont définies dans
 * `src/lib/logos.ts` : elles sont ainsi utilisables côté client sans embarquer
 * de code serveur.
 */

import { prisma } from "@/lib/prisma";

export * from "@/lib/logos";
import {
  flagFor,
  isUsableImageUrl,
  resolveLeagueLogo,
  resolveTeamLogo,
  type AssetEntityType,
} from "@/lib/logos";

export interface CachedAsset {
  entityType: AssetEntityType;
  entityId: string;
  entityName: string;
  logoUrl: string;
  source: string;
}

/** Enregistre (ou met à jour) un visuel en cache. Aucune image n'est inventée. */
export async function rememberAsset(asset: CachedAsset, reachable?: boolean) {
  if (!isUsableImageUrl(asset.logoUrl)) {
    throw new Error(`URL de visuel refusée pour ${asset.entityType}:${asset.entityId}`);
  }
  return prisma.assetCache.upsert({
    where: {
      entityType_entityId_source: {
        entityType: asset.entityType,
        entityId: asset.entityId,
        source: asset.source,
      },
    },
    create: {
      entityType: asset.entityType,
      entityId: asset.entityId,
      entityName: asset.entityName,
      logoUrl: asset.logoUrl,
      source: asset.source,
      lastVerified: new Date(),
      reachable: reachable ?? null,
    },
    update: {
      logoUrl: asset.logoUrl,
      entityName: asset.entityName,
      lastVerified: new Date(),
      reachable: reachable ?? null,
    },
  });
}

/** Visuels en cache pour un lot d'entités — une seule requête. */
export async function cachedAssets(
  entityType: AssetEntityType,
  entityIds: string[],
): Promise<Map<string, CachedAsset>> {
  if (entityIds.length === 0) return new Map();
  const rows = await prisma.assetCache.findMany({
    where: { entityType, entityId: { in: entityIds }, reachable: { not: false } },
    orderBy: { lastVerified: "desc" },
  });
  const map = new Map<string, CachedAsset>();
  for (const row of rows) {
    if (!map.has(row.entityId) && isUsableImageUrl(row.logoUrl)) {
      map.set(row.entityId, {
        // `entityType` est celui demandé dans la requête : la valeur stockée
        // ne peut pas élargir le type sans contrôle.
        entityType,
        entityId: row.entityId,
        entityName: row.entityName,
        logoUrl: row.logoUrl,
        source: row.source,
      });
    }
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Résolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface AssetCoverage {
  teams: { total: number; withSourceLogo: number; withCachedLogo: number; fallback: number };
  leagues: { total: number; withSourceLogo: number; withCachedLogo: number; fallback: number };
  countries: { total: number; withCode: number; withoutCode: number };
}

export async function assetCoverage(): Promise<AssetCoverage> {
  const [teams, leagues] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true, tla: true, crest: true } }),
    prisma.league.findMany({ select: { id: true, name: true, countryCode: true, logo: true } }),
  ]);
  const cachedTeams = await cachedAssets("team", teams.map((t) => t.id));
  const cachedLeagues = await cachedAssets("league", leagues.map((l) => l.id));

  const countTeams = teams.reduce(
    (acc, t) => {
      const resolved = resolveTeamLogo(t, cachedTeams.get(t.id));
      if (resolved.origin === "source") acc.withSourceLogo += 1;
      else if (resolved.origin === "cache") acc.withCachedLogo += 1;
      else acc.fallback += 1;
      return acc;
    },
    { total: teams.length, withSourceLogo: 0, withCachedLogo: 0, fallback: 0 },
  );

  const countLeagues = leagues.reduce(
    (acc, l) => {
      const resolved = resolveLeagueLogo(l, cachedLeagues.get(l.id));
      if (resolved.origin === "source") acc.withSourceLogo += 1;
      else if (resolved.origin === "cache") acc.withCachedLogo += 1;
      else acc.fallback += 1;
      return acc;
    },
    { total: leagues.length, withSourceLogo: 0, withCachedLogo: 0, fallback: 0 },
  );

  const countries = leagues.reduce(
    (acc, l) => {
      if (flagFor(l.countryCode)) acc.withCode += 1;
      else acc.withoutCode += 1;
      return acc;
    },
    { total: leagues.length, withCode: 0, withoutCode: 0 },
  );

  return { teams: countTeams, leagues: countLeagues, countries };
}
