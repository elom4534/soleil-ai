/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Primitives mathématiques
 * ============================================================================
 * Implémentations pures, sans dépendance externe, afin de rester auditables
 * et vérifiables par des tests unitaires.
 */

import type { ScoreMatrix } from "./types";

/** Borne supérieure de la grille de scores. Les scores ≥ 10 buts sont repliés. */
export const MAX_GOALS = 10;

// ---------------------------------------------------------------------------
// Distributions élémentaires
// ---------------------------------------------------------------------------

/**
 * Factorielle via la fonction Gamma (Lanczos) — évite les dépassements
 * de capacité pour k > 170 tout en restant exacte pour les entiers usuels.
 */
export function factorial(n: number): number {
  if (n < 0) return NaN;
  if (n <= 1) return 1;
  if (n <= 170) {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  return Math.exp(logGamma(n + 1));
}

function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Loi de Poisson : P(X = k) = λ^k · e^-λ / k! */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || lambda < 0) return 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  // Calcul en log-espace pour la stabilité numérique.
  const logP = k * Math.log(lambda) - lambda - logGamma(k + 1);
  return Math.exp(logP);
}

/** Fonction de répartition de Poisson : P(X ≤ k). */
export function poissonCdf(k: number, lambda: number): number {
  let acc = 0;
  for (let i = 0; i <= Math.floor(k); i++) acc += poissonPmf(i, lambda);
  return Math.min(1, acc);
}

/**
 * Correction de Dixon–Coles (1997) pour la dépendance entre les scores
 * faibles (0-0, 1-0, 0-1, 1-1). Corrige la sous-estimation systématique
 * des scores serrés par le modèle de Poisson indépendant.
 *
 * @param rho Paramètre de dépendance, typiquement entre -0,15 et 0,05.
 */
export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

/** Loi de Poisson bivariée (Karlis & Ntzoufras) via composante commune. */
export function bivariatePoissonPmf(
  x: number,
  y: number,
  lambda1: number,
  lambda2: number,
  lambda3: number,
): number {
  let acc = 0;
  const kMax = Math.min(x, y);
  for (let k = 0; k <= kMax; k++) {
    acc +=
      poissonPmf(k, lambda3) *
      poissonPmf(x - k, lambda1) *
      poissonPmf(y - k, lambda2);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Matrice de scores
// ---------------------------------------------------------------------------

/**
 * Construit la matrice conjointe des scores à partir de deux intensités.
 *
 * @param dixonColes si vrai, applique la correction de Dixon–Coles.
 * @param rho paramètre ρ de la correction.
 */
export function buildScoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  options: { dixonColes?: boolean; rho?: number; maxGoals?: number } = {},
): ScoreMatrix {
  const { dixonColes = true, rho = -0.05, maxGoals = MAX_GOALS } = options;
  const matrix: ScoreMatrix = [];

  const pHome = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaHome));
  const pAway = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaAway));

  // Probabilité résiduelle (score > maxGoals) répartie proportionnellement :
  // elle doit figurer dans la matrice pour que la somme vaille 1.
  const tailHome = Math.max(0, 1 - pHome.reduce((a, b) => a + b, 0));
  const tailAway = Math.max(0, 1 - pAway.reduce((a, b) => a + b, 0));
  // On « déplace » la queue vers un score élevé représentatif plutôt que de la perdre.
  pHome[maxGoals] += tailHome * 0.6;
  pHome[maxGoals - 1] += tailHome * 0.4;
  pAway[maxGoals] += tailAway * 0.6;
  pAway[maxGoals - 1] += tailAway * 0.4;

  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      let p = pHome[h] * pAway[a];
      if (dixonColes) p *= dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      matrix[h][a] = Math.max(0, p);
    }
  }
  return normalizeMatrix(matrix);
}

/** Renormalise la matrice pour que la somme des probabilités vaille exactement 1. */
export function normalizeMatrix(matrix: ScoreMatrix): ScoreMatrix {
  let total = 0;
  for (const row of matrix) for (const p of row) total += p;
  if (total <= 0) return matrix;
  return matrix.map((row) => row.map((p) => p / total));
}

/**
 * Ajuste ρ (Dixon–Coles) par recherche sur une grille, en maximisant la
 * vraisemblance des matchs observés. Approche robuste et déterministe,
 * suffisante pour une correction de dépendance de second ordre.
 */
export function fitDixonColesRho(
  matches: { homeGoals: number; awayGoals: number; lambdaHome: number; lambdaAway: number }[],
): number {
  if (matches.length < 30) return -0.05; // échantillon trop faible → valeur par défaut

  const grid: number[] = [];
  for (let r = -0.15; r <= 0.051; r += 0.005) grid.push(Number(r.toFixed(3)));

  let best = -0.05;
  let bestLl = -Infinity;

  for (const rho of grid) {
    let ll = 0;
    for (const m of matches) {
      const tau = dixonColesTau(m.homeGoals, m.awayGoals, m.lambdaHome, m.lambdaAway, rho);
      if (tau <= 0) { ll = -Infinity; break; }
      ll += Math.log(tau);
    }
    if (ll > bestLl) {
      bestLl = ll;
      best = rho;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Exploitation de la matrice
// ---------------------------------------------------------------------------

export function outcomeProbabilities(matrix: ScoreMatrix) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}

export function overUnderProbability(matrix: ScoreMatrix, line: number) {
  let over = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      if (h + a > line) over += matrix[h][a];
    }
  }
  return { over, under: 1 - over };
}

export function bttsProbability(matrix: ScoreMatrix) {
  let yes = 0;
  for (let h = 1; h < matrix.length; h++) {
    for (let a = 1; a < matrix[h].length; a++) yes += matrix[h][a];
  }
  return { yes, no: 1 - yes };
}

export function teamGoalsDistribution(matrix: ScoreMatrix, side: "home" | "away") {
  const dist = [0, 0, 0, 0, 0]; // 0, 1, 2, 3, 4+
  const n = matrix.length;
  for (let h = 0; h < n; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const goals = side === "home" ? h : a;
      dist[Math.min(goals, 4)] += matrix[h][a];
    }
  }
  return dist;
}

export function totalGoalsDistribution(matrix: ScoreMatrix, maxBucket = 5) {
  const dist = new Array(maxBucket + 1).fill(0); // index 0..maxBucket (dernier = maxBucket+)
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const total = h + a;
      dist[Math.min(total, maxBucket)] += matrix[h][a];
    }
  }
  return dist;
}

export function expectedTotalGoals(matrix: ScoreMatrix) {
  let e = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) e += (h + a) * matrix[h][a];
  }
  return e;
}

export function exactScores(matrix: ScoreMatrix, limit = 10) {
  const entries: { home: number; away: number; probability: number; score: string }[] = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      entries.push({ home: h, away: a, probability: matrix[h][a], score: `${h}-${a}` });
    }
  }
  return entries.sort((x, y) => y.probability - x.probability).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Utilitaires statistiques
// ---------------------------------------------------------------------------

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Convergence d'une estimation vers une valeur a priori en fonction de la
 * taille d'échantillon. Indispensable pour ne pas surréagir sur 2 matchs :
 * `shrink(value, prior, n, k)` → poids de la donnée = n / (n + k).
 */
export function shrink(value: number, prior: number, n: number, k: number): number {
  const w = n / (n + k);
  return value * w + prior * (1 - w);
}

/** Moyenne pondérée par récence — les matchs récents pèsent davantage. */
export function recencyWeightedMean(values: number[], halfLifeMatches = 6): number | null {
  if (values.length === 0) return null;
  const lambda = Math.LN2 / halfLifeMatches;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    const w = Math.exp(-lambda * i); // i = 0 → match le plus récent
    num += w * v;
    den += w;
  });
  return num / den;
}

/** Entropie normalisée d'une distribution discrète (0 = certain, 1 = uniforme). */
export function normalizedEntropy(probs: number[]): number {
  const clean = probs.filter((p) => p > 0);
  if (clean.length <= 1) return 0;
  const h = -clean.reduce((acc, p) => acc + p * Math.log(p), 0);
  return h / Math.log(clean.length);
}

/** Divergence de Jensen–Shannon entre deux distributions (0 = identiques). */
export function jensenShannon(p: number[], q: number[]): number {
  const m = p.map((v, i) => (v + q[i]) / 2);
  const kl = (a: number[], b: number[]) =>
    a.reduce((acc, v, i) => (v > 0 && b[i] > 0 ? acc + v * Math.log(v / b[i]) : acc), 0);
  return Math.sqrt(Math.max(0, (kl(p, m) + kl(q, m)) / 2));
}
