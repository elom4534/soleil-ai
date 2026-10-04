/**
 * ============================================================================
 * SOLEIL — PHASE 12 · Banc d'essai du consensus
 * ============================================================================
 * §1 — Le moteur de production n'est PAS modifié. Ce fichier est une copie
 * fidèle de `src/server/engine/ensemble.ts` dont une seule chose change : le
 * poids a priori du modèle xG devient un paramètre.
 *
 * Le test de fidélité `variants.test.ts` compare le pipeline au moteur réel :
 * si cette copie s'écartait du moteur, ce test tomberait. La copie est donc
 * surveillée, pas seulement écrite.
 *
 * Sémantique du balayage des poids (§5) :
 *   · poids 0  → le modèle xG est RETIRÉ de la liste, exactement comme un
 *     modèle inapplicable. C'est le Modèle A, reproduit à l'identique.
 *   · poids > 0 → il remplace le poids a priori 0,20 ; le plafond de 45 % et
 *     la pénalité de divergence continuent de s'appliquer normalement.
 *
 * Le poids effectif réellement obtenu est donc toujours MESURÉ et publié : il
 * diffère du poids demandé, car la confiance intrinsèque du modèle et son
 * accord avec la médiane le modulent.
 */

import { jensenShannon } from "../../src/server/engine/math";
import type { ModelPrediction, OutcomeProbabilities } from "../../src/server/engine/types";

/** Poids a priori identiques au moteur — copiés, jamais réinventés. */
export const LAB_BASE_WEIGHTS: Record<string, number> = {
  poisson: 0.28,
  statistical: 0.22,
  xg: 0.2,
  home_away: 0.18,
  form: 0.12,
  ml: 0.0,
  ensemble: 0.0,
};

const MAX_SINGLE_WEIGHT_SHARE = 0.45;

export interface LabOptions {
  /**
   * Poids a priori du modèle xG. `undefined` → 0,20 (moteur).
   * `0` → le modèle est retiré de la liste.
   */
  xgBaseWeight?: number;
}

export interface LabEnsembleResult {
  outcomes: OutcomeProbabilities;
  agreement: number;
  models: ModelPrediction[];
  activeModels: number;
}

function sum(a: number[]) {
  return a.reduce((x, y) => x + y, 0);
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

function computeAgreement(models: ModelPrediction[], consensus: OutcomeProbabilities): number {
  if (models.length <= 1) return models.length === 1 ? 0.62 : 0;
  const target = [consensus.home, consensus.draw, consensus.away];
  const divergences = models.map((m) =>
    jensenShannon([m.outcomes.home, m.outcomes.draw, m.outcomes.away], target),
  );
  const avg = sum(divergences) / divergences.length;
  return Math.max(0, Math.min(1, 1 - avg * 4));
}

/**
 * Consensus paramétré. Algorithme identique au moteur, à une exception :
 * le poids a priori du xG est fourni par l'appelant.
 */
export function runEnsembleLab(models: ModelPrediction[], options: LabOptions = {}): LabEnsembleResult {
  const xgBaseWeight = options.xgBaseWeight;

  // Poids nul xG = modèle écarté, et non « modèle présent mais muet » : sans
  // cela il influencerait encore la médiane et la pénalité de divergence des
  // autres modèles, et le Modèle A ne serait pas reproduit.
  const effectiveModels =
    xgBaseWeight === 0 ? models.filter((m) => m.name !== "xg") : models;

  const applicable = effectiveModels.filter((m) => m.applicable);

  if (applicable.length === 0) {
    const uniform = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    return {
      outcomes: uniform,
      agreement: 0,
      models: models.map((m) => ({ ...m, weight: 0 })),
      activeModels: 0,
    };
  }

  const median = componentWiseMedian(
    applicable.map((m) => [m.outcomes.home, m.outcomes.draw, m.outcomes.away]),
  );

  const rawWeights = new Map<string, number>();
  for (const m of applicable) {
    const base =
      m.name === "xg" && xgBaseWeight !== undefined
        ? xgBaseWeight
        : (LAB_BASE_WEIGHTS[m.name] ?? 0.1);
    const divergence = jensenShannon([m.outcomes.home, m.outcomes.draw, m.outcomes.away], median);
    const outlierFactor = Math.max(0.35, 1 - divergence * 1.86);
    rawWeights.set(m.name, base * m.selfConfidence * outlierFactor);
  }

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

  let home = 0;
  let draw = 0;
  let away = 0;
  const weighted: ModelPrediction[] = effectiveModels.map((m) => {
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

/** Copie conforme de `consensusLambdas` du moteur. */
export function consensusLambdasLab(
  models: ModelPrediction[],
): { home: number; away: number } | null {
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
