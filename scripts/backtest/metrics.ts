/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Métriques d'évaluation
 * ============================================================================
 * §10, §11, §14 — Brier, Log Loss, calibration. L'exactitude brute n'est
 * jamais un critère suffisant : une probabilité de 70 % qui se réalise 70 %
 * du temps vaut mieux qu'une probabilité de 95 % qui ne se réalise que 70 %.
 *
 * §14 — Le score exact n'est pas jugé sur un « taux de réussite » : une
 * distribution contient toujours le bon score. On mesure la Log Loss, la
 * probabilité moyenne du score réel, et les taux top-1 / top-3 / top-5.
 */

export interface BinaryObservation {
  /** Probabilité annoncée de l'événement. */
  p: number;
  /** L'événement s'est-il produit ? */
  y: 0 | 1;
}

export interface MulticlassObservation {
  /** Probabilités annoncées, dans l'ordre des classes. */
  p: number[];
  /** Index de la classe réalisée. */
  y: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  /** Probabilité moyenne annoncée dans la tranche. */
  predicted: number;
  /** Fréquence réellement observée dans la tranche. */
  observed: number;
}

export interface MarketMetrics {
  n: number;
  /** Score de Brier (plus bas = mieux). */
  brier: number;
  /** Log Loss (plus bas = mieux). */
  logLoss: number;
  /** Erreur de calibration attendue, en points de probabilité. */
  ece: number;
  bins: CalibrationBin[];
}

const EPS = 1e-12;

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return EPS;
  return Math.min(Math.max(p, EPS), 1 - EPS);
}

/** Répartition en tranches puis écart moyen |annoncé − observé| pondéré. */
export function calibrationBins(pairs: { p: number; y: number }[], binCount = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    const inBin = pairs.filter((x) => (i === binCount - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    if (inBin.length === 0) continue;
    bins.push({
      lo,
      hi,
      n: inBin.length,
      predicted: inBin.reduce((s, x) => s + x.p, 0) / inBin.length,
      observed: inBin.reduce((s, x) => s + x.y, 0) / inBin.length,
    });
  }
  return bins;
}

export function expectedCalibrationError(bins: CalibrationBin[], total: number): number {
  if (total === 0) return 0;
  return bins.reduce((acc, b) => acc + (b.n / total) * Math.abs(b.predicted - b.observed), 0);
}

/** Métriques d'un marché binaire (Over/Under, BTTS oui/non, etc.). */
export function binaryMetrics(observations: BinaryObservation[], binCount = 10): MarketMetrics {
  const n = observations.length;
  if (n === 0) return { n: 0, brier: 0, logLoss: 0, ece: 0, bins: [] };

  let brier = 0;
  let logLoss = 0;
  const pairs: { p: number; y: number }[] = [];
  for (const o of observations) {
    const p = clampProb(o.p);
    brier += (p - o.y) ** 2;
    logLoss += -(o.y === 1 ? Math.log(p) : Math.log(1 - p));
    pairs.push({ p, y: o.y });
  }
  const bins = calibrationBins(pairs, binCount);
  return {
    n,
    brier: brier / n,
    logLoss: logLoss / n,
    ece: expectedCalibrationError(bins, n),
    bins,
  };
}

/** Métriques d'un marché multiclasse (1X2). */
export function multiclassMetrics(observations: MulticlassObservation[], binCount = 10): MarketMetrics {
  const n = observations.length;
  if (n === 0) return { n: 0, brier: 0, logLoss: 0, ece: 0, bins: [] };

  let brier = 0;
  let logLoss = 0;
  const pairs: { p: number; y: number }[] = [];
  for (const o of observations) {
    const total = o.p.reduce((a, b) => a + b, 0) || 1;
    const probs = o.p.map((x) => clampProb(x / total));
    for (let c = 0; c < probs.length; c++) {
      brier += (probs[c]! - (c === o.y ? 1 : 0)) ** 2;
      pairs.push({ p: probs[c]!, y: c === o.y ? 1 : 0 });
    }
    logLoss += -Math.log(probs[o.y]!);
  }
  const bins = calibrationBins(pairs, binCount);
  return {
    n,
    // Brier multiclasse : moyenne par rencontre (pas par classe).
    brier: brier / n,
    logLoss: logLoss / n,
    ece: expectedCalibrationError(bins, n * 3),
    bins,
  };
}

/** Écart de Brier par rencontre, pour les intervalles de confiance appariés. */
export function multiclassBrierPerMatch(observations: MulticlassObservation[]): number[] {
  return observations.map((o) => {
    const total = o.p.reduce((a, b) => a + b, 0) || 1;
    const probs = o.p.map((x) => x / total);
    let score = 0;
    for (let c = 0; c < probs.length; c++) score += (probs[c]! - (c === o.y ? 1 : 0)) ** 2;
    return score;
  });
}

export function binaryBrierPerMatch(observations: BinaryObservation[]): number[] {
  return observations.map((o) => (clampProb(o.p) - o.y) ** 2);
}

// ---------------------------------------------------------------------------
// Score exact
// ---------------------------------------------------------------------------

export interface ExactScoreObservation {
  /** Matrice normalisée : probabilité de chaque score. */
  matrix: number[][];
  home: number;
  away: number;
}

export interface ExactScoreMetrics {
  n: number;
  logLoss: number;
  /** Probabilité moyenne annoncée au score réellement survenu. */
  meanProbabilityOfActual: number;
  /** Probabilité moyenne de la meilleure issue possible (référence). */
  meanTopProbability: number;
  top1: number;
  top3: number;
  top5: number;
  /** Somme des masses de la matrice — doit valoir 1 (§15). */
  meanMass: number;
}

export function exactScoreMetrics(observations: ExactScoreObservation[]): ExactScoreMetrics {
  const n = observations.length;
  if (n === 0) {
    return { n: 0, logLoss: 0, meanProbabilityOfActual: 0, meanTopProbability: 0, top1: 0, top3: 0, top5: 0, meanMass: 0 };
  }

  let logLoss = 0;
  let probActual = 0;
  let topProb = 0;
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let mass = 0;

  for (const o of observations) {
    const scores: { p: number; h: number; a: number }[] = [];
    let sum = 0;
    for (let h = 0; h < o.matrix.length; h++) {
      for (let a = 0; a < o.matrix[h]!.length; a++) {
        const p = o.matrix[h]![a]!;
        sum += p;
        scores.push({ p, h, a });
      }
    }
    mass += sum;
    scores.sort((x, y) => y.p - x.p);
    const cap = (v: number, limit: number) => Math.min(v, limit);
    const actual = scores.find((s) => s.h === cap(o.home, o.matrix.length - 1) && s.a === cap(o.away, o.matrix.length - 1));
    const pActual = actual ? actual.p / (sum || 1) : EPS;
    logLoss += -Math.log(clampProb(pActual));
    probActual += pActual;
    topProb += scores[0] ? scores[0]!.p / (sum || 1) : EPS;
    const rank = scores.findIndex((s) => s === actual) + 1;
    if (rank === 1) top1 += 1;
    if (rank >= 1 && rank <= 3) top3 += 1;
    if (rank >= 1 && rank <= 5) top5 += 1;
  }

  return {
    n,
    logLoss: logLoss / n,
    meanProbabilityOfActual: probActual / n,
    meanTopProbability: topProb / n,
    top1: top1 / n,
    top3: top3 / n,
    top5: top5 / n,
    meanMass: mass / n,
  };
}

// ---------------------------------------------------------------------------
// Robustesse (§13)
// ---------------------------------------------------------------------------

/** Générateur reproductible — même graine, mêmes intervalles (§22). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  /** Différence moyenne (modèle B − modèle A) : négative = B meilleur sur le Brier. */
  meanDifference: number;
  lower: number;
  upper: number;
  /** Proportion de rééchantillonnages où B fait mieux que A. */
  probabilityBetter: number;
  iterations: number;
}

/**
 * Intervalle de confiance apparié par rééchantillonnage.
 *
 * Les deux modèles sont évalués sur EXACTEMENT les mêmes rencontres : on
 * rééchantillonne donc les écarts par rencontre, ce qui élimine la variance
 * liée à la difficulté du match.
 */
export function pairedBootstrap(
  perMatchA: number[],
  perMatchB: number[],
  options: { iterations?: number; seed?: number } = {},
): BootstrapResult {
  const iterations = options.iterations ?? 2000;
  const seed = options.seed ?? 20260929;
  const n = Math.min(perMatchA.length, perMatchB.length);
  if (n === 0) {
    return { meanDifference: 0, lower: 0, upper: 0, probabilityBetter: 0, iterations };
  }

  const differences = new Array<number>(n);
  for (let i = 0; i < n; i++) differences[i] = perMatchB[i]! - perMatchA[i]!;

  const observed = differences.reduce((a, b) => a + b, 0) / n;
  const random = mulberry32(seed);
  const means = new Array<number>(iterations);
  let better = 0;

  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += differences[Math.floor(random() * n)]!;
    const mean = sum / n;
    means[it] = mean;
    if (mean < 0) better += 1;
  }

  means.sort((a, b) => a - b);
  return {
    meanDifference: observed,
    lower: means[Math.floor(0.025 * iterations)]!,
    upper: means[Math.floor(0.975 * iterations)]!,
    probabilityBetter: better / iterations,
    iterations,
  };
}

/** Score de compétence : gain relatif de Brier par rapport à une référence. */
export function brierSkillScore(modelBrier: number, referenceBrier: number): number {
  if (referenceBrier === 0) return 0;
  return 1 - modelBrier / referenceBrier;
}
