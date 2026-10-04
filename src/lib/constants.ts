/** Constantes globales de l'application SOLEIL. */

export const APP_NAME = "SOLEIL";
export const APP_TAGLINE = "L'intelligence qui lit le football.";
export const APP_SUBTITLE = "Analysez. Comprenez. Anticipez.";

/** Version du moteur de prédiction — stockée avec chaque prédiction (§22). */
export const ENGINE_VERSION = "1.0.0";

/**
 * §1 (Phase 15) — Origine du 1X2 publié.
 *
 *  « matrix »    : P(1) / P(X) / P(2) sont LUS dans la distribution de scores.
 *                  Tous les marchés proviennent alors d'une source unique, et
 *                  les identités mathématiques sont exactes par construction.
 *  « consensus » : moyenne pondérée des modèles — comportement d'avant la
 *                  phase 15, qui pouvait s'écarter de la matrice de scores.
 *
 * Le commutateur rend le changement mesurable et réversible : changer cette
 * ligne suffit à revenir au comportement précédent. La valeur retenue est
 * celle validée par `scripts/backtest/phase15.ts` (§21 : aucun changement de
 * moteur sans backtest).
 */
/**
 * Source publiée du 1X2 (§1, Phase 15).
 *
 *  • "matrix"    : P(1) = Σ P(score) avec buts dom > buts ext, etc. Le 1X2 est
 *                  alors *dérivé de la distribution de scores* : score exact,
 *                  distribution et 1X2 racontent forcément la même histoire.
 *  • "consensus" : moyenne pondérée des modèles (comportement d'avant Phase 15).
 *
 * Bascule décidée après backtest (1 520 rencontres, hors échantillon inclus) :
 * la matrice n'apporte aucun gain établi (−0,0002 [−0,0017 ; +0,0013]) mais
 * n'entraîne aucune dégradation (0 ligne dégradée sur 41). C'est donc un choix
 * de **cohérence**, pas une amélioration revendiquée.
 */
export const OUTCOME_SOURCE: "matrix" | "consensus" = "matrix";

/**
 * Libellés des compétitions couvertes par le fournisseur historique
 * (football-data.co.uk — données réelles, aucune clé API requise).
 * "code" est le code de division utilisé par la source.
 */
export const HISTORICAL_LEAGUES = [
  { code: "E0", name: "Premier League", country: "England", countryCode: "GB", tier: 1 },
  { code: "E1", name: "Championship", country: "England", countryCode: "GB", tier: 2 },
  { code: "SP1", name: "La Liga", country: "Spain", countryCode: "ES", tier: 1 },
  { code: "D1", name: "Bundesliga", country: "Germany", countryCode: "DE", tier: 1 },
  { code: "I1", name: "Serie A", country: "Italy", countryCode: "IT", tier: 1 },
  { code: "F1", name: "Ligue 1", country: "France", countryCode: "FR", tier: 1 },
  { code: "N1", name: "Eredivisie", country: "Netherlands", countryCode: "NL", tier: 1 },
  { code: "P1", name: "Primeira Liga", country: "Portugal", countryCode: "PT", tier: 1 },
  { code: "B1", name: "Jupiler Pro League", country: "Belgium", countryCode: "BE", tier: 1 },
  { code: "T1", name: "Süper Lig", country: "Turkey", countryCode: "TR", tier: 1 },
  { code: "G1", name: "Super League", country: "Greece", countryCode: "GR", tier: 1 },
  { code: "SC0", name: "Scottish Premiership", country: "Scotland", countryCode: "GB", tier: 1 },
] as const;

/** Marchés proposés — le cœur de la V1 (§33). */
export const MARKETS = {
  RESULT: "result",
  TOTAL_GOALS: "total_goals",
  TEAM_GOALS: "team_goals",
  HALF_TIME: "half_time",
  BTTS: "btts",
  EXACT_SCORE: "exact_score",
} as const;

export type MarketKey = (typeof MARKETS)[keyof typeof MARKETS];

/**
 * Formulations interdites (§20, §32) — vérifiées par un test automatisé.
 * SOLEIL n'affiche jamais une prédiction comme une certitude.
 */
export const FORBIDDEN_PHRASES = [
  "pari sûr",
  "paris sûr",
  "100%",
  "100 %",
  "garanti",
  "garantie",
  "certain",
  "certaine",
  "infaillible",
  "sans risque",
] as const;

/** Seuils du SOLEIL CONFIDENCE SCORE (§13). */
export const CONFIDENCE_THRESHOLDS = {
  MIN_PUBLISHABLE: 45, // en dessous : « Prédiction non publiée — données insuffisantes »
  HIGH: 68,
  VERY_HIGH: 80,
} as const;

/** Poids par défaut des modèles dans l'ensemble (§14). */
export const DEFAULT_MODEL_WEIGHTS = {
  poisson: 0.28,
  statistical: 0.2,
  xg: 0.18,
  form: 0.16,
  homeAway: 0.18,
} as const;

/** Taille maximale des prédictions publiées par jour (§18). */
export const MAX_DAILY_PICKS = 12;
