/**
 * ============================================================================
 * SOLEIL — Contrôle de cohérence des marchés affichés (§6 Phase 14)
 * ============================================================================
 * La distribution des scores est la source commune de tous les marchés.
 * L'interface ne doit jamais afficher de probabilités qui la contredisent.
 *
 * Ce module **détecte** les incohérences. Il ne corrige RIEN : la consigne
 * §6 interdit explicitement de rattraper une valeur en JavaScript côté
 * frontend. Une incohérence se signale et se corrige à la source, jamais
 * à l'affichage.
 *
 * Il est utilisé à deux endroits :
 *   • par les tests automatisés (avant tout affichage) ;
 *   • par la fiche match, pour signaler honnêtement un écart résiduel connu.
 */

import type { PredictionView } from "@/server/predictions/presenter";

/**
 * Tolérance sur les identités algébriques exactes (somme d'une distribution
 * complète, complément Over/Under). Les valeurs viennent de calculs flottants :
 * l'écart observé est de l'ordre de 1e-16.
 */
export const EXACT_TOLERANCE = 1e-9;

/**
 * Tolérance sur les relations *dérivées* entre marchés distincts (par exemple
 * un score exact face à la distribution des buts). Ces relations traversent
 * plusieurs arrondis et ne sont pas des identités strictes.
 */
export const DERIVED_TOLERANCE = 1e-4;

export type CoherenceSeverity = "critical" | "warning" | "info";

export interface CoherenceViolation {
  /** Code technique stable — utilisable dans un test. */
  code: string;
  severity: CoherenceSeverity;
  label: string;
  detail: string;
  /** Écart mesuré, en points de probabilité quand il est comparable. */
  deviation: number;
}

export interface CoherenceReport {
  /** Vrai si aucune violation `critical` n'a été trouvée. */
  ok: boolean;
  /** Nombre de marchés vérifiés. */
  checked: number;
  /** Écart maximal observé sur les identités exactes. */
  maxDeviation: number;
  critical: CoherenceViolation[];
  warnings: CoherenceViolation[];
  infos: CoherenceViolation[];
  violations: CoherenceViolation[];
}

const empty = (): CoherenceReport => ({
  ok: true,
  checked: 0,
  maxDeviation: 0,
  critical: [],
  warnings: [],
  infos: [],
  violations: [],
});

/* -------------------------------------------------------------------------- */
/* Vérifications élémentaires                                                  */
/* -------------------------------------------------------------------------- */

/** Somme des probabilités 1X2 — doit valoir exactement 1. */
function checkOutcomes(view: PredictionView, report: CoherenceReport) {
  const { home, draw, away } = view.outcomes;
  const total = home + draw + away;
  report.checked += 1;
  report.maxDeviation = Math.max(report.maxDeviation, Math.abs(total - 1));
  if (Math.abs(total - 1) > EXACT_TOLERANCE) {
    report.critical.push({
      code: "outcomes.sum",
      severity: "critical",
      label: "Somme 1X2 ≠ 100 %",
      detail: `P(1) + P(X) + P(2) = ${(total * 100).toFixed(4)} %`,
      deviation: total - 1,
    });
  }
}

/** Pour chaque ligne : Over + Under — doit valoir exactement 1. */
function checkTotalGoals(view: PredictionView, report: CoherenceReport) {
  for (const line of view.totalGoals) {
    const total = line.over + line.under;
    report.checked += 1;
    report.maxDeviation = Math.max(report.maxDeviation, Math.abs(total - 1));
    if (Math.abs(total - 1) > EXACT_TOLERANCE) {
      report.critical.push({
        code: `totalGoals.${line.line}.sum`,
        severity: "critical",
        label: `Over + Under ≠ 100 % (ligne ${line.line})`,
        detail: `${(line.over * 100).toFixed(4)} % + ${(line.under * 100).toFixed(4)} % = ${(total * 100).toFixed(4)} %`,
        deviation: total - 1,
      });
    }
  }
}

/** BTTS Oui + Non — doit valoir exactement 1. */
function checkBtts(view: PredictionView, report: CoherenceReport) {
  const total = view.btts.yes + view.btts.no;
  report.checked += 1;
  report.maxDeviation = Math.max(report.maxDeviation, Math.abs(total - 1));
  if (Math.abs(total - 1) > EXACT_TOLERANCE) {
    report.critical.push({
      code: "btts.sum",
      severity: "critical",
      label: "BTTS Oui + Non ≠ 100 %",
      detail: `${(view.btts.yes * 100).toFixed(4)} % + ${(view.btts.no * 100).toFixed(4)} % = ${(total * 100).toFixed(4)} %`,
      deviation: total - 1,
    });
  }
}

/** Marchés par équipe : distribution, lignes Over/Under, cohérence des totaux. */
function checkTeamGoals(view: PredictionView, report: CoherenceReport) {
  for (const team of view.teamGoals) {
    const label = team.side === "home" ? "domicile" : "extérieur";

    // La distribution d'une équipe doit sommer à 1.
    const mass = team.distribution.reduce((a, b) => a + b, 0);
    report.checked += 1;
    report.maxDeviation = Math.max(report.maxDeviation, Math.abs(mass - 1));
    if (Math.abs(mass - 1) > EXACT_TOLERANCE) {
      report.critical.push({
        code: `teamGoals.${team.side}.mass`,
        severity: "critical",
        label: `Distribution de buts incohérente (${label})`,
        detail: `La somme des probabilités vaut ${(mass * 100).toFixed(4)} %`,
        deviation: mass - 1,
      });
    }

    for (const line of team.overUnder) {
      const total = line.over + line.under;
      report.checked += 1;
      report.maxDeviation = Math.max(report.maxDeviation, Math.abs(total - 1));
      if (Math.abs(total - 1) > EXACT_TOLERANCE) {
        report.critical.push({
          code: `teamGoals.${team.side}.${line.line}.sum`,
          severity: "critical",
          label: `Over + Under ≠ 100 % (${label}, ligne ${line.line})`,
          detail: `${(line.over * 100).toFixed(4)} % + ${(line.under * 100).toFixed(4)} % = ${(total * 100).toFixed(4)} %`,
          deviation: total - 1,
        });
      }
    }

    // La probabilité « 0 but » doit correspondre à la première case, et
    // « Over 0,5 » à son complément — les deux décrivent le même événement.
    const zeroGoals = team.distribution[0];
    const over05 = team.overUnder.find((l) => l.line === 0.5);
    if (zeroGoals !== undefined && over05) {
      const deviation = Math.abs(1 - zeroGoals - over05.over);
      report.checked += 1;
      if (deviation > DERIVED_TOLERANCE) {
        report.warnings.push({
          code: `teamGoals.${team.side}.over05_vs_zero`,
          severity: "warning",
          label: `Over 0,5 incohérent avec P(0 but) (${label})`,
          detail: `1 − P(0 but) = ${((1 - zeroGoals) * 100).toFixed(3)} % contre ${(over05.over * 100).toFixed(3)} %`,
          deviation,
        });
      }
    }
  }

  // Buts attendus : la somme des deux équipes doit égaler le total annoncé.
  const home = view.teamGoals.find((t) => t.side === "home");
  const away = view.teamGoals.find((t) => t.side === "away");
  if (home && away && view.expectedGoals.total > 0) {
    const sum = home.expectedGoals + away.expectedGoals;
    const deviation = Math.abs(sum - view.expectedGoals.total);
    report.checked += 1;
    if (deviation > DERIVED_TOLERANCE) {
      report.warnings.push({
        code: "teamGoals.expected_sum",
        severity: "warning",
        label: "Total de buts attendus incohérent",
        detail: `Σ équipes = ${sum.toFixed(4)} contre ${view.expectedGoals.total.toFixed(4)} annoncé`,
        deviation,
      });
    }
  }
}

/** Scores exacts : cohérence avec la distribution centrale des buts. */
function checkExactScore(view: PredictionView, report: CoherenceReport) {
  const top = view.exactScore.top ?? [];
  if (top.length === 0) return;

  // 1 — Le score « le plus probable » doit être le premier du classement.
  const first = top[0];
  if (first && view.exactScore.mostLikely.score !== first.score) {
    report.critical.push({
      code: "exactScore.mostLikely",
      severity: "critical",
      label: "Score le plus probable incohérent",
      detail: `« ${view.exactScore.mostLikely.score} » annoncé alors que le classement commence par « ${first.score} »`,
      deviation: 0,
    });
  }

  // 2 — Le classement doit être décroissant.
  for (let i = 1; i < top.length; i += 1) {
    if (top[i]!.probability > top[i - 1]!.probability + DERIVED_TOLERANCE) {
      report.critical.push({
        code: "exactScore.order",
        severity: "critical",
        label: "Classement des scores non décroissant",
        detail: `${top[i]!.score} (${(top[i]!.probability * 100).toFixed(2)} %) placé après ${top[i - 1]!.score} (${(top[i - 1]!.probability * 100).toFixed(2)} %)`,
        deviation: top[i]!.probability - top[i - 1]!.probability,
      });
    }
  }

  // 3 — Aucun score ne peut être plus probable que le total de buts
  //     correspondant dans la distribution centrale.
  const goalsMass = new Map<number, number>();
  for (const entry of view.goalsDistribution) {
    goalsMass.set(entry.goals, entry.probability);
  }
  let checkedAgainstDistribution = 0;
  for (const score of top) {
    const totalGoals = score.home + score.away;
    const reference = goalsMass.get(totalGoals) ?? goalsMass.get(-1);
    if (reference === undefined) continue;
    checkedAgainstDistribution += 1;
    const deviation = score.probability - reference;
    if (deviation > DERIVED_TOLERANCE) {
      report.critical.push({
        code: `exactScore.${score.score}.vs_total`,
        severity: "critical",
        label: `Score ${score.score} incompatible avec la distribution`,
        detail: `P(score) = ${(score.probability * 100).toFixed(3)} % mais P(${totalGoals} buts) = ${(reference * 100).toFixed(3)} %`,
        deviation,
      });
    }
  }
  report.checked += checkedAgainstDistribution;

  // 4 — Le classement est un extrait : sa masse ne peut pas dépasser 100 %.
  const topMass = top.reduce((a, s) => a + s.probability, 0);
  report.checked += 1;
  if (topMass > 1 + DERIVED_TOLERANCE) {
    report.critical.push({
      code: "exactScore.mass",
      severity: "critical",
      label: "Masse des scores exacts > 100 %",
      detail: `Somme des scores affichés = ${(topMass * 100).toFixed(3)} %`,
      deviation: topMass - 1,
    });
  }
}

/** Cohérence entre le 1X2 du consensus et celui de la distribution de scores. */
function checkConsensusVsMatrix(view: PredictionView, report: CoherenceReport) {
  // Reconstruit P(1)/P(X)/P(2) à partir de la distribution des buts par équipe
  // lorsque celle-ci est disponible (produit des deux marges).
  const home = view.teamGoals.find((t) => t.side === "home");
  const away = view.teamGoals.find((t) => t.side === "away");
  if (!home || !away || home.distribution.length === 0 || away.distribution.length === 0) return;

  let p1 = 0;
  let px = 0;
  let p2 = 0;
  for (let h = 0; h < home.distribution.length; h += 1) {
    for (let a = 0; a < away.distribution.length; a += 1) {
      const p = home.distribution[h]! * away.distribution[a]!;
      if (h > a) p1 += p;
      else if (h === a) px += p;
      else p2 += p;
    }
  }

  // Les marchés par équipe proviennent de la matrice des scores ; le 1X2 publié
  // provient du consensus pondéré des modèles. Les deux chemins peuvent
  // légitimement différer : c'est un écart connu, mesuré en Phase 13.
  const deviations = [Math.abs(p1 - view.outcomes.home), Math.abs(px - view.outcomes.draw), Math.abs(p2 - view.outcomes.away)];
  const maxDeviation = Math.max(...deviations);
  report.checked += 1;
  if (maxDeviation > 0.005) {
    report.infos.push({
      code: "outcomes.vs_matrix",
      severity: "info",
      label: "Écart connu entre le 1X2 publié et la distribution de scores",
      detail:
        `Écart maximal de ${(maxDeviation * 100).toFixed(2)} points. Le 1X2 publié est la moyenne ` +
        `pondérée des modèles ; les marchés de buts proviennent de la distribution des scores. ` +
        `Écart documenté en Phase 13, non corrigé à l'affichage.`,
      deviation: maxDeviation,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Contrôle complet d'une prédiction avant affichage.
 * Ne modifie jamais la vue reçue.
 */
export function checkPredictionView(view: PredictionView | null): CoherenceReport {
  const report = empty();
  if (!view) return report;

  checkOutcomes(view, report);
  checkTotalGoals(view, report);
  checkBtts(view, report);
  checkTeamGoals(view, report);
  checkExactScore(view, report);
  checkConsensusVsMatrix(view, report);

  report.ok = report.critical.length === 0;
  report.violations = [...report.critical, ...report.warnings, ...report.infos];
  return report;
}
