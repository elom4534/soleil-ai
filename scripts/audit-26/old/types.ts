/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Types du domaine
 * ============================================================================
 * Le moteur ne dépend ni de Prisma ni de Next.js : il consomme des structures
 * pures et produit des structures pures. Cela le rend testable et remplaçable
 * (cf. §3 « Prediction Engine modulaire »).
 */

/** Un match terminé, tel qu'exploité par les modèles. */
export interface MatchRecord {
  /** Identifiant stable côté SOLEIL. */
  id: string;
  date: Date;
  competition: string;
  /** Identifiant de l'équipe à domicile. */
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
  /** Buts à la mi-temps — `null` si la source ne les fournit pas. */
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  /** Statistiques avancées — `null` si indisponibles (jamais inventées, cf. §34). */
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
  /** Source ayant fourni la donnée (traçabilité, cf. §4). */
  source: string;
}

export interface TeamIdentity {
  id: string;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
  leagueId: string;
  leagueName: string;
}

/** Vue consolidée d'une équipe au moment de la prédiction. */
export interface TeamSnapshot {
  identity: TeamIdentity;
  /** Matchs de la saison en cours, du plus récent au plus ancien. */
  seasonMatches: MatchRecord[];
  /** Confrontations directes contre l'adversaire, du plus récent au plus ancien. */
  headToHead: MatchRecord[];
  /** Vrai si au moins une source fournit des xG exploitables. */
  hasXg: boolean;
  /** Scores de qualité par source (0-1) — cf. §4 « score de qualité des données ». */
  sourceScores: Record<string, number>;
}

export interface MatchContext {
  matchId: string;
  date: Date;
  competition: string;
  leagueId: string;
  home: TeamSnapshot;
  away: TeamSnapshot;
  /** Moyennes de référence de la compétition (buts/match). */
  leagueBaseline: LeagueBaseline;
}

export interface LeagueBaseline {
  homeGoalsPerMatch: number;
  awayGoalsPerMatch: number;
  totalGoalsPerMatch: number;
  /** Proportion de matchs où les deux équipes marquent. */
  bttsRate: number;
  /** Proportion de matchs avec au moins un but en 1re mi-temps. */
  firstHalfGoalRate: number;
  /** Part des buts marqués en 1re mi-temps. */
  firstHalfGoalShare: number;
  /** Nombre de matchs ayant servi au calcul. */
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// Sorties de modèles
// ---------------------------------------------------------------------------

export type Outcome = "HOME_WIN" | "DRAW" | "AWAY_WIN";

export interface OutcomeProbabilities {
  home: number;
  draw: number;
  away: number;
}

/** Sortie standardisée d'un modèle — tout modèle produit ce contrat. */
export interface ModelPrediction {
  /** Nom technique, ex. « poisson », « xg », « form ». */
  name: ModelName;
  /** Version sémantique du modèle. */
  version: string;
  /** Probabilités 1X2 normalisées. */
  outcomes: OutcomeProbabilities;
  /** Espérance de buts si le modèle sait la produire. */
  expectedGoals?: { home: number; away: number; total: number } | null;
  /** Confiance intrinsèque du modèle (0-1) — sert au pesage de l'ensemble. */
  selfConfidence: number;
  /** Poids calculé par l'ensemble. */
  weight: number;
  /** Indique si le modèle a réellement pu s'exécuter. */
  applicable: boolean;
  /** Raison de la non-applicabilité, ex. « xG indisponibles ». */
  unavailableReason?: string;
  /** Signaux explicatifs produits par le modèle. */
  signals: ModelSignal[];
}

export type ModelName =
  | "poisson"
  | "statistical"
  | "xg"
  | "shots"
  | "form"
  | "home_away"
  | "ml"
  | "ensemble";

export interface ModelSignal {
  /** Clé stable, ex. « home_attack_superiority ». */
  key: string;
  /** Libellé humain affiché dans « Pourquoi ? » (§21). */
  label: string;
  /** Valeur brute associée. */
  value: number | null;
  /** Impact sur la prédiction. */
  impact: "positive" | "negative" | "neutral";
  /** Côté concerné. */
  side: "home" | "away" | "total" | "both";
}

// ---------------------------------------------------------------------------
// Matrice de scores & marchés
// ---------------------------------------------------------------------------

/** Matrice de probabilité score exact : matrix[home][away]. */
export type ScoreMatrix = number[][];

export interface TotalGoalsMarket {
  line: number;
  over: number;
  under: number;
  /** Écart absolu entre Over et Under (mesure de la séparation). */
  spread: number;
  confidence: number;
  explanation: string;
}

export interface TeamGoalsMarket {
  teamId: string;
  side: "home" | "away";
  expectedGoals: number;
  /** Distribution exacte du nombre de buts : index 0..4 (4 = « 4+ »). */
  distribution: number[];
  overUnder: { line: number; over: number; under: number }[];
}

export interface HalfTimeMarket {
  firstHalf: {
    expectedGoals: number;
    distribution: number[];
    overUnder: { line: number; over: number; under: number }[];
    probAtLeastOneGoal: number;
  };
  secondHalf: {
    expectedGoals: number;
    distribution: number[];
    overUnder: { line: number; over: number; under: number }[];
    probAtLeastOneGoal: number;
  };
}

export interface ExactScoreEntry {
  score: string;
  home: number;
  away: number;
  probability: number;
}

export interface BttsMarket {
  yes: number;
  no: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Anomalies & confiance
// ---------------------------------------------------------------------------

export type AnomalyCode =
  | "INSUFFICIENT_MATCHES"
  | "NO_XG"
  | "STALE_DATA"
  | "CONTRADICTORY_STATS"
  | "EXTREME_VARIANCE"
  | "MODEL_DISAGREEMENT"
  | "UNBALANCED_SAMPLE"
  | "MISSING_H2H"
  | "LOW_SOURCE_DIVERSITY"
  | "ODD_DISTRIBUTION";

export interface Anomaly {
  code: AnomalyCode;
  severity: "info" | "warning" | "critical";
  message: string;
  /** Pénalité appliquée au score de confiance (points). */
  confidencePenalty: number;
}

export interface DataQualityReport {
  score: number; // 0-100
  grade: "EXCELLENT" | "GOOD" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  label: string;
  /** Détail des composantes du score. */
  components: {
    volume: number;
    recency: number;
    richness: number;
    sourceDiversity: number;
    coverage: number;
  };
  sources: { name: string; lastUpdate: Date | null; score: number }[];
  usedFields: string[];
  missingFields: string[];
}

export interface ConfidenceBreakdown {
  score: number; // 0-100
  grade: "TRES_FORTE" | "FORTE" | "MODEREE" | "FAIBLE" | "TRES_FAIBLE";
  label: string;
  components: {
    dataQuality: number;
    dataVolume: number;
    modelAgreement: number;
    stability: number;
    coherence: number;
  };
  penalties: { code: AnomalyCode; points: number; message: string }[];
}

// ---------------------------------------------------------------------------
// Résultat final du moteur
// ---------------------------------------------------------------------------

export interface PredictionResult {
  engineVersion: string;
  generatedAt: Date;
  /** Faux quand les données ne permettent pas une publication honnête (§15). */
  publishable: boolean;
  /** Message affiché quand `publishable` est faux. */
  blockingReason?: string;

  outcomes: OutcomeProbabilities;
  consensusPick: Outcome;

  /** §1 (Phase 15) — Origine du 1X2 publié. Conservé avec la prédiction. */
  outcomeSource: "matrix" | "consensus";
  /**
   * 1X2 du consensus pondéré, conservé même lorsqu'il n'est pas publié :
   * il sert à mesurer et à auditer l'écart entre les deux chemins.
   */
  consensusOutcomes: OutcomeProbabilities;
  consensus: {
    /** Accord entre modèles : 1 = unanimité, 0 = désaccord total. */
    agreement: number;
    /** Détail par modèle, pour la page « Modèles ». */
    models: ModelPrediction[];
    method: "weighted_average";
  };

  expectedGoals: { home: number; away: number; total: number };
  scoreMatrix: ScoreMatrix;

  markets: {
    totalGoals: TotalGoalsMarket[];
    teamGoals: { home: TeamGoalsMarket; away: TeamGoalsMarket };
    halfTime: HalfTimeMarket;
    bothTeamsToScore: BttsMarket;
    exactScore: {
      mostLikely: ExactScoreEntry;
      top: ExactScoreEntry[];
      /** Avertissement affiché avec le score exact (§10). */
      disclaimer: string;
    };
    goalsDistribution: { goals: number; probability: number }[];
  };

  confidence: ConfidenceBreakdown;
  dataQuality: DataQualityReport;
  anomalies: Anomaly[];

  /** Facteurs positifs et négatifs — alimente « Pourquoi ? » (§21). */
  explanation: {
    positive: ModelSignal[];
    negative: ModelSignal[];
    summary: string;
  };

  /** Statistiques dérivées utilisées, pour transparence. */
  derived: {
    homeAttackStrength: number;
    homeDefenseStrength: number;
    homeFormIndex: number;
    awayAttackStrength: number;
    awayDefenseStrength: number;
    awayFormIndex: number;
    homeXgPerMatch: number | null;
    awayXgPerMatch: number | null;
    h2hSample: number;
  };
}
