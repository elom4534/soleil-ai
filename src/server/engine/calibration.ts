/**
 * ============================================================================
 * SOLEIL — Recalibration 1X2 (Mission 26 · calibrateur vectoriel Phase 12)
 * ============================================================================
 *
 * Historique : l'audit de calibration (Mission 25, 2 378 + 1 637 observations
 * appariées, 0 fuite) a établi une sous-confiance systématique des favoris
 * domicile 50-70 % (prédit 0,55-0,67 → observé 0,63-0,88) et une légère
 * surestimation des outsiders extérieurs 10-40 %. La décision C de la Mission
 * 25 a validé une recalibration future ; la présente mission l'implémente.
 *
 * Méthode (§21 M25) : calibrateur vectoriel — déjà en repo (Phase 12,
 * `scripts/backtest/calibration.ts`), déterministe et explicable :
 *
 *      q_i ∝ p_i^(1/T) · c_i        (i ∈ {domicile, nul, extérieur})
 *
 *  - T = 0.79  : expansion des extrêmes (le shrinkage du consensus moyenne
 *                les 6 modèles et comprimait les probabilités vers le centre).
 *  - c = [1, 1.04, 0.86] : c_domicile fixé à 1 pour l'identifiabilité ;
 *    léger rééquilibrage nul / extérieur (le biais était directionnel, une
 *    température seule ne peut pas le corriger).
 *
 * Provenance des paramètres (traçabilité §22) :
 *  - AJUSTEMENT : série A (Mission 26) — 1 378 matchs FINISHED sur 0-270 j,
 *    probabilités publiées `matrix` du moteur `1.0.0-matrix-ensemble`,
 *    minimisation du log loss multiclasse (recherche sur grille + descente
 *    par coordonnées, déterministe — `fitVector`, Phase 12).
 *  - VALIDATION : série B (hold-out temporel 270-600 j, n=1 637, jamais vue
 *    par le fit) : log loss 1,0083→1,0015 · Brier 0,6026→0,5980 ·
 *    RPS 0,2094→0,2071 · ECE 0,049→0,021 · Hosmer-Lemeshow p<0,0001→0,18
 *    (non rejeté) · gap favoris domicile 50-60 % : −8,3→+0,2 pts.
 *  - AUCUNE observation de B n'est utilisée pour l'ajustement.
 *
 * Garanties structurelles :
 *  - Somme exacte à 1 (renormalisation), positivité, déterminisme strict.
 *  - Monotonie : la calibration ne peut pas inverser l'ordre des probabilités
 *    d'une même classe (fonction croissante de p_i pour T > 0, c_i > 0).
 *  - Neutre par construction : T = 1 et c = [1, 1, 1] rendent la fonction
 *    identique (rollback = neutraliser ces paramètres, sans autre changement).
 *  - Les autres marchés (O/U, BTTS, score exact, mi-temps) restent dérivés de
 *    la matrice brute : seul le 1X2 publié est recalibré.
 *
 * Rollback : revenir à `1.0.0-matrix-ensemble` (PREDICTOR_VERSION) ou poser
 * CALIBRATOR = { t: 1, c: [1, 1, 1] }. Aucune donnée n'est modifiée ; les
 * prédictions SETTLED ne sont jamais recalculées (règle M17).
 */

import type { OutcomeProbabilities } from "./types";

/** Version du calibrateur — incluse dans PREDICTOR_VERSION ("1.0.1-calibrated"). */
export const CALIBRATION_VERSION = "1.0.1-calibrated";

export const CALIBRATOR = {
  kind: "vector" as const,
  /** Température : < 1 étire les extrêmes, > 1 les comprime. */
  t: 0.79,
  /** Coefficients par classe (domicile fixé à 1 — identifiabilité). */
  c: { home: 1, draw: 1.04, away: 0.86 },
};

const EPS = 1e-9;

/**
 * Applique la calibration vectorielle au 1X2 publié : q_i ∝ p_i^(1/T) · c_i,
 * renormalisé. Fonction pure, déterministe, somme exactement 1.
 */
export function calibrateOneXTwo(p: OutcomeProbabilities): OutcomeProbabilities {
  const { t, c } = CALIBRATOR;
  const safeT = t > 0 ? t : 1;
  const raw = [
    Math.pow(Math.max(p.home, EPS), 1 / safeT) * c.home,
    Math.pow(Math.max(p.draw, EPS), 1 / safeT) * c.draw,
    Math.pow(Math.max(p.away, EPS), 1 / safeT) * c.away,
  ];
  const total = raw[0] + raw[1] + raw[2];
  if (!Number.isFinite(total) || total <= 0) {
    return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  }
  return { home: raw[0] / total, draw: raw[1] / total, away: raw[2] / total };
}
