/**
 * SOLEIL — Mission 26 · Comparaison APPARIÉE ancien vs nouveau moteur (1X2)
 *
 *  - ancien = `1.0.0-matrix-ensemble` (snapshot scripts/audit-26/old)
 *  - nouveau = `1.0.1-calibrated` (src courant, recalibration vectorielle)
 *
 * Série = fenêtres M24 (0-270 j et 270-500 j, 500 examinés par fenêtre),
 * contextes reconstruits asOf pré-coup d'envoi, anti-fuite strict (0 fuite
 * exigée, sinon arrêt). Les DEUX moteurs voient les MÊMES contextes.
 *
 * Mesures appariées : accuracy 1X2, log loss, Brier, RPS, ECE, bins favoris,
 * HL, flips de pick, exactitude des flips, McNemar sur les corrects.
 *
 * Sortie : /tmp/audit-26-compare.json
 */

import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { prisma } from "@/lib/prisma";
import { buildMatchContext } from "@/server/predictions/context";
import { generatePrediction } from "@/server/engine";
import { generatePrediction as generatePredictionOld } from "./audit-26/old/index";

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
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const zz = a - 1;
  let x2 = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x2 += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  const lg = 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x2);
  const pLower = sum * Math.exp(-xx + a * Math.log(xx) - lg);
  return Math.max(0, Math.min(1, 1 - pLower));
}

interface Row {
  id: string;
  old: { home: number; draw: number; away: number };
  neu: { home: number; draw: number; away: number };
  oldPick: string;
  neuPick: string;
  actual: string;
  date: number;
}

function metrics(rows: Row[], key: "old" | "neu") {
  const n = rows.length;
  let correct = 0;
  let logloss = 0;
  let brier = 0;
  let rps = 0;
  for (const r of rows) {
    const p = r[key];
    const arr = [p.home, p.draw, p.away];
    const y = idx(r.actual);
    if (arr.indexOf(Math.max(...arr)) === y) correct++;
    for (let k = 0; k < 3; k++) {
      const o = k === y ? 1 : 0;
      brier += (arr[k]! - o) ** 2;
      const q = Math.min(1 - 1e-15, Math.max(1e-15, arr[k]!));
      if (k === y) logloss += -Math.log(q);
    }
    const cdfP = [arr[0]!, arr[0]! + arr[1]!];
    const cdfY = y === 0 ? [1, 1] : y === 1 ? [0, 1] : [0, 0];
    rps += ((cdfP[0]! - cdfY[0]!) ** 2 + (cdfP[1]! - cdfY[1]!) ** 2) / 2;
  }
  // bins favoris domicile (HOME_WIN en 5 pts de 40 à 80)
  const homeBins = [];
  for (const [lo, hi] of [[0.4, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8]] as const) {
    const inb = rows.filter((r) => r[key].home > lo && r[key].home <= hi);
    const hits = inb.reduce((s, r) => s + (r.actual === "HOME_WIN" ? 1 : 0), 0);
    const meanP = inb.length ? inb.reduce((s, r) => s + r[key].home, 0) / inb.length : 0;
    homeBins.push({
      zone: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)} %`,
      n: inb.length,
      predicted: meanP,
      observed: inb.length ? hits / inb.length : 0,
      gap: inb.length ? meanP - hits / inb.length : 0,
      ci: wilson(hits, inb.length),
    });
  }
  // HL one-vs-rest (classe prédite, 5 groupes)
  const topRows = rows
    .map((r) => {
      const arr = [r[key].home, r[key].draw, r[key].away];
      const top = Math.max(...arr);
      return { top, y: arr.indexOf(top) === idx(r.actual) ? 1 : 0 };
    })
    .sort((a, b) => a.top - b.top);
  let g2 = 0;
  for (let g = 0; g < 5; g++) {
    const lo = Math.floor((g * n) / 5);
    const hi = Math.floor(((g + 1) * n) / 5);
    if (hi <= lo) continue;
    let expHits = 0;
    let obsHits = 0;
    for (let j = lo; j < hi; j++) {
      expHits += topRows[j]!.top;
      obsHits += topRows[j]!.y;
    }
    const size = hi - lo;
    g2 += (obsHits - expHits) ** 2 / Math.max(1e-9, expHits) + ((size - obsHits) - (size - expHits)) ** 2 / Math.max(1e-9, size - expHits);
  }
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const inb = topRows.filter((r) => r.top > b / 10 && r.top <= (b + 1) / 10);
    if (!inb.length) continue;
    const meanP = inb.reduce((s, r) => s + r.top, 0) / inb.length;
    const obs = inb.reduce((s, r) => s + r.y, 0) / inb.length;
    ece += (inb.length / n) * Math.abs(meanP - obs);
  }
  return {
    n,
    accuracy: correct / n,
    logLoss: logloss / n,
    brier: brier / n,
    rps: rps / n,
    ece,
    hl: { g2, df: 3, p: chi2PValue(g2, 3) },
    homeBins,
  };
}

async function sampleMatches(fromDays: number, toDays: number) {
  return prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: {
        gte: new Date(Date.now() - fromDays * 86_400_000),
        lte: new Date(Date.now() - toDays * 86_400_000),
      },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { utcDate: "desc" },
    select: {
      id: true,
      utcDate: true,
      homeScore: true,
      awayScore: true,
      league: { select: { name: true } },
    },
    take: 500,
  });
}

async function runSample(fromDays: number, toDays: number, label: string) {
  const matches = await sampleMatches(fromDays, toDays);
  const rows: Row[] = [];
  const excluded: Record<string, number> = {};
  let leak = 0;

  for (const m of matches) {
    const { context } = await buildMatchContext(m.id, m.utcDate);
    if (!context) {
      excluded["contexte impossible"] = (excluded["contexte impossible"] ?? 0) + 1;
      continue;
    }
    const future = [...context.home.seasonMatches, ...context.away.seasonMatches, ...context.home.headToHead]
      .filter((x) => x.date.getTime() >= m.utcDate.getTime());
    if (future.length > 0) {
      leak++;
      throw new Error(`FUITE sur ${m.id} — arrêt`);
    }
    const oldR = generatePredictionOld(context);
    const newR = generatePrediction(context);
    if (!oldR.publishable || !newR.publishable) {
      excluded["non publishable"] = (excluded["non publishable"] ?? 0) + 1;
      continue;
    }
    const hg = m.homeScore!;
    const ag = m.awayScore!;
    rows.push({
      id: m.id,
      old: { ...oldR.outcomes },
      neu: { ...newR.outcomes },
      oldPick: oldR.consensusPick,
      neuPick: newR.consensusPick,
      actual: hg > ag ? "HOME_WIN" : hg < ag ? "AWAY_WIN" : "DRAW",
      date: m.utcDate.getTime(),
    });
  }

  let flips = 0;
  let flipGood = 0;
  let flipBad = 0;
  let oldOnly = 0; // ancien correct, nouveau faux
  let newOnly = 0; // ancien faux, nouveau correct
  for (const r of rows) {
    const oldOk = r.oldPick === r.actual;
    const newOk = r.neuPick === r.actual;
    if (r.oldPick !== r.neuPick) {
      flips++;
      if (newOk && !oldOk) flipGood++;
      if (!newOk && oldOk) flipBad++;
    }
    if (oldOk && !newOk) oldOnly++;
    if (!oldOk && newOk) newOnly++;
  }
  // McNemar exact (binomiale) sur les discordants
  const nDisc = oldOnly + newOnly;
  let mcnemarP = 1;
  if (nDisc > 0) {
    const k = Math.min(oldOnly, newOnly);
    let cdf = 0;
    for (let i = 0; i <= k; i++) {
      let logC = 0;
      for (let j = 0; j < i; j++) logC += Math.log(nDisc - j) - Math.log(j + 1);
      cdf += Math.exp(logC + nDisc * Math.log(0.5));
    }
    mcnemarP = Math.min(1, 2 * cdf);
  }

  const result = {
    label,
    examined: matches.length,
    n: rows.length,
    leak,
    excluded,
    ancien: metrics(rows, "old"),
    nouveau: metrics(rows, "neu"),
    flips: { total: flips, bons: flipGood, mauvais: flipBad },
    mcnemar: { ancienSeulCorrect: oldOnly, nouveauSeulCorrect: newOnly, p: mcnemarP },
    rows,
  };
  console.log(`  ${label} : n=${rows.length} examinés=${matches.length} fuites=${leak} exclus=${JSON.stringify(excluded)}`);
  console.log(`    ancien  : acc=${(result.ancien.accuracy * 100).toFixed(2)} % logloss=${result.ancien.logLoss.toFixed(4)} brier=${result.ancien.brier.toFixed(4)} rps=${result.ancien.rps.toFixed(4)} ece=${result.ancien.ece.toFixed(4)} HL_p=${result.ancien.hl.p.toFixed(4)}`);
  console.log(`    nouveau : acc=${(result.nouveau.accuracy * 100).toFixed(2)} % logloss=${result.nouveau.logLoss.toFixed(4)} brier=${result.nouveau.brier.toFixed(4)} rps=${result.nouveau.rps.toFixed(4)} ece=${result.nouveau.ece.toFixed(4)} HL_p=${result.nouveau.hl.p.toFixed(4)}`);
  console.log(`    flips=${flips} (bons=${flipGood} mauvais=${flipBad})  McNemar ancien=${oldOnly} nouveau=${newOnly} p=${mcnemarP.toFixed(4)}`);
  return result;
}

async function main() {
  console.log("Mission 26 — comparaison appariée ancien (1.0.0) vs nouveau (1.0.1-calibrated)");
  const principal = await runSample(270, 0, "principal 0-270 j");
  const holdout = await runSample(500, 270, "hold-out 270-500 j");
  fs.writeFileSync(
    "/tmp/audit-26-compare.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), principal, holdout }),
  );
  console.log("→ /tmp/audit-26-compare.json");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
