/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Consensus (multi-modèle)
 * ============================================================================
 * Combine les modèles selon leur fiabilité observée ET leur applicabilité.
 *
 * Principes (§14) :
 *  1. Un modèle inapplicable a un poids strictement nul.
 *  2. Le poids d'un modèle = poids de base × confiance intrinsèque × accord
 *     avec la médiane des autres modèles (détection d'outlier).
 *  3. Aucun modèle ne peut dépasser 45 % du poids total : cela empêche qu'un
 *     indicateur unique domine artificiellement la prédiction.
 */

import { jensenShannon } from "./math";
import type { ModelPrediction, OutcomeProbabilities } from "./types";

/** Poids a priori par modèle, calibrés sur la littérature football. */
export const BASE_WEIGHTS: Record<string, number> = {
  poisson: 0.28,
  statistical: 0.22,
  xg: 0.2,
  // Mission 23 — qualité de tir (tirs cadrés) : complément du modèle xg pour
  // les compétitions sans xG. Poids de base modeste, plafond de 45 % par
  // modèle inchangé. Valeur prouvée avant ajout : corr(SOT, buts) ≈ 0,58.
  shots: 0.12,
  home_away: 0.18,
  form: 0.12,
  ml: 0.0,
  ensemble: 0.0,
};

/** Part maximale du poids total attribuable à un seul modèle. */
const MAX_SINGLE_WEIGHT_SHARE = 0.45;

export interface EnsembleResult {
  outcomes: OutcomeProbabilities;
  /** Accord global : 1 = unanimité, 0 = divergence maximale. */
  agreement: number;
  models: ModelPrediction[];
  /** Nombre de modèles effectivement appliqués. */
  activeModels: number;
}

export function runEnsemble(models: ModelPrediction[]): EnsembleResult {
  const applicable = models.filter((m) => m.applicable);

  if (applicable.length === 0) {
    const uniform = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    return {
      outcomes: uniform,
      agreement: 0,
      models: models.map((m) => ({ ...m, weight: 0 })),
      activeModels: 0,
    };
  }

  // 1 — Médiane robuste des distributions 1X2 des modèles applicables.
  const median = componentWiseMedian(
    applicable.map((m) => [m.outcomes.home, m.outcomes.draw, m.outcomes.away]),
  );

  // 2 — Poids = base × confiance intrinsèque × pénalité de divergence.
  const rawWeights = new Map<string, number>();
  for (const m of applicable) {
    const base = BASE_WEIGHTS[m.name] ?? 0.1;
    const divergence = jensenShannon([m.outcomes.home, m.outcomes.draw, m.outcomes.away], median);
    // divergence ~0 → facteur 1 ; divergence ≥ 0.35 → facteur 0.35
    const outlierFactor = Math.max(0.35, 1 - divergence * 1.86);
    rawWeights.set(m.name, base * m.selfConfidence * outlierFactor);
  }

  // 3 — Plafonnement : aucun modèle > 45 % du total.
  const totalRaw = sum([...rawWeights.values()]);
  if (totalRaw > 0) {
    for (const [name, w] of rawWeights) {
      const share = w / totalRaw;
      if (share > MAX_SINGLE_WEIGHT_SHARE) {
        rawWeights.set(name, (MAX_SINGLE_WEIGHT_SHARE * totalRaw) / (1 - MAX_SINGLE_WEIGHT_SHARE));
      }
    }
  }

  const total = sum([...rawWeights.values()]) || 1;

  // 4 — Moyenne pondérée puis renormalisation.
  let home = 0;
  let draw = 0;
  let away = 0;
  const weighted: ModelPrediction[] = models.map((m) => {
    if (!m.applicable) return { ...m, weight: 0 };
    const weight = (rawWeights.get(m.name) ?? 0) / total;
    home += m.outcomes.home * weight;
    draw += m.outcomes.draw * weight;
    away += m.outcomes.away * weight;
    return { ...m, weight };
  });

  const norm = home + draw + away || 1;
  const outcomes = { home: home / norm, draw: draw / norm, away: away / norm };

  return {
    outcomes,
    agreement: computeAgreement(applicable, outcomes),
    models: weighted.sort((a, b) => b.weight - a.weight),
    activeModels: applicable.length,
  };
}

/**
 * Accord entre modèles : 1 − dispersion moyenne (Jensen–Shannon) par rapport
 * à la prédiction d'ensemble, normalisée sur une échelle 0-1.
 */
function computeAgreement(models: ModelPrediction[], consensus: OutcomeProbabilities): number {
  if (models.length <= 1) return models.length === 1 ? 0.62 : 0;
  const target = [consensus.home, consensus.draw, consensus.away];
  const divergences = models.map((m) =>
    jensenShannon([m.outcomes.home, m.outcomes.draw, m.outcomes.away], target),
  );
  const avg = sum(divergences) / divergences.length;
  // 0.0 → 1.00 · 0.05 → 0.80 · 0.10 → 0.60 · 0.20 → 0.20 · ≥0.25 → 0
  return Math.max(0, Math.min(1, 1 - avg * 4));
}

function componentWiseMedian(vectors: number[][]): number[] {
  const dims = vectors[0].length;
  const out: number[] = [];
  for (let d = 0; d < dims; d++) {
    const col = vectors.map((v) => v[d]).sort((a, b) => a - b);
    const mid = Math.floor(col.length / 2);
    out.push(col.length % 2 ? col[mid] : (col[mid - 1] + col[mid]) / 2);
  }
  const t = sum(out) || 1;
  return out.map((v) => v / t);
}

function sum(a: number[]) {
  return a.reduce((x, y) => x + y, 0);
}

/**
 * Reconstruit les intensités λ cohérentes avec les probabilités d'ensemble.
 *
 * Les modèles fournissent des λ ; on prend leur moyenne pondérée par les poids
 * de l'ensemble, en ignorant les modèles inapplicables. Si aucun λ n'est
 * disponible, on retombe sur l'inversion du modèle de Poisson.
 */
export function consensusLambdas(models: ModelPrediction[]): { home: number; away: number } | null {
  const withLambdas = models.filter((m) => m.applicable && m.expectedGoals && m.weight > 0);
  if (withLambdas.length === 0) return null;
  const totalWeight = sum(withLambdas.map((m) => m.weight));
  let home = 0;
  let away = 0;
  for (const m of withLambdas) {
    home += (m.expectedGoals!.home * m.weight) / totalWeight;
    away += (m.expectedGoals!.away * m.weight) / totalWeight;
  }
  return { home, away };
}
