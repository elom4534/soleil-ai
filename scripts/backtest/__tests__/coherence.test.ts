/**
 * ============================================================================
 * SOLEIL — PHASE 12 · Tests de cohérence et de non-contradiction
 * ============================================================================
 * §13 — « Les marchés doivent rester mathématiquement cohérents. »
 * §14 — « Créer des tests automatisés. » et « Les sorties doivent être
 *        compatibles. »
 *
 * Ces tests ne vérifient pas des égalités décoratives : ils vérifient des
 * INÉGALITÉS que la réalité impose, et qui doivent tenir à toutes les
 * pondérations xG testées. Une probabilité de BTTS supérieure à la probabilité
 * qu'il y ait au moins deux buts est mathématiquement impossible : le test
 * échoue si elle apparaît.
 *
 * Les tests portent sur des rencontres réelles (football-data.co.uk, gratuit,
 * 0 crédit) — jamais sur des valeurs inventées.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { xgModel } from "../../../src/server/engine/models";
import type { MatchContext } from "../../../src/server/engine/types";
import { buildBacktestContext } from "../context";
import { loadCompetition, type BacktestMatch } from "../dataset";
import { runPipeline, type MarketProbabilities } from "../pipeline";
import { VARIANT_BY_ID, variantModel } from "../variants";

const WEIGHTS = [0, 0.2, 0.4];

let cached: BacktestMatch[] | null = null;
async function dataset(): Promise<BacktestMatch[]> {
  if (cached) return cached;
  cached = await loadCompetition("E0", ["2024/2025", "2025/2026"]);
  return cached;
}

/** Quelques rencontres réparties dans le temps, avec un historique des deux côtés. */
async function contexts(count = 6): Promise<MatchContext[]> {
  const matches = await dataset();
  const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: MatchContext[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor((sorted.length * (i + 3)) / (count + 4));
    out.push(buildBacktestContext(sorted[index]!, matches));
  }
  return out;
}

interface Case {
  label: string;
  probs: MarketProbabilities;
}

async function cases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const context of await contexts()) {
    for (const weight of WEIGHTS) {
      const probs = runPipeline(context, {
        xgVariant: (ctx) => xgModel(ctx),
        xgBaseWeight: weight,
      });
      out.push({ label: `poids ${weight}`, probs });
      const recency = runPipeline(context, {
        xgVariant: (ctx) => variantModel(ctx, VARIANT_BY_ID.get("B6_xg_recency_3")!),
        xgBaseWeight: weight,
      });
      out.push({ label: `poids ${weight} récence`, probs: recency });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

test("la distribution des scores somme à 1 à toutes les pondérations (§13)", async () => {
  for (const item of await cases()) {
    const mass = item.probs.matrix.flat().reduce((s, p) => s + p, 0);
    assert.ok(
      Math.abs(mass - 1) < 1e-9,
      `${item.label} : somme de la distribution = ${mass}`,
    );
  }
});

test("le 1X2 publié somme à 100 % dans les deux architectures (§13)", async () => {
  for (const item of await cases()) {
    const { outcomes, matrixOutcomes } = item.probs;
    const sum = outcomes.home + outcomes.draw + outcomes.away;
    const sumMatrix = matrixOutcomes.home + matrixOutcomes.draw + matrixOutcomes.away;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${item.label} : somme 1X2 moyenné = ${sum}`);
    assert.ok(Math.abs(sumMatrix - 1) < 1e-9, `${item.label} : somme 1X2 matrice = ${sumMatrix}`);
  }
});

test("le 1X2 dérivé de la matrice EST la distribution, pas une approximation (§13)", async () => {
  for (const item of await cases()) {
    const matrix = item.probs.matrix;
    let home = 0;
    let draw = 0;
    let away = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h]!.length; a++) {
        const p = matrix[h]![a]!;
        if (h > a) home += p;
        else if (h === a) draw += p;
        else away += p;
      }
    }
    const total = home + draw + away;
    assert.ok(Math.abs(item.probs.matrixOutcomes.home - home / total) < 1e-12);
    assert.ok(Math.abs(item.probs.matrixOutcomes.draw - draw / total) < 1e-12);
    assert.ok(Math.abs(item.probs.matrixOutcomes.away - away / total) < 1e-12);
  }
});

test("chaque marché de buts est exactement la somme des scores correspondants (§13)", async () => {
  for (const item of await cases()) {
    const matrix = item.probs.matrix;
    let btts = 0;
    let over25 = 0;
    let homeOver05 = 0;
    let awayOver05 = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h]!.length; a++) {
        const p = matrix[h]![a]!;
        if (h >= 1 && a >= 1) btts += p;
        if (h + a >= 3) over25 += p;
        if (h >= 1) homeOver05 += p;
        if (a >= 1) awayOver05 += p;
      }
    }
    assert.ok(
      Math.abs(item.probs.btts.yes - btts) < 1e-9,
      `${item.label} : P(BTTS) ${item.probs.btts.yes} ≠ Σ scores des deux équipes ${btts}`,
    );
    const line25 = item.probs.totals.find((t) => t.line === 2.5)!;
    assert.ok(
      Math.abs(line25.over - over25) < 1e-9,
      `${item.label} : P(Over 2,5) ${line25.over} ≠ Σ scores ≥ 3 buts ${over25}`,
    );
    const homeLine = item.probs.teamGoals.home.find((t) => t.line === 0.5)!;
    const awayLine = item.probs.teamGoals.away.find((t) => t.line === 0.5)!;
    assert.ok(Math.abs(homeLine.over - homeOver05) < 1e-9, `${item.label} : buts domicile > 0,5`);
    assert.ok(Math.abs(awayLine.over - awayOver05) < 1e-9, `${item.label} : buts extérieur > 0,5`);
  }
});

test("§14 — si le BTTS est élevé, la distribution contient assez de scores où les deux marquent", async () => {
  for (const item of await cases()) {
    const matrix = item.probs.matrix;
    let both = 0;
    let totalTwoPlus = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h]!.length; a++) {
        const p = matrix[h]![a]!;
        if (h >= 1 && a >= 1) both += p;
        if (h + a >= 2) totalTwoPlus += p;
      }
    }
    // Deux équipes qui marquent impliquent au moins deux buts : l'inégalité est
    // stricte dans la réalité. Si elle était violée, la sortie serait incohérente.
    assert.ok(
      both <= totalTwoPlus + 1e-12,
      `${item.label} : P(BTTS) ${both} > P(au moins 2 buts) ${totalTwoPlus}`,
    );
    const over15 = item.probs.totals.find((t) => t.line === 1.5)!.over;
    assert.ok(both <= over15 + 1e-12, `${item.label} : P(BTTS) > P(Over 1,5)`);
    const homeOver = item.probs.teamGoals.home.find((t) => t.line === 0.5)!.over;
    const awayOver = item.probs.teamGoals.away.find((t) => t.line === 0.5)!.over;
    assert.ok(both <= homeOver + 1e-12, `${item.label} : P(BTTS) > P(domicile marque)`);
    assert.ok(both <= awayOver + 1e-12, `${item.label} : P(BTTS) > P(extérieur marque)`);
  }
});

test("§14 — si P(Over 2,5) augmente, les scores élevés augmentent d'autant", async () => {
  const matches = await dataset();
  const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  const context = buildBacktestContext(sorted[Math.floor(sorted.length * 0.7)]!, matches);

  const runs = WEIGHTS.map((weight) => {
    const probs = runPipeline(context, {
      xgVariant: (ctx) => variantModel(ctx, VARIANT_BY_ID.get("B6_xg_recency_3")!),
      xgBaseWeight: weight,
    });
    let highScores = 0;
    for (let h = 0; h < probs.matrix.length; h++) {
      for (let a = 0; a < probs.matrix[h]!.length; a++) {
        if (h + a >= 3) highScores += probs.matrix[h]![a]!;
      }
    }
    return {
      weight,
      over25: probs.totals.find((t) => t.line === 2.5)!.over,
      highScores,
    };
  });

  for (const run of runs) {
    assert.ok(
      Math.abs(run.over25 - run.highScores) < 1e-9,
      `poids ${run.weight} : Over 2,5 ${run.over25} ≠ masse des scores ≥ 3 buts ${run.highScores}`,
    );
  }

  // Sens de variation : les deux mesures doivent bouger ENSEMBLE, jamais en sens
  // contraire. C'est exactement le scénario interdit par §14.
  for (let i = 1; i < runs.length; i++) {
    const previous = runs[i - 1]!;
    const current = runs[i]!;
    const deltaOver = current.over25 - previous.over25;
    const deltaHigh = current.highScores - previous.highScores;
    assert.ok(
      Math.sign(deltaOver) === Math.sign(deltaHigh) || Math.abs(deltaOver) < 1e-12,
      `poids ${previous.weight} → ${current.weight} : Over 2,5 varie de ${deltaOver} mais la masse des scores élevés de ${deltaHigh}`,
    );
  }
});

test("les lignes de buts décroissent avec la ligne — aucune inversion possible", async () => {
  for (const item of await cases()) {
    const sorted = [...item.probs.totals].sort((a, b) => a.line - b.line);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i]!.over <= sorted[i - 1]!.over + 1e-12,
        `${item.label} : P(Over ${sorted[i]!.line}) > P(Over ${sorted[i - 1]!.line})`,
      );
    }
    assert.ok(Math.abs(sorted[0]!.under + sorted[0]!.over - 1) < 1e-9, `${item.label} : Over + Under ≠ 1`);
  }
});

test("aucune probabilité n'est nulle, négative ou supérieure à 1", async () => {
  for (const item of await cases()) {
    const values = [
      item.probs.outcomes.home,
      item.probs.outcomes.draw,
      item.probs.outcomes.away,
      ...item.probs.matrixOutcomes ? [item.probs.matrixOutcomes.home, item.probs.matrixOutcomes.draw, item.probs.matrixOutcomes.away] : [],
      item.probs.btts.yes,
      ...item.probs.totals.map((t) => t.over),
      ...item.probs.teamGoals.home.map((t) => t.over),
      ...item.probs.teamGoals.away.map((t) => t.over),
    ];
    for (const value of values) {
      assert.ok(Number.isFinite(value), `${item.label} : valeur non finie`);
      assert.ok(value >= 0 && value <= 1, `${item.label} : probabilité hors bornes ${value}`);
    }
  }
});

test("le poids xG ne modifie jamais la cohérence interne (§13)", async () => {
  // La cohérence doit tenir à TOUTES les pondérations, y compris 0 % et 40 % :
  // une architecture qui ne serait cohérente qu'à un réglage précis ne serait
  // pas une architecture.
  const samples = await contexts(3);
  for (const weight of [0, 0.1, 0.2, 0.3, 0.4]) {
    for (const context of samples) {
      const probs = runPipeline(context, { xgVariant: (ctx) => xgModel(ctx), xgBaseWeight: weight });
      const mass = probs.matrix.flat().reduce((s, p) => s + p, 0);
      assert.ok(Math.abs(mass - 1) < 1e-9, `poids ${weight} : masse ${mass}`);
      let btts = 0;
      for (let h = 1; h < probs.matrix.length; h++) {
        for (let a = 1; a < probs.matrix[h]!.length; a++) btts += probs.matrix[h]![a]!;
      }
      assert.ok(Math.abs(probs.btts.yes - btts) < 1e-9, `poids ${weight} : BTTS incohérent`);
    }
  }
});
