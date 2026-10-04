/**
 * ============================================================================
 * SOLEIL — §4 à §6 (Phase 15) · Erreur mesurée d'une prédiction
 * ============================================================================
 * Une prédiction publiée devient, une fois le match terminé, une observation
 * d'apprentissage. Ce module transforme une prédiction réglée en une ligne
 * d'erreur : une par marché, plus les deux scores de référence (Brier et
 * Log Loss) et les biais signés.
 *
 * Règles tenues :
 *  • **Aucune probabilité n'est recalculée ici.** On lit ce qui a été publié
 *    et on le compare au résultat réel. Si une valeur manque, elle vaut
 *    `null` — jamais zéro, jamais une estimation.
 *  • **Le résultat réel n'entre jamais dans la prédiction.** Il est lu après,
 *    dans une fonction pure qui ne retourne rien au moteur.
 *  • **Biais signé** : une valeur positive signifie que le modèle a
 *    surestimé l'événement. C'est ce signe qui permet de repérer un biais
 *    systématique (§5) plutôt qu'un simple bruit.
 */

/** Vue de prédiction persistée, telle qu'affichée à l'utilisateur. */
export interface ErrorInputView {
  outcomes: { home: number; draw: number; away: number };
  consensusPick: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  expectedGoals?: { total: number };
  totalGoals: { line: number; over: number; under: number }[];
  btts: { yes: number; no: number };
  teamGoals: {
    side: "home" | "away";
    distribution: number[];
    overUnder: { line: number; over: number; under: number }[];
  }[];
  exactScore: {
    mostLikely: { score: string; probability: number };
    top: { score: string; probability: number }[];
  };
  models?: { name: string; applicable: boolean; weight: number }[];
  confidence?: { score: number };
}

export interface ErrorInputPrediction {
  id: string;
  matchId: string;
  modelVersion: string;
  createdAt: Date;
  confidenceScore: number;
  dataQuality: string;
  view: ErrorInputView;
}

export interface ErrorInputMatch {
  id: string;
  utcDate: Date;
  competition: string;
  homeScore: number | null;
  awayScore: number | null;
  season?: string | null;
}

/** Ligne d'erreur, telle qu'elle sera écrite en base. */
export interface PredictionErrorRecord {
  predictionId: string;
  matchId: string;
  modelVersion: string;
  predictedAt: Date;
  matchDate: Date;

  /** Probabilité manquante sur l'issue réalisée : 1 − P(réalisé). 0 = parfait. */
  error1x2: number;
  /** Erreur absolue sur Over 2,5. */
  errorOver25: number;
  /** Erreur absolue sur BTTS oui. */
  errorBtts: number;
  /** Erreur absolue sur « domicile marque au moins 1 but ». */
  errorTeamHome: number;
  /** Erreur absolue sur « extérieur marque au moins 1 but ». */
  errorTeamAway: number;
  /** Probabilité manquante sur le score exact réalisé, si le classement le contient. */
  errorExactScore: number | null;

  /** Brier multiclasse du 1X2 (0 = parfait, 2 = pire). */
  brier: number;
  /** Log Loss du 1X2 (0 = parfait). */
  logLoss: number;
  /** Écart de l'issue publiée à son résultat : |P(publiée) − résultat|. */
  calibration: number;
  /** L'issue publiée s'est-elle réalisée ? */
  hit: boolean;
  /** Probabilité accordée à l'issue publiée — base du calcul de calibration. */
  pickProbability: number;

  /** Biais signés (positif = surestimation). */
  biasHome: number;
  biasOver25: number;
  biasBtts: number;

  competition: string;
  season: string | null;
  confidence: number;
  dataGrade: string;
  xgUsed: boolean;
  xgWeight: number;
  expectedGoals: number | null;
  favouriteSide: "HOME" | "DRAW" | "AWAY";
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

function parseScore(score: string): { home: number; away: number } | null {
  const m = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(score.trim());
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

/** Issue réellement produite par le match. */
export function actualOutcome(home: number, away: number): "HOME_WIN" | "DRAW" | "AWAY_WIN" {
  if (home > away) return "HOME_WIN";
  if (home === away) return "DRAW";
  return "AWAY_WIN";
}

/**
 * Construit la ligne d'erreur d'une prédiction réglée.
 * Renvoie `null` si le match n'a pas de score final : on n'apprend rien d'un
 * match non joué, et on ne devine pas son résultat.
 */
export function computePredictionError(
  prediction: ErrorInputPrediction,
  match: ErrorInputMatch,
): PredictionErrorRecord | null {
  const home = match.homeScore;
  const away = match.awayScore;
  if (home === null || away === null) return null;

  const view = prediction.view;
  const realized = actualOutcome(home, away);
  const pRealized =
    realized === "HOME_WIN" ? view.outcomes.home : realized === "DRAW" ? view.outcomes.draw : view.outcomes.away;
  const pPick =
    view.consensusPick === "HOME_WIN"
      ? view.outcomes.home
      : view.consensusPick === "DRAW"
        ? view.outcomes.draw
        : view.outcomes.away;

  // --- 1X2 : Brier multiclasse et Log Loss sur l'issue réalisée -------------
  const y = [realized === "HOME_WIN" ? 1 : 0, realized === "DRAW" ? 1 : 0, realized === "AWAY_WIN" ? 1 : 0];
  const p = [view.outcomes.home, view.outcomes.draw, view.outcomes.away];
  const brier = p.reduce((sum, value, i) => sum + (value - y[i]!) ** 2, 0);
  const logLoss = -Math.log(Math.min(Math.max(pRealized, 1e-12), 1));

  // --- Over 2,5 -------------------------------------------------------------
  const line25 = view.totalGoals.find((l) => l.line === 2.5);
  const totalGoals = home + away;
  const over25 = totalGoals > 2.5 ? 1 : 0;
  const errorOver25 = line25 ? Math.abs(line25.over - over25) : Number.NaN;

  // --- BTTS -----------------------------------------------------------------
  const btts = home > 0 && away > 0 ? 1 : 0;
  const errorBtts = Math.abs(view.btts.yes - btts);

  // --- Buts par équipe (ligne 0,5 : marque au moins un but) ------------------
  const teamLine = (side: "home" | "away"): number | null => {
    const team = view.teamGoals.find((t) => t.side === side);
    if (!team) return null;
    const half = team.overUnder.find((l) => l.line === 0.5);
    if (half) return half.over;
    // À défaut, la distribution donne P(0 but) et donc P(≥ 1 but).
    const zero = team.distribution[0];
    return zero === undefined ? null : clamp01(1 - zero);
  };
  const pHomeScores = teamLine("home");
  const pAwayScores = teamLine("away");
  const errorTeamHome = pHomeScores === null ? Number.NaN : Math.abs(pHomeScores - (home > 0 ? 1 : 0));
  const errorTeamAway = pAwayScores === null ? Number.NaN : Math.abs(pAwayScores - (away > 0 ? 1 : 0));

  // --- Score exact ----------------------------------------------------------
  const entry = view.exactScore.top.find((s) => parseScore(s.score)?.home === home && parseScore(s.score)?.away === away);
  const errorExactScore = entry ? 1 - entry.probability : null;

  // --- xG (trace d'apprentissage §4) ---------------------------------------
  const xgModel = view.models?.find((m) => m.name === "xg");
  const xgUsed = Boolean(xgModel?.applicable);

  const ordered = (["HOME_WIN", "DRAW", "AWAY_WIN"] as const).slice().sort((a, b) => {
    const pa = a === "HOME_WIN" ? view.outcomes.home : a === "DRAW" ? view.outcomes.draw : view.outcomes.away;
    const pb = b === "HOME_WIN" ? view.outcomes.home : b === "DRAW" ? view.outcomes.draw : view.outcomes.away;
    return pb - pa;
  });

  return {
    predictionId: prediction.id,
    matchId: prediction.matchId,
    modelVersion: prediction.modelVersion,
    predictedAt: prediction.createdAt,
    matchDate: match.utcDate,

    error1x2: 1 - pRealized,
    errorOver25,
    errorBtts,
    errorTeamHome,
    errorTeamAway,
    errorExactScore,

    brier,
    logLoss,
    calibration: Math.abs(pPick - (view.consensusPick === realized ? 1 : 0)),
    hit: view.consensusPick === realized,
    pickProbability: pPick,

    biasHome: view.outcomes.home - (realized === "HOME_WIN" ? 1 : 0),
    biasOver25: (line25?.over ?? Number.NaN) - over25,
    biasBtts: view.btts.yes - btts,

    competition: match.competition,
    season: match.season ?? null,
    confidence: prediction.confidenceScore,
    dataGrade: prediction.dataQuality,
    xgUsed,
    xgWeight: xgModel?.weight ?? 0,
    expectedGoals: view.expectedGoals?.total ?? null,
    favouriteSide: ordered[0] === "HOME_WIN" ? "HOME" : ordered[0] === "DRAW" ? "DRAW" : "AWAY",
  };
}
