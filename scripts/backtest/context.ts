/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Pare-feu temporel (anti-fuite)
 * ============================================================================
 * §2 — Priorité absolue. Pour prédire « A vs B », le modèle ne peut utiliser
 * que ce qui était connu AVANT le coup d'envoi.
 *
 * Ce module est le SEUL endroit qui construit un contexte de backtest. Toute
 * information y entre par un filtre strict `date < coup d'envoi`. Un match du
 * jour J ne voit jamais :
 *   · son propre score, ses propres xG, ses propres statistiques ;
 *   · aucun match joué à une date ≥ J, dans aucune compétition.
 *
 * `auditContextLeakage()` permet de vérifier cette propriété après coup, et
 * `scripts/backtest/__tests__/leakage.test.ts` l'exige automatiquement.
 */

import { fitDixonColesRho } from "../../src/server/engine/math";
import type {
  LeagueBaseline,
  MatchContext,
  MatchRecord,
  TeamIdentity,
  TeamSnapshot,
} from "../../src/server/engine/types";
import type { BacktestMatch } from "./dataset";

/** Nombre maximum de matchs conservés par équipe (bornes la mémoire du moteur). */
export const DEFAULT_HISTORY_LIMIT = 40;

/** Convertit un match du backtest au contrat du moteur. */
export function toMatchRecord(match: BacktestMatch): MatchRecord {
  return {
    id: match.id,
    date: match.date,
    competition: match.competition,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeGoals: match.homeGoals,
    awayGoals: match.awayGoals,
    halfTimeHomeGoals: match.halfTimeHomeGoals,
    halfTimeAwayGoals: match.halfTimeAwayGoals,
    homeXg: match.homeXg,
    awayXg: match.awayXg,
    homeShots: match.homeShots,
    awayShots: match.awayShots,
    homeShotsOnTarget: match.homeShotsOnTarget,
    awayShotsOnTarget: match.awayShotsOnTarget,
    homeCorners: match.homeCorners,
    awayCorners: match.awayCorners,
    homeYellowCards: match.homeYellowCards,
    awayYellowCards: match.awayYellowCards,
    source: match.source,
  };
}

/**
 * Matchs STRICTEMENT antérieurs au coup d'envoi.
 *
 * `<` et non `<=` : deux rencontres peuvent partager la même date, et accepter
 * l'égalité ferait entrer le match du jour dans son propre contexte.
 */
export function strictlyPrior(matches: BacktestMatch[], kickoff: Date): BacktestMatch[] {
  const t = kickoff.getTime();
  return matches.filter((m) => m.date.getTime() < t);
}

/** Historique d'une équipe, du plus récent au plus ancien. */
export function teamHistory(
  matches: BacktestMatch[],
  teamId: string,
  kickoff: Date,
  limit = DEFAULT_HISTORY_LIMIT,
): BacktestMatch[] {
  return strictlyPrior(matches, kickoff)
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);
}

/** Confrontations directes antérieures entre les deux équipes. */
export function headToHeadHistory(
  matches: BacktestMatch[],
  homeTeamId: string,
  awayTeamId: string,
  kickoff: Date,
  limit = 10,
): BacktestMatch[] {
  return strictlyPrior(matches, kickoff)
    .filter(
      (m) =>
        (m.homeTeamId === homeTeamId && m.awayTeamId === awayTeamId) ||
        (m.homeTeamId === awayTeamId && m.awayTeamId === homeTeamId),
    )
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);
}

/**
 * Moyennes de référence de la compétition, calculées sur le passé seul.
 * Un échantillon nul reste un échantillon nul : on renvoie des valeurs de
 * repli explicites plutôt que de diviser par zéro.
 */
export function buildLeagueBaseline(matches: BacktestMatch[], competition: string, kickoff: Date): LeagueBaseline {
  const prior = strictlyPrior(matches, kickoff).filter((m) => m.competition === competition);

  if (prior.length === 0) {
    return {
      homeGoalsPerMatch: 1.5,
      awayGoalsPerMatch: 1.15,
      // Repli documenté : moyennes de long terme du football européen.
      totalGoalsPerMatch: 2.65,
      bttsRate: 0.52,
      firstHalfGoalRate: 0.72,
      firstHalfGoalShare: 0.44,
      sampleSize: 0,
    };
  }

  let homeGoals = 0;
  let awayGoals = 0;
  let btts = 0;
  let htWithGoal = 0;
  let htGoals = 0;
  let totalGoals = 0;
  let htSample = 0;

  for (const m of prior) {
    homeGoals += m.homeGoals;
    awayGoals += m.awayGoals;
    totalGoals += m.homeGoals + m.awayGoals;
    if (m.homeGoals > 0 && m.awayGoals > 0) btts += 1;
    if (m.halfTimeHomeGoals !== null && m.halfTimeAwayGoals !== null) {
      htSample += 1;
      htGoals += m.halfTimeHomeGoals + m.halfTimeAwayGoals;
      if (m.halfTimeHomeGoals + m.halfTimeAwayGoals > 0) htWithGoal += 1;
    }
  }

  const n = prior.length;
  return {
    homeGoalsPerMatch: homeGoals / n,
    awayGoalsPerMatch: awayGoals / n,
    totalGoalsPerMatch: totalGoals / n,
    bttsRate: btts / n,
    firstHalfGoalRate: htSample > 0 ? htWithGoal / htSample : 0.72,
    firstHalfGoalShare: htSample > 0 && totalGoals > 0 ? htGoals / totalGoals : 0.44,
    sampleSize: n,
  };
}

function identity(match: BacktestMatch, side: "home" | "away", leagueName: string): TeamIdentity {
  const name = side === "home" ? match.homeTeamName : match.awayTeamName;
  return {
    id: side === "home" ? match.homeTeamId : match.awayTeamId,
    name,
    shortName: null,
    tla: null,
    crest: null,
    leagueId: match.competition,
    leagueName,
  };
}

function snapshot(
  match: BacktestMatch,
  side: "home" | "away",
  matches: BacktestMatch[],
  leagueName: string,
  historyLimit: number,
): TeamSnapshot {
  const team = side === "home" ? match.homeTeamId : match.awayTeamId;
  const opponent = side === "home" ? match.awayTeamId : match.homeTeamId;
  const history = teamHistory(matches, team, match.date, historyLimit);

  return {
    identity: identity(match, side, leagueName),
    seasonMatches: history.map(toMatchRecord),
    headToHead: headToHeadHistory(matches, match.homeTeamId, match.awayTeamId, match.date).map(toMatchRecord),
    hasXg: history.some((m) => m.homeXg !== null || m.awayXg !== null),
    sourceScores: { [match.source]: 1 },
  };
}

export interface ContextOptions {
  historyLimit?: number;
  /** Libellé de compétition utilisé dans l'identité des équipes. */
  leagueName?: string;
}

/**
 * Construit le contexte d'une rencontre à partir du passé seul.
 * `matches` doit contenir l'historique complet — le filtrage est fait ici.
 */
export function buildBacktestContext(
  match: BacktestMatch,
  matches: BacktestMatch[],
  options: ContextOptions = {},
): MatchContext {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const leagueName = options.leagueName ?? match.competition;
  const baseline = buildLeagueBaseline(matches, match.competition, match.date);

  const home = snapshot(match, "home", matches, leagueName, historyLimit);
  const away = snapshot(match, "away", matches, leagueName, historyLimit);

  // ρ Dixon–Coles estimé sur les matchs ANTÉRIEURS des deux équipes, avec les
  // intensités de référence de la compétition (identiques au moteur).
  const observed = [...home.seasonMatches, ...away.seasonMatches].map((m) => ({
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    lambdaHome: baseline.homeGoalsPerMatch,
    lambdaAway: baseline.awayGoalsPerMatch,
  }));
  const rho = fitDixonColesRho(observed);

  return {
    matchId: match.id,
    date: match.date,
    competition: match.competition,
    leagueId: match.competition,
    home,
    away,
    leagueBaseline: baseline,
  };
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------

export interface LeakageFinding {
  kind: "match-du-jour" | "match-futur";
  matchId: string;
  detail: string;
}

/**
 * Audite un contexte : renvoie toute information postérieure au coup d'envoi.
 *
 * · « match-du-jour » : le match cible apparaît dans son propre contexte ;
 * · « match-futur »  : un match postérieur s'y est glissé.
 *
 * Fonction volontairement exhaustive : elle inspecte chaque MatchRecord du
 * contexte (historique d'équipe, confrontations directes, base de compétition).
 */
export function auditContextLeakage(context: MatchContext, allMatches: BacktestMatch[]): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  const kickoff = context.date.getTime();
  const byId = new Map(allMatches.map((m) => [m.id, m]));

  const records: { origin: string; record: MatchRecord }[] = [];
  for (const [label, snap] of [
    ["home", context.home],
    ["away", context.away],
  ] as const) {
    for (const record of snap.seasonMatches) records.push({ origin: `historique ${label}`, record });
    for (const record of snap.headToHead) records.push({ origin: `confrontations ${label}`, record });
  }

  for (const { origin, record } of records) {
    if (record.id === context.matchId) {
      findings.push({
        kind: "match-du-jour",
        matchId: context.matchId,
        detail: `le match cible apparaît dans son propre contexte (${origin})`,
      });
      continue;
    }
    if (record.date.getTime() >= kickoff) {
      findings.push({
        kind: "match-futur",
        matchId: context.matchId,
        detail: `${record.id} joué le ${record.date.toISOString().slice(0, 10)} ≥ coup d'envoi (${origin})`,
      });
    }
    if (!byId.has(record.id)) {
      findings.push({
        kind: "match-futur",
        matchId: context.matchId,
        detail: `match inconnu du dataset : ${record.id} (${origin})`,
      });
    }
  }

  // La base de compétition porte un échantillon ; on vérifie sa traçabilité.
  if (context.leagueBaseline.sampleSize > 0) {
    const priorCount = allMatches.filter(
      (m) => m.competition === context.competition && m.date.getTime() < kickoff,
    ).length;
    if (context.leagueBaseline.sampleSize > priorCount) {
      findings.push({
        kind: "match-futur",
        matchId: context.matchId,
        detail: `base de compétition : ${context.leagueBaseline.sampleSize} matchs déclarés > ${priorCount} matchs antérieurs réels`,
      });
    }
  }

  return findings;
}
