/**
 * SOLEIL — Mission 25 · Audit de calibration 1X2 (MESURE UNIQUEMENT)
 *
 * Moteur gelé : aucune écriture, aucune recalibration. Les probabilités
 * auditées sont les probabilités PUBLIÉES par le moteur (outcomes, source
 * « matrix ») — exactement ce que voit l'utilisateur.
 *
 * Anti-fuite : contextes reconstruits avec asOf = date du match ; tout match
 * du contexte daté >= coup d'envoi = ARRÊT immédiat.
 *
 * Sortie : /tmp/audit-25.json (résumé console).
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

// ---------------------------------------------------------------------------
// Outils statistiques
// ---------------------------------------------------------------------------

const EPS = 1e-15; // clipping log loss — documenté, aucun cas < 1e-6 observé

function wilson(hits: number, n: number) {
  if (n === 0) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = hits / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (center - half) / denom, hi: (center + half) / denom, n };
}

/** p-value du chi² (complément de la CDF) via la série gamma incomplète. */
function chi2PValue(x: number, k: number): number {
  if (x <= 0) return 1;
  const a = k / 2;
  const xx = x / 2;
  // gamma incomplète inférieure régularisée P(a, x) par série entière
  let sum = 1 / a;
  let term = 1 / a;
  for (let i = 1; i < 200; i++) {
    term *= xx / (a + i);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  const pLower = sum * Math.exp(-xx + a * Math.log(xx) - logGammaFn(a));
  return Math.max(0, Math.min(1, 1 - pLower));
}

function logGammaFn(z: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGammaFn(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x += g[i] / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

// ---------------------------------------------------------------------------
// Collecte
// ---------------------------------------------------------------------------

interface Obs {
  p: { home: number; draw: number; away: number };
  pred: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  actual: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  league: string;
  date: number;
  hasXg: boolean;
  hasSot: boolean;
  nHomeMatches: number;
}

async function collect(fromDays: number, toDays: number, limit: number) {
  const matches = await prisma.match.findMany({
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
      id: true, utcDate: true, homeScore: true, awayScore: true,
      league: { select: { name: true } },
    },
    take: limit,
  });

  const obs: Obs[] = [];
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
      throw new Error(`FUITE DÉTECTÉE sur ${m.id} — arrêt`);
    }
    const r = generatePrediction(context);
    if (!r.publishable) {
      excluded["non publishable"] = (excluded["non publishable"] ?? 0) + 1;
      continue;
    }
    const hg = m.homeScore!, ag = m.awayScore!;
    obs.push({
      p: r.outcomes,
      pred: r.consensusPick,
      actual: hg > ag ? "HOME_WIN" : hg < ag ? "AWAY_WIN" : "DRAW",
      league: m.league.name,
      date: m.utcDate.getTime(),
      hasXg: context.home.seasonMatches.some((x) => x.homeXg !== null || x.awayXg !== null),
      hasSot: context.home.seasonMatches.some((x) => x.homeShotsOnTarget !== null || x.awayShotsOnTarget !== null),
      nHomeMatches: context.home.seasonMatches.length,
    });
  }
  return { obs, examined: matches.length, leak, excluded };
}

// ---------------------------------------------------------------------------
// Mesures
// ---------------------------------------------------------------------------

const CLASSES = ["HOME_WIN", "DRAW", "AWAY_WIN"] as const;
type Cls = (typeof CLASSES)[number];
const idx = (c: Cls) => (c === "HOME_WIN" ? 0 : c === "DRAW" ? 1 : 2);
const pOf = (o: Obs, c: Cls) => (c === "HOME_WIN" ? o.p.home : c === "DRAW" ? o.p.draw : o.p.away);

function metrics(obs: Obs[]) {
  const n = obs.length;
  if (n === 0) return null;
  let correct = 0;
  let brier = 0;
  let logloss = 0;
  let rps = 0;
  let clipped = 0;
  const confusion: Record<string, number> = {};
  const brierPerClass: Record<Cls, number> = { HOME_WIN: 0, DRAW: 0, AWAY_WIN: 0 };
  const loglossPerClass: Record<Cls, number> = { HOME_WIN: 0, DRAW: 0, AWAY_WIN: 0 };

  for (const o of obs) {
    const y: number[] = [0, 0, 0];
    y[idx(o.actual)] = 1;
    const p = [o.p.home, o.p.draw, o.p.away];
    for (let i = 0; i < 3; i++) {
      brier += (p[i] - y[i]) ** 2;
      brierPerClass[CLASSES[i]] += (p[i] - y[i]) ** 2;
      let q = p[i];
      if (q < EPS) { q = EPS; clipped++; }
      if (q > 1 - EPS) { q = 1 - EPS; clipped++; }
      logloss += -Math.log(q) * y[i];
      loglossPerClass[CLASSES[i]] += -Math.log(q) * y[i];
    }
    // RPS (ordre H < D < A)
    const cdfP = [p[0], p[0] + p[1]];
    const cdfY = [y[0], y[0] + y[1]];
    rps += (cdfP[0] - cdfY[0]) ** 2 + (cdfP[1] - cdfY[1]) ** 2;
    if (o.pred === o.actual) correct++;
    const key = `${o.pred}→${o.actual}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  return {
    sample: n,
    accuracy: correct / n,
    brierMulticlass: brier / n,
    brierHome: brierPerClass.HOME_WIN / n,
    brierDraw: brierPerClass.DRAW / n,
    brierAway: brierPerClass.AWAY_WIN / n,
    logLoss: logloss / n,
    logLossHome: loglossPerClass.HOME_WIN / n,
    logLossDraw: loglossPerClass.DRAW / n,
    logLossAway: loglossPerClass.AWAY_WIN / n,
    rps: rps / (2 * n),
    clippedProbabilities: clipped,
    confusion,
  };
}

/** Calibration one-vs-rest par classe, bins de largeur 10 %, IC Wilson. */
function calibrationByClass(obs: Obs[], cls: Cls) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, hits: 0 }));
  for (const o of obs) {
    const p = pOf(o, cls);
    const i = Math.min(9, Math.max(0, Math.floor(p * 10)));
    bins[i].n++;
    bins[i].sumP += p;
    if (o.actual === cls) bins[i].hits++;
  }
  const rows = bins.map((b, i) => ({
    bin: `${i * 10}-${i * 10 + 10} %`,
    n: b.n,
    predicted: b.n ? b.sumP / b.n : 0,
    observed: b.n ? b.hits / b.n : 0,
    gap: b.n ? b.sumP / b.n - b.hits / b.n : 0,
    ci95: wilson(b.hits, b.n),
  }));
  // ECE / MCE (binning 10 bins égaux, one-vs-rest)
  let ece = 0, mce = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    const gap = Math.abs(b.sumP / b.n - b.hits / b.n);
    ece += (b.n / obs.length) * gap;
    mce = Math.max(mce, gap);
  }
  return { bins: rows, ece, mce };
}

/** Bins fins pour les favoris, sur la proba de la classe prédite (p_max). */
function favoritesBins(obs: Obs[]) {
  const edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.01];
  const rows: { zone: string; n: number; predicted: number; observed: number; gap: number; ci95: ReturnType<typeof wilson> }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const sub = obs.filter((o) => {
      const pmax = Math.max(o.p.home, o.p.draw, o.p.away);
      return pmax >= edges[i] && pmax < edges[i + 1];
    });
    const hits = sub.filter((o) => o.pred === o.actual).length;
    const sumP = sub.reduce((a, o) => a + Math.max(o.p.home, o.p.draw, o.p.away), 0);
    rows.push({
      zone: `${Math.round(edges[i] * 100)}-${Math.round(Math.min(edges[i + 1], 1) * 100)} %`,
      n: sub.length,
      predicted: sub.length ? sumP / sub.length : 0,
      observed: sub.length ? hits / sub.length : 0,
      gap: sub.length ? sumP / sub.length - hits / sub.length : 0,
      ci95: wilson(hits, sub.length),
    });
  }
  return rows;
}

/** Bins fins sur la probabilité HOME (favoris domicile). */
function homeFavBins(obs: Obs[]) {
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.01];
  const rows: { zone: string; n: number; predicted: number; observed: number; gap: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const sub = obs.filter((o) => o.p.home >= edges[i] && o.p.home < edges[i + 1]);
    const hits = sub.filter((o) => o.actual === "HOME_WIN").length;
    const sumP = sub.reduce((a, o) => a + o.p.home, 0);
    rows.push({
      zone: `${Math.round(edges[i] * 100)}-${Math.round(Math.min(edges[i + 1], 1) * 100)} %`,
      n: sub.length,
      predicted: sub.length ? sumP / sub.length : 0,
      observed: sub.length ? hits / sub.length : 0,
      gap: sub.length ? sumP / sub.length - hits / sub.length : 0,
    });
  }
  return rows;
}

/** Test de Hosmer-Lemeshow (bins 10, classe prédite vs issues observées). */
function hosmerLemeshow(obs: Obs[]) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, hits: 0 }));
  for (const o of obs) {
    const pmax = Math.max(o.p.home, o.p.draw, o.p.away);
    const i = Math.min(9, Math.max(0, Math.floor(pmax * 10)));
    bins[i].n++;
    bins[i].sumP += pmax;
    if (o.pred === o.actual) bins[i].hits++;
  }
  let chi2 = 0;
  let used = 0;
  for (const b of bins) {
    if (b.n < 3) continue;
    used++;
    const e = b.sumP;
    chi2 += (b.hits - e) ** 2 / (e * (1 - e / b.n) || 1e-9);
  }
  const ddl = Math.max(1, used - 2);
  return { chi2, ddl, pValue: chi2PValue(chi2, ddl) };
}

function eceOf(obs: Obs[]) {
  // ECE sur la classe prédite (bins 10 égaux)
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, hits: 0 }));
  for (const o of obs) {
    const pmax = Math.max(o.p.home, o.p.draw, o.p.away);
    const i = Math.min(9, Math.max(0, Math.floor(pmax * 10)));
    bins[i].n++;
    bins[i].sumP += pmax;
    if (o.pred === o.actual) bins[i].hits++;
  }
  let ece = 0, mce = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    const gap = Math.abs(b.sumP / b.n - b.hits / b.n);
    ece += (b.n / obs.length) * gap;
    mce = Math.max(mce, gap);
  }
  return { ece, mce };
}

function summarize(label: string, obs: Obs[]) {
  const m = metrics(obs);
  const cal: Record<string, ReturnType<typeof calibrationByClass>> = {};
  for (const c of CLASSES) cal[c] = calibrationByClass(obs, c);
  return {
    label,
    n: obs.length,
    metrics: m,
    ecePredClass: eceOf(obs),
    calibration: cal,
    favorites: favoritesBins(obs),
    homeFav: homeFavBins(obs),
    hosmerLemeshow: hosmerLemeshow(obs),
  };
}

function byLeague(obs: Obs[]) {
  const groups = new Map<string, Obs[]>();
  for (const o of obs) {
    if (!groups.has(o.league)) groups.set(o.league, []);
    groups.get(o.league)!.push(o);
  }
  const out: Record<string, unknown> = {};
  for (const [league, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < 25) {
      out[league] = { n: list.length, note: "échantillon insuffisant (n < 25)" };
      continue;
    }
    const m = metrics(list)!;
    const e = eceOf(list);
    out[league] = { n: list.length, accuracy: m.accuracy, brier: m.brierMulticlass, logLoss: m.logLoss, rps: m.rps, ece: e.ece };
  }
  return out;
}

function byPeriod(obs: Obs[]) {
  const sorted = [...obs].sort((a, b) => a.date - b.date);
  const k = Math.floor(sorted.length / 3);
  const periods = [
    ["ancienne", sorted.slice(0, k)],
    ["intermédiaire", sorted.slice(k, 2 * k)],
    ["récente", sorted.slice(2 * k)],
  ] as [string, Obs[]][];
  const out: Record<string, unknown> = {};
  for (const [label, list] of periods) {
    if (list.length < 20) continue;
    const m = metrics(list)!;
    const e = eceOf(list);
    out[label] = {
      n: list.length,
      from: new Date(list[0].date).toISOString().slice(0, 10),
      to: new Date(list[list.length - 1].date).toISOString().slice(0, 10),
      accuracy: m.accuracy, brier: m.brierMulticlass, logLoss: m.logLoss, ece: e.ece,
    };
  }
  return out;
}

function byDataQuality(obs: Obs[]) {
  const mk = (list: Obs[]) => {
    if (list.length < 20) return { n: list.length, note: "insuffisant" };
    const m = metrics(list)!;
    const e = eceOf(list);
    return { n: list.length, accuracy: m.accuracy, brier: m.brierMulticlass, logLoss: m.logLoss, ece: e.ece };
  };
  return {
    avec_xG: mk(obs.filter((o) => o.hasXg)),
    sans_xG: mk(obs.filter((o) => !o.hasXg)),
    avec_SOT: mk(obs.filter((o) => o.hasSot)),
    sans_SOT: mk(obs.filter((o) => !o.hasSot)),
  };
}

function extremes(obs: Obs[]) {
  const mk = (list: Obs[], label: string) => {
    const hits = list.filter((o) => o.pred === o.actual).length;
    return {
      label,
      n: list.length,
      predicted: list.length ? list.reduce((a, o) => a + Math.max(o.p.home, o.p.draw, o.p.away), 0) / list.length : 0,
      observed: list.length ? hits / list.length : 0,
      ci95: wilson(hits, list.length),
    };
  };
  const pmax = (o: Obs) => Math.max(o.p.home, o.p.draw, o.p.away);
  return {
    tresConfiant: [
      mk(obs.filter((o) => pmax(o) > 0.7), "> 70 %"),
      mk(obs.filter((o) => pmax(o) > 0.8), "> 80 %"),
      mk(obs.filter((o) => pmax(o) > 0.9), "> 90 %"),
    ],
    faibleConfiance: [
      mk(obs.filter((o) => pmax(o) < 0.35), "< 35 %"),
      mk(obs.filter((o) => pmax(o) >= 0.35 && pmax(o) < 0.45), "35-45 %"),
    ],
    probasFaiblesParClasse: {
      home_sous_10: mk(obs.filter((o) => o.p.home < 0.1), "p(home) < 10 %"),
      home_10_20: mk(obs.filter((o) => o.p.home >= 0.1 && o.p.home < 0.2), "p(home) 10-20 %"),
    },
  };
}

function homeAwayBias(obs: Obs[]) {
  const mk = (list: Obs[], label: string) => {
    if (list.length < 15) return { label, n: list.length, note: "insuffisant" };
    const m = metrics(list)!;
    return { label, n: list.length, accuracy: m.accuracy, brier: m.brierMulticlass, logLoss: m.logLoss };
  };
  return [
    mk(obs.filter((o) => o.pred === "HOME_WIN" && o.p.home > o.p.away), "favori domicile"),
    mk(obs.filter((o) => o.pred === "AWAY_WIN" && o.p.away > o.p.home), "favori extérieur"),
    mk(obs.filter((o) => Math.max(o.p.home, o.p.away) - Math.min(o.p.home, o.p.away) < 0.15), "équipes proches"),
    mk(obs.filter((o) => Math.max(o.p.home, o.p.draw, o.p.away) > 0.7), "très forte différence"),
  ];
}

function baselines(obs: Obs[]) {
  const n = obs.length;
  const counts: Record<Cls, number> = { HOME_WIN: 0, DRAW: 0, AWAY_WIN: 0 };
  for (const o of obs) counts[o.actual]++;
  // Uniforme
  const brierUniform = 3 * ((1 / 3 - counts.HOME_WIN / n) ** 2 + (1 / 3 - counts.DRAW / n) ** 2 + (1 / 3 - counts.AWAY_WIN / n) ** 2) / 1;
  // Fréquences marginales
  const freq = { home: counts.HOME_WIN / n, draw: counts.DRAW / n, away: counts.AWAY_WIN / n };
  const brierFreq = (freq.home - 1) ** 2 * (freq.home) + (freq.home - 0) ** 2 * (freq.draw + freq.away); // approx → calcul direct ci-dessous
  let bf = 0;
  for (const o of obs) {
    bf += (freq.home - (o.actual === "HOME_WIN" ? 1 : 0)) ** 2 + (freq.draw - (o.actual === "DRAW" ? 1 : 0)) ** 2 + (freq.away - (o.actual === "AWAY_WIN" ? 1 : 0)) ** 2;
  }
  const llFreq = -(
    counts.HOME_WIN * Math.log(freq.home) + counts.DRAW * Math.log(freq.draw) + counts.AWAY_WIN * Math.log(freq.away)
  ) / n;
  return {
    uniforme: { accuracy: 1 / 3, brier: brierUniform, logLoss: -Math.log(1 / 3) },
    frequencesMarginales: { accuracy: Math.max(freq.home, freq.draw, freq.away), brier: bf / n, logLoss: llFreq, freq },
    note: brierFreq,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Mission 25 — audit de calibration 1X2 (mesure seule)…");
  const principal = await collect(270, 0, 3000);
  console.log(`  principal : ${principal.obs.length} observations (examinés ${principal.examined}, exclus ${JSON.stringify(principal.excluded)})`);
  const holdout = await collect(600, 270, 2000);
  console.log(`  hold-out  : ${holdout.obs.length} observations (examinés ${holdout.examined}, exclus ${JSON.stringify(holdout.excluded)})`);

  const out = {
    generatedAt: new Date().toISOString(),
    engine: "84d8301 · 1.0.0-matrix-ensemble",
    antiLeak: {
      principal: { examines: principal.examined, valides: principal.obs.length, fuites: principal.leak, exclus: principal.excluded },
      holdout: { examines: holdout.examined, valides: holdout.obs.length, fuites: holdout.leak, exclus: holdout.excluded },
    },
    clippingLogLoss: `probabilités bornées à [${EPS}, ${1 - EPS}] pour le log loss (stabilité numérique) — nombre de valeurs clippées reporté par métrique`,
    principal: {
      ...summarize("PRINCIPAL (0-270 j)", principal.obs),
      byLeague: byLeague(principal.obs),
      byPeriod: byPeriod(principal.obs),
      byDataQuality: byDataQuality(principal.obs),
      extremes: extremes(principal.obs),
      homeAwayBias: homeAwayBias(principal.obs),
      baselines: baselines(principal.obs),
    },
    holdout: {
      ...summarize("HOLD-OUT (270-600 j)", holdout.obs),
      byLeague: byLeague(holdout.obs),
      byPeriod: byPeriod(holdout.obs),
      byDataQuality: byDataQuality(holdout.obs),
      extremes: extremes(holdout.obs),
    },
  };
  fs.writeFileSync("/tmp/audit-25.json", JSON.stringify(out, null, 2));
  console.log("→ /tmp/audit-25.json");
  await prisma.$disconnect();
}

main().catch((e) => { console.error("ÉCHEC:", e.message); process.exit(1); });
