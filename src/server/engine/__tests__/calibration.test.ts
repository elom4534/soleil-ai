import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CALIBRATOR, calibrateOneXTwo } from "../calibration";

describe("calibration 1X2 (Mission 26)", () => {
  it("préserve la somme exacte à 1 (renormalisation)", () => {
    for (const p of [
      { home: 0.62, draw: 0.25, away: 0.13 },
      { home: 0.34, draw: 0.33, away: 0.33 },
      { home: 0.01, draw: 0.02, away: 0.97 },
      { home: 0.9, draw: 0.05, away: 0.05 },
    ]) {
      const q = calibrateOneXTwo(p);
      const s = q.home + q.draw + q.away;
      assert.ok(Math.abs(s - 1) < 1e-12, `somme=${s}`);
      assert.ok(q.home > 0 && q.draw > 0 && q.away > 0);
    }
  });

  it("est neutre quand T=1 et c=[1,1,1] (rollback sans autre changement)", () => {
    const saved = { ...CALIBRATOR, c: { ...CALIBRATOR.c } };
    CALIBRATOR.t = 1;
    CALIBRATOR.c = { home: 1, draw: 1, away: 1 };
    try {
      const p = { home: 0.62, draw: 0.25, away: 0.13 };
      const q = calibrateOneXTwo(p);
      assert.ok(Math.abs(q.home - p.home) < 1e-12);
      assert.ok(Math.abs(q.draw - p.draw) < 1e-12);
      assert.ok(Math.abs(q.away - p.away) < 1e-12);
    } finally {
      CALIBRATOR.t = saved.t;
      CALIBRATOR.c = saved.c;
    }
  });

  it("est déterministe", () => {
    const p = { home: 0.55, draw: 0.28, away: 0.17 };
    const a = calibrateOneXTwo(p);
    const b = calibrateOneXTwo(p);
    assert.deepEqual(a, b);
  });

  it("préserve l'ordre des probabilités (monotonie par classe)", () => {
    // p.home croissant → q.home croissant (idem pour les autres classes).
    let prevH = 0;
    let prevA = 0;
    for (let h = 0.02; h <= 0.95; h += 0.02) {
      const rest = 1 - h;
      const q = calibrateOneXTwo({ home: h, draw: rest * 0.6, away: rest * 0.4 });
      assert.ok(q.home > prevH - 1e-12, `q.home non croissant à h=${h}`);
      prevH = q.home;
    }
    for (let a = 0.02; a <= 0.95; a += 0.02) {
      const rest = 1 - a;
      const q = calibrateOneXTwo({ home: rest * 0.6, draw: rest * 0.4, away: a });
      assert.ok(q.away > prevA - 1e-12, `q.away non croissant à a=${a}`);
      prevA = q.away;
    }
  });

  it("étire les extrêmes (T < 1) : favoris domicile au-dessus de 50 % gagnent en confiance", () => {
    const p = { home: 0.62, draw: 0.25, away: 0.13 };
    const q = calibrateOneXTwo(p);
    assert.ok(q.home > p.home, `attendu q.home > 0.62, obtenu ${q.home}`);
  });

  it("comprime les probabilités intermédiaires basses (outsider extérieur < 1/3)", () => {
    const p = { home: 0.5, draw: 0.3, away: 0.2 };
    const q = calibrateOneXTwo(p);
    assert.ok(q.away < p.away, `attendu q.away < 0.2, obtenu ${q.away}`);
  });

  it("gère les bornes (probabilités nulles) sans exploser", () => {
    const q = calibrateOneXTwo({ home: 0, draw: 0, away: 1 });
    assert.ok(q.home > 0 && q.draw > 0 && q.away > 0);
    const s = q.home + q.draw + q.away;
    assert.ok(Math.abs(s - 1) < 1e-12);
    assert.ok(q.away > 0.99);
  });

  it("paramètres figés conformes à la Mission 26 (T=0.79, c=[1, 1.04, 0.86])", () => {
    assert.equal(CALIBRATOR.kind, "vector");
    assert.equal(CALIBRATOR.t, 0.79);
    assert.deepEqual(CALIBRATOR.c, { home: 1, draw: 1.04, away: 0.86 });
  });
});
