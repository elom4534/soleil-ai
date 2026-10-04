/**
 * ============================================================================
 * SOLEIL — Construction du contexte de prédiction
 * ============================================================================
 * Transforme les données persistées en `MatchContext` exploitable par le
 * moteur.
 *
 * ⚠️ Point critique de rigueur : le contexte est construit **à une date
 * donnée** (`asOf`). Aucun match postérieur n'est utilisé. C'est ce qui
 * garantit qu'une prédiction historique reste honnête et qu'un backtest
 * mesure une performance réelle, sans fuite d'information future.
 */

import { prisma } from "@/lib/prisma";
import { computeLeagueBaseline } from "@/server/engine/ratings";
import type { LeagueBaseline, MatchContext, MatchRecord, TeamSnapshot } from "@/server/engine/types";

/** Nombre maximal de matchs récents chargés par équipe. */
const MAX_TEAM_MATCHES = 60;

interface RawMatch {
  id: string;
  utcDate: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  halfTimeHomeScore: number | null;
  halfTimeAwayScore: number | null;
  dataSources: string[];
  league: { name: string };
  liveData: {
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
  } | null;
}

const MATCH_SELECT = {
  id: true,
  utcDate: true,
  homeTeamId: true,
  awayTeamId: true,
  homeScore: true,
  awayScore: true,
  halfTimeHomeScore: true,
  halfTimeAwayScore: true,
  dataSources: true,
  league: { select: { name: true } },
  liveData: {
    select: {
      homeXg: true,
      awayXg: true,
      homeShots: true,
      awayShots: true,
      homeShotsOnTarget: true,
      awayShotsOnTarget: true,
      homeCorners: true,
      awayCorners: true,
      homeYellowCards: true,
      awayYellowCards: true,
    },
  },
} as const;

function toMatchRecord(m: RawMatch): MatchRecord {
  return {
    id: m.id,
    date: m.utcDate,
    competition: m.league?.name ?? "Compétition inconnue",
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    homeGoals: m.homeScore ?? 0,
    awayGoals: m.awayScore ?? 0,
    halfTimeHomeGoals: m.halfTimeHomeScore,
    halfTimeAwayGoals: m.halfTimeAwayScore,
    homeXg: m.liveData?.homeXg ?? null,
    awayXg: m.liveData?.awayXg ?? null,
    homeShots: m.liveData?.homeShots ?? null,
    awayShots: m.liveData?.awayShots ?? null,
    homeShotsOnTarget: m.liveData?.homeShotsOnTarget ?? null,
    awayShotsOnTarget: m.liveData?.awayShotsOnTarget ?? null,
    homeCorners: m.liveData?.homeCorners ?? null,
    awayCorners: m.liveData?.awayCorners ?? null,
    homeYellowCards: m.liveData?.homeYellowCards ?? null,
    awayYellowCards: m.liveData?.awayYellowCards ?? null,
    source: m.dataSources[0] ?? "inconnue",
  };
}

export interface BuildContextResult {
  context: MatchContext | null;
  /** Motif de l'échec, si le contexte n'a pas pu être construit. */
  reason?: string;
}

/**
 * Construit le contexte d'un match.
 *
 * @param matchId identifiant interne du match
 * @param asOf date de référence (par défaut : la date du match)
 */
export async function buildMatchContext(
  matchId: string,
  asOf?: Date,
): Promise<BuildContextResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      homeTeam: { include: { league: true } },
      awayTeam: { include: { league: true } },
      league: true,
      season: true,
    },
  });

  if (!match) return { context: null, reason: "Match introuvable" };
  if (!match.homeTeam || !match.awayTeam) {
    return { context: null, reason: "Équipes du match introuvables" };
  }

  const reference = asOf ?? match.utcDate;

  // -----------------------------------------------------------------------
  // Matchs antérieurs à la date de référence, exclusivement.
  // -----------------------------------------------------------------------
  const priorFilter = {
    status: "FINISHED" as const,
    utcDate: { lt: reference },
    homeScore: { not: null },
    awayScore: { not: null },
  };

  const [homeMatches, awayMatches, h2h, leagueMatches] = await Promise.all([
    prisma.match.findMany({
      where: {
        ...priorFilter,
        OR: [{ homeTeamId: match.homeTeamId }, { awayTeamId: match.homeTeamId }],
      },
      orderBy: { utcDate: "desc" },
      take: MAX_TEAM_MATCHES,
      select: MATCH_SELECT,
    }),
    prisma.match.findMany({
      where: {
        ...priorFilter,
        OR: [{ homeTeamId: match.awayTeamId }, { awayTeamId: match.awayTeamId }],
      },
      orderBy: { utcDate: "desc" },
      take: MAX_TEAM_MATCHES,
      select: MATCH_SELECT,
    }),
    prisma.match.findMany({
      where: {
        ...priorFilter,
        OR: [
          { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
          { homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId },
        ],
      },
      orderBy: { utcDate: "desc" },
      take: 12,
      select: MATCH_SELECT,
    }),
    // Référence de la compétition : saison en cours, matchs déjà joués.
    prisma.match.findMany({
      where: {
        leagueId: match.leagueId,
        seasonId: match.seasonId,
        ...priorFilter,
      },
      orderBy: { utcDate: "desc" },
      take: 600,
      select: MATCH_SELECT,
    }),
  ]);

  // La source de vérité pour les moyennes de compétition doit être suffisamment
  // large : si la saison en cours est trop jeune, on complète avec la saison
  // précédente (données réelles, jamais estimées).
  let leagueRecords = leagueMatches.map(toMatchRecord);
  if (leagueRecords.length < 40) {
    const previous = await prisma.match.findMany({
      where: { leagueId: match.leagueId, ...priorFilter },
      orderBy: { utcDate: "desc" },
      take: 600,
      select: MATCH_SELECT,
    });
    leagueRecords = previous.map(toMatchRecord);
  }

  const baseline: LeagueBaseline | null = computeLeagueBaseline(leagueRecords);
  if (!baseline) {
    return {
      context: null,
      reason: `Référence de compétition insuffisante : ${leagueRecords.length} match(s) exploitable(s) pour ${match.league.name}.`,
    };
  }

  const homeRecords = homeMatches.map(toMatchRecord);
  const awayRecords = awayMatches.map(toMatchRecord);
  const h2hRecords = h2h.map(toMatchRecord);

  const sourceScores: Record<string, number> = {};
  for (const m of [...homeRecords, ...awayRecords]) {
    sourceScores[m.source] = sourceScoreFor(m.source);
  }

  const homeSnapshot: TeamSnapshot = {
    identity: {
      id: match.homeTeamId,
      name: match.homeTeam.name,
      shortName: match.homeTeam.shortName,
      tla: match.homeTeam.tla,
      crest: match.homeTeam.crest,
      leagueId: match.leagueId,
      leagueName: match.league.name,
    },
    seasonMatches: homeRecords,
    headToHead: h2hRecords,
    hasXg: homeRecords.some((m) => m.homeXg !== null || m.awayXg !== null),
    sourceScores,
  };

  const awaySnapshot: TeamSnapshot = {
    identity: {
      id: match.awayTeamId,
      name: match.awayTeam.name,
      shortName: match.awayTeam.shortName,
      tla: match.awayTeam.tla,
      crest: match.awayTeam.crest,
      leagueId: match.leagueId,
      leagueName: match.league.name,
    },
    seasonMatches: awayRecords,
    headToHead: h2hRecords,
    hasXg: awayRecords.some((m) => m.homeXg !== null || m.awayXg !== null),
    sourceScores,
  };

  return {
    context: {
      matchId: match.id,
      date: match.utcDate,
      competition: match.league.name,
      leagueId: match.leagueId,
      home: homeSnapshot,
      away: awaySnapshot,
      leagueBaseline: baseline,
    },
  };
}

/** Score de qualité attribué a priori à une source (traçabilité §4). */
function sourceScoreFor(source: string): number {
  switch (source) {
    case "football-data-co-uk":
      return 0.9; // historiques complets + statistiques détaillées
    case "football-data-org":
      return 0.85;
    case "thesportsdb":
      return 0.6;
    default:
      return 0.5;
  }
}
