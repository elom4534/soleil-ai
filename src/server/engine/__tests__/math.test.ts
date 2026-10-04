import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bivariatePoissonPmf,
  buildScoreMatrix,
  bttsProbability,
  dixonColesTau,
  fitDixonColesRho,
  normalizedEntropy,
  outcomeProbabilities,
  overUnderProbability,
  poissonCdf,
  poissonPmf,
  recencyWeightedMean,
  shrink,
  stdDev,
  teamGoalsDistribution,
} from "../math";

describe("Loi de Poisson", () => {
  it("respecte la définition P(X=k) = λ^k e^-λ / k!", () => {
    const lambda = 1.6;
    // Valeurs de référence calculées analytiquement.
    assert.ok(Math.abs(poissonPmf(0, lambda) - Math.exp(-lambda)) < 1e-12);
    assert.ok(Math.abs(poissonPmf(3, lambda) - (lambda ** 3 * Math.exp(-lambda)) / 6) < 1e-12);
  });

  it("somme à 1 sur un support large", () => {
    let total = 0;
    for (let k = 0; k <= 60; k++) total += poissonPmf(k, 2.7);
    assert.ok(Math.abs(total - 1) < 1e-9, `somme = ${total}`);
  });

  it("la fonction de répartition est croissante et bornée", () => {
    const cdf = [0, 1, 2, 3, 4, 5].map((k) => poissonCdf(k, 1.4));
    for (let i = 1; i < cdf.length; i++) assert.ok(cdf[i] >= cdf[i - 1]);
    assert.ok(cdf[cdf.length - 1] <= 1);
  });

  it("retourne 0 pour une probabilité négative", () => {
    assert.equal(poissonPmf(-1, 2), 0);
  });
});

describe("Correction de Dixon–Coles", () => {
  it("vaut 1 en dehors des scores faibles", () => {
    assert.equal(dixonColesTau(3, 2, 1.5, 1.1, -0.05), 1);
    assert.equal(dixonColesTau(2, 2, 1.5, 1.1, -0.05), 1);
  });

  it("implémente exactement les quatre facteurs de Dixon–Coles (1997)", () => {
    const lh = 1.4;
    const la = 1.1;
    const rho = -0.05;

    assert.ok(Math.abs(dixonColesTau(0, 0, lh, la, rho) - (1 - lh * la * rho)) < 1e-12);
    assert.ok(Math.abs(dixonColesTau(0, 1, lh, la, rho) - (1 + lh * rho)) < 1e-12);
    assert.ok(Math.abs(dixonColesTau(1, 0, lh, la, rho) - (1 + la * rho)) < 1e-12);
    assert.ok(Math.abs(dixonColesTau(1, 1, lh, la, rho) - (1 - rho)) < 1e-12);

    // Le signe de ρ détermine le sens de la correction sur chaque score serré.
    assert.ok(dixonColesTau(1, 1, lh, la, -0.05) > 1, "ρ < 0 renforce 1-1");
    assert.ok(dixonColesTau(1, 0, lh, la, -0.05) < 1, "ρ < 0 atténue 1-0");
  });

  it("l'ajustement de ρ maximise la vraisemblance observée", () => {
    // Historique volontairement riche en 1-1 : l'ajustement doit retenir un ρ
    // qui renforce ce score, et non une valeur arbitraire.
    const fixtures = Array.from({ length: 120 }, () => ({
      homeGoals: 1,
      awayGoals: 1,
      lambdaHome: 1.4,
      lambdaAway: 1.1,
    }));

    const fitted = fitDixonColesRho(fixtures);
    const logLik = (rho: number) =>
      fixtures.reduce(
        (acc, f) => acc + Math.log(dixonColesTau(f.homeGoals, f.awayGoals, f.lambdaHome, f.lambdaAway, rho)),
        0,
      );

    assert.ok(logLik(fitted) >= logLik(-0.05), "ρ ajusté doit être au moins aussi vraisemblable que la valeur par défaut");
    assert.ok(logLik(fitted) > logLik(0.04), "ρ ajusté doit battre une valeur de signe opposé");
  });

  it("ajuste ρ dans les bornes autorisées et refuse les petits échantillons", () => {
    const rho = fitDixonColesRho([]);
    assert.equal(rho, -0.05, "valeur par défaut attendue sur échantillon vide");

    const fixtures = Array.from({ length: 200 }, () => ({
      homeGoals: 1,
      awayGoals: 1,
      lambdaHome: 1.4,
      lambdaAway: 1.1,
    }));
    const fitted = fitDixonColesRho(fixtures);
    assert.ok(fitted >= -0.15 && fitted <= 0.05, `ρ hors bornes : ${fitted}`);
  });
});

describe("Matrice de scores", () => {
  it("est normalisée : la somme vaut exactement 1", () => {
    const m = buildScoreMatrix(1.7, 1.2, { rho: -0.05 });
    const total = m.flat().reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `somme = ${total}`);
  });

  it("ne produit aucune probabilité négative même avec ρ agressif", () => {
    const m = buildScoreMatrix(0.4, 0.3, { rho: 0.05 });
    for (const row of m) for (const p of row) assert.ok(p >= 0);
  });

  it("les probabilités 1X2 somment à 1", () => {
    const m = buildScoreMatrix(1.9, 0.9, { rho: -0.04 });
    const o = outcomeProbabilities(m);
    assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 1e-9);
    assert.ok(o.home > o.away, "l'équipe à domicile avec λ supérieur doit dominer");
  });

  it("Over et Under sont complémentaires", () => {
    const m = buildScoreMatrix(1.5, 1.3);
    for (const line of [0.5, 1.5, 2.5, 3.5]) {
      const { over, under } = overUnderProbability(m, line);
      assert.ok(Math.abs(over + under - 1) < 1e-9, `ligne ${line}`);
    }
  });

  it("une hausse des intensités augmente la probabilité d'Over 2.5", () => {
    const low = overUnderProbability(buildScoreMatrix(0.8, 0.7), 2.5).over;
    const high = overUnderProbability(buildScoreMatrix(2.2, 1.9), 2.5).over;
    assert.ok(high > low, `${high} devrait être supérieur à ${low}`);
  });

  it("BTTS et distribution des buts sont cohérents avec la matrice", () => {
    const m = buildScoreMatrix(1.6, 1.4);
    const { yes, no } = bttsProbability(m);
    assert.ok(Math.abs(yes + no - 1) < 1e-9);

    const dist = teamGoalsDistribution(m, "home");
    assert.equal(dist.length, 5);
    assert.ok(Math.abs(dist.reduce((a, b) => a + b, 0) - 1) < 1e-9);

    // La somme des scores sans but encaissé doit correspondre à BTTS Non.
    let homeZero = 0;
    let awayZero = 0;
    for (let h = 0; h < m.length; h++) {
      for (let a = 0; a < m[h].length; a++) {
        if (h === 0) homeZero += m[h][a];
        if (a === 0) awayZero += m[h][a];
      }
    }
    assert.ok(Math.abs(no - (homeZero + awayZero - m[0][0])) < 1e-9);
  });
});

describe("Poisson bivarié", () => {
  it("se réduit à l'indépendance lorsque λ₃ = 0", () => {
    const x = 2;
    const y = 1;
    const joint = bivariatePoissonPmf(x, y, 1.3, 1.1, 0);
    const independent = poissonPmf(x, 1.3) * poissonPmf(y, 1.1);
    assert.ok(Math.abs(joint - independent) < 1e-12);
  });
});

describe("Utilitaires statistiques", () => {
  it("shrink converge vers la valeur observée quand n augmente", () => {
    const withSmall = shrink(3, 1, 2, 6);
    const withLarge = shrink(3, 1, 60, 6);
    assert.ok(withLarge > withSmall);
    assert.ok(withLarge < 3 && withLarge > 1);
  });

  it("recencyWeightedMean donne plus de poids aux valeurs récentes", () => {
    // Index 0 = match le plus récent.
    const recentGood = recencyWeightedMean([3, 3, 0, 0, 0, 0])!;
    const recentBad = recencyWeightedMean([0, 0, 0, 0, 3, 3])!;
    assert.ok(recentGood > recentBad, `${recentGood} devrait dépasser ${recentBad}`);
  });

  it("stdDev retourne null plutôt qu'une valeur inventée sur échantillon insuffisant", () => {
    assert.equal(stdDev([]), null);
    assert.equal(stdDev([1]), null);
    assert.ok(stdDev([1, 3]) !== null);
  });

  it("l'entropie normalisée vaut 0 pour une distribution certaine et 1 pour une uniforme", () => {
    assert.ok(Math.abs(normalizedEntropy([1, 0, 0])) < 1e-12);
    assert.ok(Math.abs(normalizedEntropy([1 / 3, 1 / 3, 1 / 3]) - 1) < 1e-12);
  });
});
