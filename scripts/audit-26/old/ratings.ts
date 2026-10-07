/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Ratings d'équipes
 * ============================================================================
 * Construit, à partir de matchs réels uniquement, les forces offensives et
 * défensives domicile/extérieur d'une équipe.
 *
 * Choix méthodologique : on utilise la méthode des ratios (attaque/défense
 * relatives à la moyenne de la compétition) plutôt qu'un ajustement MLE
 * lourd. Elle est interprétable, robuste sur petit échantillon et directement
 * explicable à l'utilisateur (§21 « transparence »).
 */

import type { LeagueBaseline, MatchRecord, TeamSnapshot } from "./types";
import { mean, recencyWeightedMean, shrink, stdDev } from "./math";

/** Nombre de matchs de référence pour le « shrinkage » bayésien. */
const SHRINK_K_ATTACK = 6;
const SHRINK_K_DEFENSE = 6;

export interface TeamRatings {
  /** Force offensive domicile (> 1 = au-dessus de la moyenne). */
  homeAttack: number;
  /** Solidité défensive domicile (< 1 = encaisse moins que la moyenne). */
  homeDefense: number;
  /** Force offensive extérieure. */
  awayAttack: number;
  /** Solidité défensive extérieure. */
  awayDefense: number;
  /** Force offensive globale (matchs joués à domicile et à l'extérieur). */
  attack: number;
  /** Solidité défensive globale. */
  defense: number;
  /** Indice de forme 0-100 pondéré par récence. */
  formIndex: number;
  /** Régularité 0-100 : faible dispersion des performances récentes. */
  consistency: number;
  /** xG par match si disponibles, sinon `null`. */
  xgPerMatch: number | null;
  xgaPerMatch: number | null;
  /** Nombre de matchs effectivement exploités. */
  sampleSize: number;
  homeSampleSize: number;
  awaySampleSize: number;
  avgGoalsFor: number | null;
  avgGoalsAgainst: number | null;
  /** Points par match sur les 6 derniers matchs, pondérés par récence. */
  recentPointsPerGame: number | null;
  cleanSheetRate: number | null;
  failedToScoreRate: number | null;
  bttsRate: number | null;
}

/** Extrait le nombre de buts marqués/encaissés par `teamId` dans un match. */
function goalsFor(match: MatchRecord, teamId: string) {
  return match.homeTeamId === teamId ? match.homeGoals : match.awayGoals;
}
function goalsAgainst(match: MatchRecord, teamId: string) {
  return match.homeTeamId === teamId ? match.awayGoals : match.homeGoals;
}

/** xG de l'équipe dans un match, `null` si la source ne les fournit pas. */
export function xgFor(match: MatchRecord, teamId: string): number | null {
  if (match.homeTeamId === teamId) return match.homeXg;
  return match.awayXg;
}
export function xgAgainst(match: MatchRecord, teamId: string): number | null {
  if (match.homeTeamId === teamId) return match.awayXg;
  return match.homeXg;
}

/** Tirs cadrés de l'équipe dans un match, `null` si la source ne les fournit pas. */
export function sotFor(match: MatchRecord, teamId: string): number | null {
  if (match.homeTeamId === teamId) return match.homeShotsOnTarget;
  return match.awayShotsOnTarget;
}
/** Tirs cadrés encaissés par l'équipe dans un match. */
export function sotAgainst(match: MatchRecord, teamId: string): number | null {
  if (match.homeTeamId === teamId) return match.awayShotsOnTarget;
  return match.homeShotsOnTarget;
}

/** Résultat du match du point de vue de `teamId`. */
export function matchOutcome(match: MatchRecord, teamId: string): "WIN" | "DRAW" | "LOSS" {
  const gf = goalsFor(match, teamId);
  const ga = goalsAgainst(match, teamId);
  if (gf > ga) return "WIN";
  if (gf < ga) return "LOSS";
  return "DRAW";
}

export function pointsFor(match: MatchRecord, teamId: string): number {
  const o = matchOutcome(match, teamId);
  return o === "WIN" ? 3 : o === "DRAW" ? 1 : 0;
}

/**
 * Calcule les ratings d'une équipe.
 *
 * @param snapshot vue consolidée de l'équipe
 * @param baseline moyennes de la compétition
 * @param recentWindow nombre de matchs récents pour la forme (défaut 6)
 */
export function computeTeamRatings(
  snapshot: TeamSnapshot,
  baseline: LeagueBaseline,
  recentWindow = 6,
): TeamRatings {
  const teamId = snapshot.identity.id;
  const matches = [...snapshot.seasonMatches].sort((a, b) => b.date.getTime() - a.date.getTime());
  const recent = matches.slice(0, recentWindow);

  const homeMatches = matches.filter((m) => m.homeTeamId === teamId);
  const awayMatches = matches.filter((m) => m.awayTeamId === teamId);

  // --- Ratios bruts domicile ---
  const homeScored = homeMatches.map((m) => m.homeGoals);
  const homeConceded = homeMatches.map((m) => m.awayGoals);
  const homeScoredAvg = mean(homeScored);
  const homeConcededAvg = mean(homeConceded);

  // --- Ratios bruts extérieur ---
  const awayScored = awayMatches.map((m) => m.awayGoals);
  const awayConceded = awayMatches.map((m) => m.homeGoals);
  const awayScoredAvg = mean(awayScored);
  const awayConcededAvg = mean(awayConceded);

  // --- Ratios relatifs à la compétition, avec shrinkage ---
  const homeAttackRaw = homeScoredAvg !== null ? homeScoredAvg / baseline.homeGoalsPerMatch : 1;
  const homeDefenseRaw = homeConcededAvg !== null ? homeConcededAvg / baseline.awayGoalsPerMatch : 1;
  const awayAttackRaw = awayScoredAvg !== null ? awayScoredAvg / baseline.awayGoalsPerMatch : 1;
  const awayDefenseRaw = awayConcededAvg !== null ? awayConcededAvg / baseline.homeGoalsPerMatch : 1;

  const homeAttack = shrink(homeAttackRaw, 1, homeMatches.length, SHRINK_K_ATTACK);
  const homeDefense = shrink(homeDefenseRaw, 1, homeMatches.length, SHRINK_K_DEFENSE);
  const awayAttack = shrink(awayAttackRaw, 1, awayMatches.length, SHRINK_K_ATTACK);
  const awayDefense = shrink(awayDefenseRaw, 1, awayMatches.length, SHRINK_K_DEFENSE);

  // --- Ratings globaux (pondérés par les volumes domicile/extérieur) ---
  const totalFor = matches.map((m) => goalsFor(m, teamId));
  const totalAgainst = matches.map((m) => goalsAgainst(m, teamId));
  const avgFor = mean(totalFor);
  const avgAgainst = mean(totalAgainst);

  const overallAttackRaw =
    avgFor !== null ? avgFor / ((baseline.homeGoalsPerMatch + baseline.awayGoalsPerMatch) / 2) : 1;
  const overallDefenseRaw =
    avgAgainst !== null
      ? avgAgainst / ((baseline.homeGoalsPerMatch + baseline.awayGoalsPerMatch) / 2)
      : 1;

  const attack = shrink(overallAttackRaw, 1, matches.length, SHRINK_K_ATTACK);
  const defense = shrink(overallDefenseRaw, 1, matches.length, SHRINK_K_DEFENSE);

  // --- Forme : points pondérés par récence, normalisés 0-100 ---
  const recentPpgRaw = recencyWeightedMean(
    recent.map((m) => pointsFor(m, teamId)),
    recentWindow / 2,
  );
  // 3 points/match = 100, 0 point/match = 0.
  const formIndex = recentPpgRaw === null ? 50 : Math.round((recentPpgRaw / 3) * 100);

  // --- Régularité : inverse de la dispersion des points (0-100) ---
  const recentPoints = recent.map((m) => pointsFor(m, teamId));
  const sd = stdDev(recentPoints);
  // Écart-type maximal théorique sur 0-3 = 1.5 (distribution bimodale extrême)
  const consistency = sd === null ? 50 : Math.round(Math.max(0, 100 - (sd / 1.5) * 100));

  // --- xG ---
  const xgValues = matches.map((m) => xgFor(m, teamId)).filter((v): v is number => v !== null);
  const xgaValues = matches.map((m) => xgAgainst(m, teamId)).filter((v): v is number => v !== null);
  const xgPerMatch = mean(xgValues);
  const xgaPerMatch = mean(xgaValues);

  // --- Taux dérivés ---
  const cleanSheets = matches.filter((m) => goalsAgainst(m, teamId) === 0).length;
  const failedToScore = matches.filter((m) => goalsFor(m, teamId) === 0).length;
  const bttsCount = matches.filter(
    (m) => m.homeGoals > 0 && m.awayGoals > 0,
  ).length;

  return {
    homeAttack,
    homeDefense,
    awayAttack,
    awayDefense,
    attack,
    defense,
    formIndex,
    consistency,
    xgPerMatch,
    xgaPerMatch,
    sampleSize: matches.length,
    homeSampleSize: homeMatches.length,
    awaySampleSize: awayMatches.length,
    avgGoalsFor: avgFor,
    avgGoalsAgainst: avgAgainst,
    recentPointsPerGame: recentPpgRaw,
    cleanSheetRate: matches.length ? cleanSheets / matches.length : null,
    failedToScoreRate: matches.length ? failedToScore / matches.length : null,
    bttsRate: matches.length ? bttsCount / matches.length : null,
  };
}

/**
 * Calcule les moyennes de référence d'une compétition.
 * Retourne `null` si l'échantillon est trop faible pour être honnête.
 */
export function computeLeagueBaseline(matches: MatchRecord[]): LeagueBaseline | null {
  const finished = matches.filter((m) => m.homeGoals >= 0 && m.awayGoals >= 0);
  if (finished.length < 10) return null;

  const homeGoals = finished.reduce((a, m) => a + m.homeGoals, 0);
  const awayGoals = finished.reduce((a, m) => a + m.awayGoals, 0);
  const n = finished.length;

  const withHt = finished.filter(
    (m) => m.halfTimeHomeGoals !== null && m.halfTimeAwayGoals !== null,
  );
  const fhGoals = withHt.reduce(
    (a, m) => a + (m.halfTimeHomeGoals ?? 0) + (m.halfTimeAwayGoals ?? 0),
    0,
  );
  const totalForShare = withHt.reduce((a, m) => a + m.homeGoals + m.awayGoals, 0);
  const firstHalfGoalShare =
    totalForShare > 0 ? fhGoals / totalForShare : 0.45; // repli prudent documenté

  return {
    homeGoalsPerMatch: homeGoals / n,
    awayGoalsPerMatch: awayGoals / n,
    totalGoalsPerMatch: (homeGoals + awayGoals) / n,
    bttsRate: finished.filter((m) => m.homeGoals > 0 && m.awayGoals > 0).length / n,
    firstHalfGoalRate:
      withHt.length > 0
        ? withHt.filter((m) => (m.halfTimeHomeGoals ?? 0) + (m.halfTimeAwayGoals ?? 0) > 0).length /
          withHt.length
        : 0.7,
    firstHalfGoalShare,
    sampleSize: n,
  };
}

/** Le ratio de buts par mi-temps, calculé par équipe et par côté. */
export function halfSplitRatios(
  matches: MatchRecord[],
  teamId: string,
): { firstHalfShare: number; sample: number } | null {
  const withHt = matches.filter(
    (m) => m.halfTimeHomeGoals !== null && m.halfTimeAwayGoals !== null,
  );
  if (withHt.length < 5) return null;
  let fh = 0;
  let total = 0;
  for (const m of withHt) {
    const isHome = m.homeTeamId === teamId;
    const scored = isHome ? m.homeGoals : m.awayGoals;
    const scoredHt = isHome ? m.halfTimeHomeGoals! : m.halfTimeAwayGoals!;
    fh += scoredHt;
    total += scored;
  }
  if (total === 0) return null;
  return { firstHalfShare: fh / total, sample: withHt.length };
}
