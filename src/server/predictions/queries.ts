/**
 * ============================================================================
 * SOLEIL — Requêtes de lecture pour l'interface
 * ============================================================================
 * Toutes les fonctions renvoient des objets prêts à afficher. Elles ne
 * fabriquent jamais de valeur : un champ absent reste `null` et l'interface
 * affiche « Donnée indisponible » (§34).
 */

import { prisma } from "@/lib/prisma";
import { CONFIDENCE_THRESHOLDS, MAX_DAILY_PICKS } from "@/lib/constants";

export const MATCH_INCLUDE = {
  league: {
    select: {
      id: true,
      name: true,
      country: true,
      countryCode: true,
      shortName: true,
      logo: true,
      flag: true,
    },
  },
  homeTeam: { select: { id: true, name: true, shortName: true, tla: true, crest: true } },
  awayTeam: { select: { id: true, name: true, shortName: true, tla: true, crest: true } },
} as const;

/** Contenu d'une prédiction mise en avant (Top Picks). */
const PICK_INCLUDE = {
  match: { include: MATCH_INCLUDE },
  totalGoals: true,
  btts: true,
  matchResult: true,
  exactScore: true,
} as const;

/**
 * §9 (Phase 15) — Contenu minimal pour valider une prédiction AVANT affichage.
 * Les marchés complets et la vue détaillée ne sont pas chargés ici : la
 * validation les lit directement dans la vue persistée (`matchResult.factors`),
 * sans requête supplémentaire.
 */
export const PREDICTION_SUMMARY = {
  id: true,
  confidenceScore: true,
  dataQuality: true,
  modelAgreement: true,
  status: true,
  generatedAt: true,
  isCorrect: true,
  actualResult: true,
  matchResult: {
    select: {
      homeWinProb: true,
      drawProb: true,
      awayWinProb: true,
      consensusPick: true,
    },
  },
  totalGoals: { select: { expectedGoals: true, ou25Over: true, ou25Under: true, ou25Confidence: true } },
  btts: { select: { yesProb: true, confidence: true } },
  // Les scores les plus probables figurent sur la carte (§4) : ce sont des
  // valeurs déjà calculées et persistées, jamais recalculées à l'affichage.
  exactScore: { select: { mostLikelyScore: true, mostLikelyProb: true, topScores: true } },
} as const;

export type MatchListItem = Awaited<ReturnType<typeof listMatches>>[number];

export interface ListMatchesFilter {
  from?: Date;
  to?: Date;
  leagueId?: string;
  leagueCode?: string;
  status?: "SCHEDULED" | "FINISHED" | "LIVE";
  onlyWithPredictions?: boolean;
  minConfidence?: number;
  market?: "result" | "over25" | "under25" | "btts" | "all";
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

/**
 * Liste paginée de rencontres avec leur dernière prédiction publiée.
 * Une seule requête SQL par page : pas de N+1.
 */
export async function listMatches(filter: ListMatchesFilter = {}) {
  const {
    from,
    to,
    leagueId,
    leagueCode,
    status,
    onlyWithPredictions,
    minConfidence,
    limit = 20,
    offset = 0,
    order = "asc",
  } = filter;

  return prisma.match.findMany({
    where: {
      ...(from || to ? { utcDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(leagueId ? { leagueId } : {}),
      ...(leagueCode ? { league: { shortName: leagueCode } } : {}),
      ...(status ? { status } : {}),
      ...(onlyWithPredictions
        ? {
            predictions: {
              some: {
                status: { in: ["PUBLISHED", "SETTLED"] },
                ...(minConfidence ? { confidenceScore: { gte: minConfidence } } : {}),
              },
            },
          }
        : {}),
    },
    include: {
      ...MATCH_INCLUDE,
      predictions: {
        where: { status: { in: ["PUBLISHED", "SETTLED", "GENERATED"] } },
        orderBy: { generatedAt: "desc" },
        take: 1,
        select: PREDICTION_SUMMARY,
      },
    },
    orderBy: { utcDate: order },
    take: limit,
    skip: offset,
  });
}

export async function countMatches(filter: ListMatchesFilter = {}) {
  return prisma.match.count({
    where: {
      ...(filter.from || filter.to
        ? { utcDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      ...(filter.leagueId ? { leagueId: filter.leagueId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
  });
}

/** Rencontres du jour (ou de la fenêtre demandée) triées par confiance. */
export async function listTodayMatches(day = new Date()) {
  const start = new Date(day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * 86_400_000);

  const matches = await listMatches({
    from: start,
    to: end,
    onlyWithPredictions: true,
    limit: 60,
  });

  // §18 : ne pas afficher une quantité excessive de matchs ; prioriser ceux
  // qui disposent de bonnes données et de prédictions stables.
  return matches
    .filter((m) => m.predictions[0])
    .sort((a, b) => (b.predictions[0]?.confidenceScore ?? 0) - (a.predictions[0]?.confidenceScore ?? 0))
    .slice(0, MAX_DAILY_PICKS);
}

/** Charge une fiche de match complète (Match Center §17). */
export async function getMatchCenter(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      ...MATCH_INCLUDE,
      season: { select: { year: true } },
      liveData: true,
      predictions: {
        orderBy: { generatedAt: "desc" },
        take: 1,
        include: {
          matchResult: true,
          totalGoals: true,
          exactScore: true,
          btts: true,
          halfTime: true,
          teamGoals: true,
          modelOutputs: true,
        },
      },
    },
  });

  if (!match) return null;

  const prediction = match.predictions[0] ?? null;

  // Historique des confrontations directes (5 dernières).
  const h2h = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { lt: match.utcDate },
      OR: [
        { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
        { homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId },
      ],
    },
    include: MATCH_INCLUDE,
    orderBy: { utcDate: "desc" },
    take: 6,
  });

  // Forme récente des deux équipes (5 derniers matchs terminés avant celui-ci).
  const [homeForm, awayForm] = await Promise.all([
    prisma.match.findMany({
      where: {
        status: "FINISHED",
        utcDate: { lt: match.utcDate },
        OR: [{ homeTeamId: match.homeTeamId }, { awayTeamId: match.homeTeamId }],
      },
      include: MATCH_INCLUDE,
      orderBy: { utcDate: "desc" },
      take: 6,
    }),
    prisma.match.findMany({
      where: {
        status: "FINISHED",
        utcDate: { lt: match.utcDate },
        OR: [{ homeTeamId: match.awayTeamId }, { awayTeamId: match.awayTeamId }],
      },
      include: MATCH_INCLUDE,
      orderBy: { utcDate: "desc" },
      take: 6,
    }),
  ]);

  // §10 — Couverture réelle des scores de mi-temps pour ces deux équipes.
  // On compte, sans rien reconstruire : combien de leurs derniers matchs
  // terminés portent un score à la mi-temps ? Si cette couverture est trop
  // faible, la fiche match retire les marchés 1re/2e mi-temps au lieu de
  // présenter une estimation fragile.
  const recentForCoverage = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { lt: match.utcDate },
      homeScore: { not: null },
      awayScore: { not: null },
      OR: [
        { homeTeamId: match.homeTeamId },
        { awayTeamId: match.homeTeamId },
        { homeTeamId: match.awayTeamId },
        { awayTeamId: match.awayTeamId },
      ],
    },
    orderBy: { utcDate: "desc" },
    take: 40,
    select: { halfTimeHomeScore: true, halfTimeAwayScore: true },
  });

  const halfTimeWithScore = recentForCoverage.filter(
    (m) => m.halfTimeHomeScore !== null && m.halfTimeAwayScore !== null,
  ).length;
  const halfTimeCoverage = {
    sample: recentForCoverage.length,
    withScore: halfTimeWithScore,
    ratio: recentForCoverage.length > 0 ? halfTimeWithScore / recentForCoverage.length : 0,
  };

  return { match, prediction, h2h, homeForm, awayForm, halfTimeCoverage };
}

export type MatchCenterData = NonNullable<Awaited<ReturnType<typeof getMatchCenter>>>;

/** SOLEIL TOP PICKS — prédictions aux meilleures caractéristiques (§20). */
export async function listTopPicks(limit = 10) {
  const now = new Date();
  return prisma.prediction.findMany({
    where: {
      status: "PUBLISHED",
      confidenceScore: { gte: CONFIDENCE_THRESHOLDS.HIGH },
      dataQuality: { in: ["EXCELLENT", "GOOD"] },
      modelAgreement: { gte: 0.5 },
      match: { status: "SCHEDULED", utcDate: { gt: now } },
    },
    include: PICK_INCLUDE,
    orderBy: [{ confidenceScore: "desc" }, { modelAgreement: "desc" }],
    take: limit,
  });
}

/**
 * Repli historique : si aucun match à venir n'est disponible (calendrier non
 * encore publié par les sources), on affiche les meilleures prédictions déjà
 * réglées, clairement étiquetées comme telles. Aucune donnée n'est inventée :
 * on change ce que l'on montre, pas la nature de la donnée.
 */
export async function listTopPicksAny(limit = 10) {
  const upcoming = await listTopPicks(limit);
  if (upcoming.length > 0) return { picks: upcoming, mode: "upcoming" as const };

  const settled = await prisma.prediction.findMany({
    where: {
      status: "SETTLED",
      confidenceScore: { gte: CONFIDENCE_THRESHOLDS.HIGH },
      dataQuality: { in: ["EXCELLENT", "GOOD"] },
    },
    include: PICK_INCLUDE,
    orderBy: [{ confidenceScore: "desc" }],
    take: limit,
  });
  return { picks: settled, mode: "settled" as const };
}

/** Statistiques d'en-tête de la page d'accueil. */
export async function getPlatformStats() {
  const now = new Date();
  const [leagues, teams, matches, finished, upcoming, predictions, published, settled, correct] =
    await Promise.all([
      prisma.league.count({ where: { isActive: true } }),
      prisma.team.count(),
      prisma.match.count(),
      prisma.match.count({ where: { status: "FINISHED" } }),
      prisma.match.count({ where: { status: "SCHEDULED", utcDate: { gt: now } } }),
      prisma.prediction.count(),
      prisma.prediction.count({ where: { status: { in: ["PUBLISHED", "SETTLED"] } } }),
      prisma.prediction.count({ where: { status: "SETTLED" } }),
      prisma.prediction.count({ where: { status: "SETTLED", isCorrect: true } }),
    ]);

  return {
    leagues,
    teams,
    matches,
    finished,
    upcoming,
    predictions,
    published,
    settled,
    correct,
    accuracy: settled > 0 ? correct / settled : null,
  };
}

/** Compétitions disponibles pour les filtres (§19). */
export async function listLeagues() {
  const leagues = await prisma.league.findMany({
    where: { isActive: true },
    include: { _count: { select: { matches: true } } },
    orderBy: { name: "asc" },
  });
  return leagues
    .filter((l) => l._count.matches > 0)
    .map((l) => ({
      id: l.id,
      name: l.name,
      shortName: l.shortName,
      country: l.country,
      countryCode: l.countryCode,
      matchCount: l._count.matches,
    }));
}

/** État du système pour le dashboard administrateur (§28). */
export async function getAdminOverview() {
  const [sources, lastLogs, predictionStats, modelRows, cacheRows] = await Promise.all([
    prisma.dataSource.findMany({ orderBy: { priority: "asc" } }),
    prisma.dataSyncLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 25,
      include: { dataSource: { select: { displayName: true } } },
    }),
    prisma.prediction.groupBy({
      by: ["status"],
      _count: { _all: true },
      _avg: { confidenceScore: true },
    }),
    prisma.modelOutput.groupBy({
      by: ["modelName"],
      _count: { _all: true },
      _avg: { weight: true, confidence: true },
    }),
    prisma.systemConfig.count({ where: { key: { startsWith: "cache:" } } }),
  ]);

  const anomalies = await prisma.prediction.findMany({
    where: {
      OR: [
        { dataQuality: { in: ["LOW", "INSUFFICIENT"] } },
        { confidenceScore: { lt: CONFIDENCE_THRESHOLDS.MIN_PUBLISHABLE } },
      ],
    },
    include: {
      match: { include: { homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } },
    },
    orderBy: { generatedAt: "desc" },
    take: 15,
  });

  const recentErrors = await prisma.dataSyncLog.findMany({
    where: { status: { in: ["FAILED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    take: 10,
    include: { dataSource: { select: { displayName: true } } },
  });

  return { sources, lastLogs, predictionStats, modelRows, cacheRows, anomalies, recentErrors };
}
