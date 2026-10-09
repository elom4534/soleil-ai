/**
 * ============================================================================
 * SOLEIL — Ingestion : normalisation, déduplication, validation, persistance
 * ============================================================================
 * Implémente §4 :
 *   data aggregation → normalisation → déduplication → validation → cache
 *
 * Règle absolue (§34) : une donnée absente reste absente. Lors de la fusion
 * de deux sources, on complète les champs manquants mais on n'écrase jamais
 * une valeur existante par une supposition.
 */

import { prisma } from "@/lib/prisma";
import { HISTORICAL_LEAGUES } from "@/lib/constants";
import { canonicalTeamKey, resolveTeamId, teamSlug } from "./teams";
import type { NormalizedFixture } from "./providers/types";

export interface IngestStats {
  provider: string;
  competition: string;
  season: string;
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
  teamsCreated: number;
  duplicatesMerged: number;
  errors: string[];
}

/** Charge (ou crée) la compétition correspondant au code source. */
async function ensureLeague(code: string, fallbackName: string, country: string) {
  const known = HISTORICAL_LEAGUES.find((l) => l.code === code);
  const name = known?.name ?? fallbackName ?? code;
  const resolvedCountry = known?.country ?? country ?? "International";

  return prisma.league.upsert({
    where: { externalId: `code:${code}` },
    create: {
      externalId: `code:${code}`,
      name,
      shortName: code,
      country: resolvedCountry,
      countryCode: known?.countryCode ?? null,
      type: "LEAGUE",
    },
    update: { name, country: resolvedCountry },
  });
}

/** Charge (ou crée) la saison. `year` est une chaîne libre, ex. « 2026/2027 ». */
async function ensureSeason(leagueId: string, year: string, isCurrent: boolean) {
  return prisma.season.upsert({
    where: { leagueId_year: { leagueId, year } },
    create: { leagueId, year, isCurrent },
    update: { isCurrent },
  });
}

/**
 * Charge (ou crée) une équipe. Le rapprochement inter-sources s'appuie sur
 * `resolveTeamId` ; en l'absence de correspondance suffisamment sûre, une
 * nouvelle équipe est créée plutôt que de risquer une fusion erronée.
 */
async function ensureTeam(name: string, leagueId: string, cache: Map<string, string>) {
  const slug = teamSlug(name);
  const cached = cache.get(slug);
  if (cached) return { id: cached, created: false };

  const leagueTeams = await prisma.team.findMany({
    where: { leagueId },
    select: { id: true, name: true, shortName: true, tla: true },
  });

  const matched = resolveTeamId(name, leagueTeams);
  if (matched) {
    cache.set(slug, matched);
    return { id: matched, created: false };
  }

  // Rapprochement inter-compétitions (coupes européennes, transferts).
  const allTeams = await prisma.team.findMany({
    select: { id: true, name: true, shortName: true, tla: true },
    take: 5000,
  });
  const globalMatch = resolveTeamId(name, allTeams, 0.85);
  if (globalMatch) {
    cache.set(slug, globalMatch);
    return { id: globalMatch, created: false };
  }

  const created = await prisma.team.upsert({
    where: { externalId: `slug:${slug}` },
    create: {
      externalId: `slug:${slug}`,
      name,
      shortName: name.length > 22 ? name.slice(0, 22) : name,
      leagueId,
      country: HISTORICAL_LEAGUES.find((l) => l.code === leagueId)?.country ?? null,
    },
    update: {},
  });
  cache.set(slug, created.id);
  return { id: created.id, created: true };
}

/**
 * Calcule un score de qualité (0-1) pour un match selon les champs réellement
 * renseignés. Utilisé par le moteur (§4 : chaque donnée porte son score).
 */
function matchCompleteness(f: NormalizedFixture): { score: number; fields: string[] } {
  const checks: [string, boolean, number][] = [
    ["score final", f.homeScore !== null && f.awayScore !== null, 0.3],
    ["score mi-temps", f.halfTimeHomeScore !== null, 0.15],
    ["tirs", f.homeShots !== null, 0.15],
    ["tirs cadrés", f.homeShotsOnTarget !== null, 0.15],
    ["corners", f.homeCorners !== null, 0.1],
    ["cartons", f.homeYellowCards !== null, 0.1],
    ["xG", f.homeXg !== null, 0.05],
  ];
  const fields = checks.filter(([, ok]) => ok).map(([n]) => n);
  const score = checks.reduce((acc, [, ok, w]) => acc + (ok ? w : 0), 0);
  return { score, fields };
}

function gradeOf(score: number) {
  if (score >= 0.85) return "EXCELLENT" as const;
  if (score >= 0.65) return "GOOD" as const;
  if (score >= 0.45) return "MEDIUM" as const;
  if (score >= 0.25) return "LOW" as const;
  return "INSUFFICIENT" as const;
}

/**
 * Ingère un lot de rencontres pour une compétition et une saison.
 *
 * Déduplication : une rencontre est identifiée par (compétition, date à ±1 jour,
 * paire d'équipes résolue). Si elle existe déjà, les champs `null` sont
 * complétés par la nouvelle source — sans jamais écraser une valeur connue.
 */
export async function ingestFixtures(input: {
  provider: string;
  competitionCode: string;
  season: string;
  fixtures: NormalizedFixture[];
}): Promise<IngestStats> {
  const { provider, competitionCode, season, fixtures } = input;

  const stats: IngestStats = {
    provider,
    competition: competitionCode,
    season,
    received: fixtures.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    teamsCreated: 0,
    duplicatesMerged: 0,
    errors: [],
  };

  const league = await ensureLeague(competitionCode, competitionCode, "");
  const isCurrent = season === currentSeasonLabel();
  const seasonRow = await ensureSeason(league.id, season, isCurrent);

  const teamCache = new Map<string, string>();

  // ---------------------------------------------------------------------
  // Performance : on charge une seule fois en mémoire l'index des rencontres
  // déjà connues pour cette compétition. Sans ce préchargement, l'ingestion
  // d'une saison complète génère plusieurs milliers de requêtes SQL.
  // ---------------------------------------------------------------------
  const knownMatches = await prisma.match.findMany({
    where: { leagueId: league.id },
    select: {
      id: true,
      homeTeamId: true,
      awayTeamId: true,
      utcDate: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });

  const matchIndex = new Map<string, string[]>();
  /**
   * GARDE-FOU inter-fournisseurs : même index, mais bâti sur les **noms
   * canoniques** au lieu des identifiants d'équipes. Deux fournisseurs qui
   * résolvent le même club sur deux lignes différentes produisent malgré tout
   * la même clé — c'est ce qui manquait pour empêcher les doublons.
   */
  const matchIndexCanonique = new Map<string, string[]>();
  const dayKey = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  const cleCanonique = (dom: string, ext: string, k: number) =>
    `${canonicalTeamKey(dom)}|${canonicalTeamKey(ext)}|${k}`;
  for (const m of knownMatches) {
    for (const k of [dayKey(m.utcDate) - 1, dayKey(m.utcDate), dayKey(m.utcDate) + 1]) {
      const key = `${m.homeTeamId}|${m.awayTeamId}|${k}`;
      const list = matchIndex.get(key) ?? [];
      list.push(m.id);
      matchIndex.set(key, list);
      const keyC = cleCanonique(m.homeTeam.name, m.awayTeam.name, k);
      const listC = matchIndexCanonique.get(keyC) ?? [];
      listC.push(m.id);
      matchIndexCanonique.set(keyC, listC);
    }
  }

  for (const fixture of fixtures) {
    try {
      // --- Validation minimale : on rejette plutôt que d'insérer du bruit ---
      if (!fixture.homeTeamName || !fixture.awayTeamName) {
        stats.skipped += 1;
        continue;
      }
      if (Number.isNaN(fixture.utcDate.getTime())) {
        stats.skipped += 1;
        continue;
      }
      if (fixture.status === "cancelled") {
        stats.skipped += 1;
        continue;
      }

      const home = await ensureTeam(fixture.homeTeamName, league.id, teamCache);
      const away = await ensureTeam(fixture.awayTeamName, league.id, teamCache);
      if (home.created) stats.teamsCreated += 1;
      if (away.created) stats.teamsCreated += 1;

      if (home.id === away.id) {
        stats.skipped += 1;
        stats.errors.push(`Équipes identiques après rapprochement : ${fixture.homeTeamName}`);
        continue;
      }

      // --- Déduplication : fenêtre de ±1 jour autour de la date ---
      const indexKey = `${home.id}|${away.id}|${dayKey(fixture.utcDate)}`;
      const existingId =
        matchIndex.get(indexKey)?.[0] ??
        matchIndexCanonique.get(
          cleCanonique(fixture.homeTeamName, fixture.awayTeamName, dayKey(fixture.utcDate)),
        )?.[0];
      const existing = existingId
        ? await prisma.match.findUnique({ where: { id: existingId } })
        : null;

      const { score } = matchCompleteness(fixture);

      if (existing) {
        // Complète les trous sans écraser (§34).
        const patch: Record<string, unknown> = {};
        const maybeFill = (key: string, value: unknown, current: unknown) => {
          if (value !== null && value !== undefined && (current === null || current === undefined)) {
            patch[key] = value;
          }
        };

        maybeFill("homeScore", fixture.homeScore, existing.homeScore);
        maybeFill("awayScore", fixture.awayScore, existing.awayScore);
        maybeFill("halfTimeHomeScore", fixture.halfTimeHomeScore, existing.halfTimeHomeScore);
        maybeFill("halfTimeAwayScore", fixture.halfTimeAwayScore, existing.halfTimeAwayScore);
        maybeFill("referee", fixture.referee, existing.referee);
        maybeFill("venue", fixture.venue, existing.venue);

        if (fixture.status === "finished" && existing.status !== "FINISHED") {
          patch.status = "FINISHED";
          patch.winner = deriveWinner(fixture.homeScore, fixture.awayScore);
        }

        const sources = new Set([...existing.dataSources, provider]);
        patch.dataSources = [...sources];
        patch.lastDataUpdate = new Date();

        if (score > qualityToScore(existing.dataQuality)) {
          patch.dataQuality = gradeOf(score);
        }

        if (Object.keys(patch).length > 2) {
          await prisma.match.update({ where: { id: existing.id }, data: patch });
          stats.updated += 1;
          stats.duplicatesMerged += 1;
        } else {
          stats.skipped += 1;
        }
        continue;
      }

      const createdMatch = await prisma.match.create({
        data: {
          externalId: fixture.externalId,
          seasonId: seasonRow.id,
          leagueId: league.id,
          homeTeamId: home.id,
          awayTeamId: away.id,
          utcDate: fixture.utcDate,
          status: mapStatus(fixture.status),
          homeScore: fixture.homeScore,
          awayScore: fixture.awayScore,
          halfTimeHomeScore: fixture.halfTimeHomeScore,
          halfTimeAwayScore: fixture.halfTimeAwayScore,
          winner: deriveWinner(fixture.homeScore, fixture.awayScore),
          referee: fixture.referee,
          venue: fixture.venue,
          dataQuality: gradeOf(score),
          dataSources: [provider],
          lastDataUpdate: new Date(),
        },
      });

      // On indexe immédiatement la nouvelle rencontre pour éviter un doublon
      // si deux fournisseurs la rapportent dans le même lot.
      {
        const k = dayKey(fixture.utcDate);
        for (const offset of [-1, 0, 1]) {
          const key = `${home.id}|${away.id}|${k + offset}`;
          const list = matchIndex.get(key) ?? [];
          list.push(createdMatch.id);
          matchIndex.set(key, list);
          const keyC = cleCanonique(fixture.homeTeamName, fixture.awayTeamName, k + offset);
          const listC = matchIndexCanonique.get(keyC) ?? [];
          listC.push(createdMatch.id);
          matchIndexCanonique.set(keyC, listC);
        }
      }

      // Statistiques avancées : enregistrées uniquement si réellement fournies.
      if (
        fixture.homeShots !== null ||
        fixture.homeCorners !== null ||
        fixture.homeXg !== null ||
        fixture.homeRedCards !== null ||
        fixture.awayRedCards !== null
      ) {
        // Les stats détaillées ne sont conservées que pour les matchs terminés ;
        // pour un match à venir, elles n'ont pas de sens.
        if (fixture.status === "finished") {
          await prisma.match.update({
            where: { id: createdMatch.id },
            data: {
              liveData: {
                create: {
                  homeShots: fixture.homeShots,
                  awayShots: fixture.awayShots,
                  homeShotsOnTarget: fixture.homeShotsOnTarget,
                  awayShotsOnTarget: fixture.awayShotsOnTarget,
                  homeCorners: fixture.homeCorners,
                  awayCorners: fixture.awayCorners,
                  homeYellowCards: fixture.homeYellowCards,
                  awayYellowCards: fixture.awayYellowCards,
                  homeRedCards: fixture.homeRedCards,
                  awayRedCards: fixture.awayRedCards,
                  homeXg: fixture.homeXg,
                  awayXg: fixture.awayXg,
                },
              },
            },
          });
        }
      }

      stats.inserted += 1;
    } catch (error) {
      stats.errors.push(
        `${fixture.homeTeamName} vs ${fixture.awayTeamName} : ${(error as Error).message}`,
      );
      stats.skipped += 1;
    }
  }

  return stats;
}

function qualityToScore(q: string): number {
  return { EXCELLENT: 0.9, GOOD: 0.7, MEDIUM: 0.5, LOW: 0.3, INSUFFICIENT: 0.1 }[q] ?? 0;
}

function deriveWinner(home: number | null, away: number | null) {
  if (home === null || away === null) return null;
  if (home > away) return "HOME_TEAM" as const;
  if (home < away) return "AWAY_TEAM" as const;
  return "DRAW" as const;
}

function mapStatus(status: NormalizedFixture["status"]) {
  switch (status) {
    case "finished":
      return "FINISHED" as const;
    case "postponed":
      return "POSTPONED" as const;
    case "cancelled":
      return "CANCELLED" as const;
    case "live":
      return "LIVE" as const;
    default:
      return "SCHEDULED" as const;
  }
}

/**
 * Étiquette de la saison en cours au format utilisé par les sources.
 * Septembre 2026 → « 2026/2027 ».
 */
export function currentSeasonLabel(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0 = janvier
  const start = m >= 5 ? y : y - 1; // une saison démarre en juin/juillet
  return `${start}/${start + 1}`;
}

export function previousSeasonLabel(now = new Date()): string {
  const current = currentSeasonLabel(now);
  const start = Number(current.split("/")[0]) - 1;
  return `${start}/${start + 1}`;
}

/** Marque la saison courante dans chaque compétition. */
export async function refreshSeasonFlags(): Promise<void> {
  const label = currentSeasonLabel();
  await prisma.season.updateMany({ data: { isCurrent: false } });
  await prisma.season.updateMany({ where: { year: label }, data: { isCurrent: true } });
  await prisma.league.updateMany({ data: { currentSeason: label } });
}
