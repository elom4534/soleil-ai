/**
 * ============================================================================
 * SOLEIL — PHASE 12 · Calibration multiclasse
 * ============================================================================
 * §7 — Comparer les probabilités brutes et les probabilités calibrées.
 * §8 — Aucune sur-optimisation : l'ajustement se fait sur des données
 *      ANTÉRIEURES et la mesure sur des données POSTÉRIEURES (validation
 *      temporelle), jamais sur un tirage aléatoire.
 *
 * Deux calibrateurs, volontairement simples et explicables :
 *
 *   1. TEMPÉRATURE       q_i ∝ p_i^(1/T)
 *      Un seul paramètre. T > 1 adoucit (le modèle était trop confiant),
 *      T < 1 durcit. Ne peut pas casser l'ordre des probabilités.
 *
 *   2. VECTEUR           q_i ∝ p_i^(1/T) · c_i
 *      Ajoute trois coefficients par classe. Corrige un biais propre à une
 *      issue — par exemple un nul systématiquement sous-estimé. Identifiabilité
 *      assurée en fixant c_domicile = 1.
 *
 * Aucune méthode « boîte noire » : les paramètres ajustés sont publiés, et
 * l'effet sur la probabilité du nul est mesuré séparément (§9).
 */

export interface CalibrationObservation {
  /** Probabilités brutes, dans l'ordre domicile / nul / extérieur. */
  p: number[];
  /** Issue réalisée : 0 domicile, 1 nul, 2 extérieur. */
  y: number;
}

export const EPS = 1e-9;

function normalise(p: number[]): number[] {
  const total = p.reduce((s, v) => s + Math.max(v, EPS), 0);
  if (!Number.isFinite(total) || total <= 0) return p.map(() => 1 / p.length);
  return p.map((v) => Math.max(v, EPS) / total);
}

export function multiclassLogLoss(observations: CalibrationObservation[]): number {
  if (observations.length === 0) return 0;
  let total = 0;
  for (const o of observations) {
    total += -Math.log(Math.max(o.p[o.y] ?? EPS, EPS));
  }
  return total / observations.length;
}

export function multiclassBrier(observations: CalibrationObservation[]): number {
  if (observations.length === 0) return 0;
  let total = 0;
  for (const o of observations) {
    for (let i = 0; i < o.p.length; i++) {
      total += (o.p[i]! - (i === o.y ? 1 : 0)) ** 2;
    }
  }
  return total / observations.length;
}

/** Brier d'une seule classe : mesure la qualité de « cette issue précisément ». */
export function perClassBrier(
  observations: CalibrationObservation[],
  index: number,
): number {
  if (observations.length === 0) return 0;
  let total = 0;
  for (const o of observations) {
    total += (o.p[index]! - (o.y === index ? 1 : 0)) ** 2;
  }
  return total / observations.length;
}

export function temperatureApply(p: number[], t: number): number[] {
  const safeT = t > 0 ? t : 1;
  return normalise(p.map((v) => Math.pow(Math.max(v, EPS), 1 / safeT)));
}

export function vectorApply(p: number[], t: number, c: number[]): number[] {
  const safeT = t > 0 ? t : 1;
  return normalise(p.map((v, i) => Math.pow(Math.max(v, EPS), 1 / safeT) * (c[i] ?? 1)));
}

export interface FittedCalibrator {
  kind: "temperature" | "vector";
  t: number;
  c: number[];
  /** Log Loss sur le jeu d'AJUSTEMENT — jamais sur le jeu de validation. */
  fitLogLoss: number;
  fitBrier: number;
  grid: { t: number; logLoss: number }[];
}

/** Température ajustée par recherche sur grille — déterministe. */
export function fitTemperature(
  observations: CalibrationObservation[],
  options: { min?: number; max?: number; step?: number } = {},
): FittedCalibrator {
  const min = options.min ?? 0.4;
  const max = options.max ?? 3;
  const step = options.step ?? 0.01;
  const grid: { t: number; logLoss: number }[] = [];
  let best = { t: 1, logLoss: Number.POSITIVE_INFINITY };
  for (let t = min; t <= max + 1e-9; t += step) {
    const rounded = Math.round(t * 1000) / 1000;
    const loss = multiclassLogLoss(
      observations.map((o) => ({ p: temperatureApply(o.p, rounded), y: o.y })),
    );
    grid.push({ t: rounded, logLoss: loss });
    if (loss < best.logLoss) best = { t: rounded, logLoss: loss };
  }
  const fitted = observations.map((o) => ({ p: temperatureApply(o.p, best.t), y: o.y }));
  return {
    kind: "temperature",
    t: best.t,
    c: [1, 1, 1],
    fitLogLoss: best.logLoss,
    fitBrier: multiclassBrier(fitted),
    grid,
  };
}

/**
 * Calibration vectorielle : descente par coordonnées, déterministe.
 * T est ajusté d'abord, puis chaque coefficient de classe à son tour.
 */
export function fitVector(
  observations: CalibrationObservation[],
  options: { rounds?: number; step?: number } = {},
): FittedCalibrator {
  const rounds = options.rounds ?? 3;
  const step = options.step ?? 0.02;
  const base = fitTemperature(observations);
  let t = base.t;
  let c = [1, 1, 1];

  const evaluate = (tt: number, cc: number[]) =>
    multiclassLogLoss(observations.map((o) => ({ p: vectorApply(o.p, tt, cc), y: o.y })));

  for (let round = 0; round < rounds; round++) {
    for (const index of [1, 2]) {
      let bestValue = c[index]!;
      let bestLoss = evaluate(t, c);
      for (let value = 0.5; value <= 2 + 1e-9; value += step) {
        const candidate = [...c];
        candidate[index] = Math.round(value * 1000) / 1000;
        const loss = evaluate(t, candidate);
        if (loss < bestLoss) {
          bestLoss = loss;
          bestValue = candidate[index]!;
        }
      }
      c = [...c.slice(0, index), bestValue, ...c.slice(index + 1)];
    }
    // Température réajustée après les coefficients de classe.
    let bestT = t;
    let bestLoss = evaluate(t, c);
    for (let value = 0.4; value <= 3 + 1e-9; value += 0.01) {
      const candidate = Math.round(value * 1000) / 1000;
      const loss = evaluate(candidate, c);
      if (loss < bestLoss) {
        bestLoss = loss;
        bestT = candidate;
      }
    }
    t = bestT;
    if (Math.abs(step) < 1e-9) break;
  }

  const fitted = observations.map((o) => ({ p: vectorApply(o.p, t, c), y: o.y }));
  return {
    kind: "vector",
    t,
    c,
    fitLogLoss: multiclassLogLoss(fitted),
    fitBrier: multiclassBrier(fitted),
    grid: base.grid,
  };
}
