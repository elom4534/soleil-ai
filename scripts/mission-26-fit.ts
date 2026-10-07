/**
 * SOLEIL — Mission 26 · Fit du calibrateur 1X2 (hors moteur, déterministe)
 *
 * Discipline §21 (M25) :
 *  - Ajustement sur A UNIQUEMENT (1 378 obs, 0-270 j).
 *  - Validation sur B (1 637 obs, 270-600 j) — jamais vu par le fit.
 *  - Candidats simples : température (1 param) puis vectoriel (3 params,
 *    c_domicile = 1 pour l'identifiabilité) — outils Phase 12 déjà en repo.
 *  - Adoption seulement si B montre un gain de calibration SANS perte de
 *    log loss / RPS. Sinon : maintien 1.0.0 + surveillance.
 *
 * Sortie : /tmp/m26-fit.json + tableau console.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type CalibrationObservation,
  fitTemperature,
  fitVector,
  multiclassLogLoss,
  multiclassBrier,
  temperatureApply,
  vectorApply,
} from "./backtest/calibration";

const DATA = path.join(__dirname, "audit-26", "m26-data.json");

interface RawObs {
  id: string;
  p: { home: number; draw: number; away: number };
  pred: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  actual: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  league: string;
  date: string;
}

const CLS = ["HOME_WIN", "DRAW", "AWAY_WIN"] as const;
const idx = (c: string) => (c === "HOME_WIN" ? 0 : c === "DRAW" ? 1 : 2);

function wilson(hits: number, n: number) {
  if (n === 0) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = hits / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (center - half) / denom, hi: (center + half) / denom, n };
}

function chi2PValue(x: number, k: number): number {
  if (x <= 0) return 1;
  const a = k / 2;
  const xx = x / 2;
  let sum = 1 / a;
  let term = 1 / a;
  for (let i = 1; i < 200; i++) {
    term *= xx / (a + i);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  let lg = 0;
  {
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    const zz = a - 1;
    let x2 = 0.99999999999980993;
    for (let i = 0; i < 8; i++) x2 += g[i]! / (zz + i + 1);
    const t = zz + g.length - 0.5;
    lg = 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x2);
  }
  const pLower = sum * Math.exp(-xx + a * Math.log(xx) - lg);
  return Math.max(0, Math.min(1, 1 - pLower));
}

/** Métriques d'une série entière pour un vecteur de probabilités appliqué. */
function evaluate(raw: RawObs[], probs: number[][]) {
  const n = raw.length;
  let correct = 0;
  let logloss = 0;
  let brier = 0;
  let rps = 0;
  for (let i = 0; i < n; i++) {
    const p = probs[i]!;
    const y = idx(raw[i]!.actual);
    if (p.indexOf(Math.max(...p)) === y) correct++;
    for (let k = 0; k < 3; k++) {
      const o = k === y ? 1 : 0;
      brier += (p[k]! - o) ** 2;
      const q = Math.min(1 - 1e-15, Math.max(1e-15, p[k]!));
      if (k === y) logloss += -Math.log(q);
    }
    const cdfP = [p[0]!, p[0]! + p[1]!];
    const cdfY = y === 0 ? [1, 1] : y === 1 ? [0, 1] : [0, 0];
    rps += ((cdfP[0]! - cdfY[0]!) ** 2 + (cdfP[1]! - cdfY[1]!) ** 2) / 2;
  }
  // bins par classe (10 pts) + favoris (classe prédite, 5 pts) + ECE + HL
  const binsByClass: Record<string, unknown[]> = {};
  for (let k = 0; k < 3; k++) {
    const rows = raw.map((r, i) => ({ p: probs[i]![k]!, y: idx(r.actual) === k ? 1 : 0 }));
    const bins = [];
    for (let b = 0; b < 10; b++) {
      const lo = b / 10;
      const hi = (b + 1) / 10;
      const inb = rows.filter((r) => r.p > lo - 1e-12 && r.p <= hi + 1e-12 && (b > 0 || r.p >= lo));
      const hits = inb.reduce((s, r) => s + r.y, 0);
      const meanP = inb.length ? inb.reduce((s, r) => s + r.p, 0) / inb.length : 0;
      bins.push({
        bin: `${b * 10}-${(b + 1) * 10} %`,
        n: inb.length,
        predicted: meanP,
        observed: inb.length ? hits / inb.length : 0,
        gap: inb.length ? meanP - hits / inb.length : 0,
        ci: wilson(hits, inb.length),
      });
    }
    binsByClass[CLS[k]!] = bins;
  }
  // favoris : classe la plus probable
  const favZones = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9];
  const favorites = [];
  for (let z = 0; z < favZones.length - 1; z++) {
    const lo = favZones[z]!;
    const hi = favZones[z + 1]!;
    const inb = raw
      .map((r, i) => {
        const p = probs[i]!;
        const top = Math.max(...p);
        return { top, y: p.indexOf(top) === idx(r.actual) ? 1 : 0 };
      })
      .filter((r) => r.top > lo && r.top <= hi);
    const hits = inb.reduce((s, r) => s + r.y, 0);
    const meanP = inb.length ? inb.reduce((s, r) => s + r.top, 0) / inb.length : 0;
    favorites.push({
      zone: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)} %`,
      n: inb.length,
      predicted: meanP,
      observed: inb.length ? hits / inb.length : 0,
      gap: inb.length ? meanP - hits / inb.length : 0,
      ci: wilson(hits, inb.length),
    });
  }
  // ECE (10 bins équidistants sur la proba de la classe prédite) + HL (10 groupes)
  let ece = 0;
  const all = raw.map((r, i) => {
    const p = probs[i]!;
    const top = Math.max(...p);
    return { top, y: p.indexOf(top) === idx(r.actual) ? 1 : 0 };
  });
  for (let b = 0; b < 10; b++) {
    const inb = all.filter((r) => r.top > b / 10 - 1e-12 && r.top <= (b + 1) / 10 + 1e-12 && (b > 0 || r.top >= b / 10));
    if (!inb.length) continue;
    const meanP = inb.reduce((s, r) => s + r.top, 0) / inb.length;
    const obs = inb.reduce((s, r) => s + r.y, 0) / inb.length;
    ece += (inb.length / n) * Math.abs(meanP - obs);
  }
  // HL one-vs-rest sur la classe prédite : 5 groupes de quantiles, ddl = 5−2 = 3
  const topRows = raw
    .map((r, i) => {
      const p = probs[i]!;
      const top = Math.max(...p);
      return { top, y: p.indexOf(top) === idx(r.actual) ? 1 : 0 };
    })
    .sort((a, b) => a.top - b.top);
  const groups = 5;
  let g2 = 0;
  for (let g = 0; g < groups; g++) {
    const lo = Math.floor((g * n) / groups);
    const hi = Math.floor(((g + 1) * n) / groups);
    if (hi <= lo) continue;
    let expHits = 0;
    let obsHits = 0;
    for (let j = lo; j < hi; j++) {
      expHits += topRows[j]!.top;
      obsHits += topRows[j]!.y;
    }
    const size = hi - lo;
    const e = Math.max(1e-9, expHits);
    const eMiss = Math.max(1e-9, size - expHits);
    g2 += (obsHits - expHits) ** 2 / e + ((size - obsHits) - (size - expHits)) ** 2 / eMiss;
  }
  return {
    n,
    accuracy: correct / n,
    logLoss: logloss / n,
    brier: brier / n,
    rps: rps / n,
    ece,
    hl: { g2, df: groups - 2, p: chi2PValue(g2, groups - 2) },
    binsByClass,
    favorites,
  };
}

function fmt(x: number) {
  return x.toFixed(4);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const A: RawObs[] = data.principal;
  const B: RawObs[] = data.holdout;
  const toCal = (rows: RawObs[]): CalibrationObservation[] =>
    rows.map((r) => ({ p: [r.p.home, r.p.draw, r.p.away], y: idx(r.actual) }));

  console.log(`A (fit) : n=${A.length}   B (validation) : n=${B.length}   fuites=${data.antiLeak.principal.fuites + data.antiLeak.holdout.fuites}`);

  // ---- FIT sur A uniquement -------------------------------------------------
  const fitT = fitTemperature(toCal(A));
  const fitV = fitVector(toCal(A));
  console.log(`\nFIT (A) — température : T=${fitT.t}  logloss_A=${fmt(fitT.fitLogLoss)}`);
  console.log(`FIT (A) — vectoriel   : T=${fitV.t}  c=[${fitV.c.map((x) => x.toFixed(3)).join(", ")}]  logloss_A=${fmt(fitV.fitLogLoss)}`);

  const variants = {
    brut: (p: number[]) => p,
    temperature: (p: number[]) => temperatureApply(p, fitT.t),
    vectoriel: (p: number[]) => vectorApply(p, fitV.t, fitV.c),
  } as const;

  const result: Record<string, unknown> = { fit: { temperature: { t: fitT.t }, vectoriel: { t: fitV.t, c: fitV.c } }, series: {} };

  for (const [name, rows] of [
    ["A", A],
    ["B", B],
  ] as const) {
    const per: Record<string, unknown> = {};
    for (const [vname, fn] of Object.entries(variants)) {
      const probs = rows.map((r) => fn([r.p.home, r.p.draw, r.p.away]));
      per[vname] = evaluate(rows, probs);
    }
    (result.series as Record<string, unknown>)[name] = per;

    console.log(`\n===== SÉRIE ${name} =====`);
    console.log("variante      acc     logloss  brier    rps      ECE");
    for (const v of Object.keys(variants)) {
      const e = (per as Record<string, ReturnType<typeof evaluate>>)[v]!;
      console.log(`${v.padEnd(12)} ${fmt(e.accuracy).slice(0, 6)}  ${fmt(e.logLoss)}  ${fmt(e.brier)}  ${fmt(e.rps)}  ${fmt(e.ece)}`);
    }
    // Focus favoris domicile (HOME_WIN 50-70) + favoris top-1
    for (const v of ["brut", "vectoriel"]) {
      const e = (per as Record<string, ReturnType<typeof evaluate>>)[v]!;
      const home = e.binsByClass.HOME_WIN as { bin: string; n: number; predicted: number; observed: number; gap: number }[];
      const f = e.favorites;
      console.log(`  [${v}] HOME_WIN 50-60 : n=${home[5]!.n} pred=${fmt(home[5]!.predicted)} obs=${fmt(home[5]!.observed)} gap=${fmt(home[5]!.gap)}`);
      console.log(`  [${v}] HOME_WIN 60-70 : n=${home[6]!.n} pred=${fmt(home[6]!.predicted)} obs=${fmt(home[6]!.observed)} gap=${fmt(home[6]!.gap)}`);
      console.log(`  [${v}] favoris top-1 55-60 : n=${(f as { n: number }[])[1]!.n}  60-65 : n=${(f as { n: number }[])[2]!.n}  65-70 : n=${(f as { n: number }[])[3]!.n}`);
      console.log(`  [${v}] HL : G2=${e.hl.g2.toFixed(1)} p=${e.hl.p.toFixed(4)}`);
    }
    // flips de top-1 entre brut et vectoriel
    let flips = 0;
    for (let i = 0; i < rows.length; i++) {
      const p0 = [rows[i]!.p.home, rows[i]!.p.draw, rows[i]!.p.away];
      const p1 = variants.vectoriel(p0);
      if (p0.indexOf(Math.max(...p0)) !== p1.indexOf(Math.max(...p1))) flips++;
    }
    console.log(`  flips top-1 (brut → vectoriel) : ${flips}`);
  }

  fs.writeFileSync("/tmp/m26-fit.json", JSON.stringify(result, null, 1));
  console.log("\n→ /tmp/m26-fit.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
