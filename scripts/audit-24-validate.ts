/**
 * SOLEIL — Mission 24 · Validation scientifique du moteur 84d8301
 *
 * MESURE UNIQUEMENT — aucune écriture en base, aucune modification du moteur.
 *
 * Variantes comparées sur les MÊMES matchs (contextes reconstruits asOf) :
 *   v0 = moteur ancien (3c337c2) — bug matchOutcome, sans shots, sélection mode
 *   A0 = ensembles 5 modèles avec formModel LEGACY (points inversés)
 *   A1 = idem avec formModel corrigé → effet isolé du fix matchOutcome
 *   B- = A1 sans modèle shots → effet isolé de shots
 *   B+ = avec shots (= 84d8301, sélection mode)
 *   v3 = 84d8301 complet (sélection top-k pondérée)
 *
 * Échantillons : principal = 0-45 jours (celui de la M22/M23) ·
 * hold-out indépendant = 45-135 jours (jamais utilisé pour décider).
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
import { generatePrediction as generatePredictionOld } from "./audit-24/old/index";
import {
  buildModelContext,
  poissonModel,
  statisticalModel,
  xgModel,
  shotsModel,
  homeAwayModel,
  formModel,
} from "@/server/engine/models";
import { runEnsemble, consensusLambdas, BASE_WEIGHTS } from "@/server/engine/ensemble";
import {
  buildScoreMatrix,
  exactScores,
  overUnderProbability,
  bttsProbability,
  mean,
} from "@/server/engine/math";
import { pointsFor } from "@/server/engine/ratings";
import type { MatchContext, MatchRecord, ModelPrediction, TeamSnapshot, LeagueBaseline, Outcome } from "@/server/engine/types";

// ---------------------------------------------------------------------------
// Chaîne de calcul reproduite fidèlement (index.ts) pour assembler des
// variantes sans toucher au moteur. Seul `pickMostLikely` change selon la
// variante (mode pur vs sélection Mission 23).
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function chain(context: MatchContext, models: ModelPrediction[], mode: "mode" | "m23") {
  const ctx = buildModelContext(context.home, context.away, context.leagueBaseline, estimateRhoLike(context));
  const ensemble = runEnsemble(models.map((m) => (typeof m === "function" ? (m as never) : m)) as ModelPrediction[]);
  const lambdas = consensusLambdas(ensemble.models) ?? { home: ctx.lambdaHome, away: ctx.lambdaAway };
  const lambdaHome = clamp(Number.isFinite(lambdas.home) && lambdas.home > 0 ? lambdas.home : 0.01, 0.12, 5.2);
  const lambdaAway = clamp(Number.isFinite(lambdas.away) && lambdas.away > 0 ? lambdas.away : 0.01, 0.08, 5.0);
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, { rho: ctx.rho, maxGoals: 10 });
  const top = exactScores(matrix, 10).map((s) => ({ score: s.score, home: s.home, away: s.away, probability: s.probability }));
  const mostLikely = mode === "mode" ? top[0] : pickM23(top, lambdaHome, lambdaAway, pickOutcome(ensemble.outcomes));
  return { ensemble, matrix, top, mostLikely, lambdaHome, lambdaAway, outcomes: ensemble.outcomes };
}

function estimateRhoLike(context: MatchContext): number {
  // Identique à index.ts : ρ ajusté sur les matchs des deux équipes.
  const fixtures = [...context.home.seasonMatches, ...context.away.seasonMatches].map((m) => ({
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    lambdaHome: context.leagueBaseline.homeGoalsPerMatch,
    lambdaAway: context.leagueBaseline.awayGoalsPerMatch,
  }));
  return fitRho(fixtures);
}

// fitDixonColesRho n'est pas exporté par math : approximation identique au
// moteur via la fonction exportée depuis l'ancien moteur (même code).
import { fitDixonColesRho as fitRho } from "@/server/engine/math";

function pickOutcome(p: { home: number; draw: number; away: number }): Outcome {
  if (p.home >= p.draw && p.home >= p.away) return "HOME_WIN";
  if (p.away >= p.draw && p.away >= p.home) return "AWAY_WIN";
  return "DRAW";
}

function pickM23(
  entries: { score: string; probability: number }[],
  lambdaHome: number,
  lambdaAway: number,
  pick: Outcome,
) {
  const first = entries[0];
  const isConsistent = (e: { score: string }) => {
    const [h, a] = e.score.split("-").map(Number);
    return pick === "HOME_WIN" ? h > a : pick === "AWAY_WIN" ? h < a : h === a;
  };
  const plateau = entries.filter((e) => e.probability >= first.probability * 0.92);
  const consistent = plateau.filter(isConsistent);
  const pool = consistent.length > 0 ? consistent : plateau;
  let best = pool[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of pool) {
    const [h, a] = e.score.split("-").map(Number);
    const dist = Math.abs(h - lambdaHome) + Math.abs(a - lambdaAway);
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
}

// --- formModel LEGACY : points inversés (bug matchOutcome) -----------------
// Duplication fidèle de formModel, seule la fonction de points change.

function pointsForLegacy(match: MatchRecord, teamId: string): number {
  const gf = match.homeTeamId === teamId ? match.homeGoals : match.awayGoals;
  const ga = match.homeTeamId === teamId ? match.awayGoals : match.homeGoals;
  if (gf > ga) return 3;
  if (gf < ga) return 1; // BUG historique : défaite comptée 1 point
  return 0;
}

function formModelLegacy(ctx: ReturnType<typeof buildModelContext>): ModelPrediction {
  const homeRecent = ctx.home.seasonMatches.slice(0, 6);
  const awayRecent = ctx.away.seasonMatches.slice(0, 6);
  if (homeRecent.length < 3 || awayRecent.length < 3) {
    return {
      name: "form", version: "1.0.0", outcomes: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      expectedGoals: null, selfConfidence: 0, weight: 0, applicable: false,
      unavailableReason: "Moins de 3 matchs récents", signals: [],
    };
  }
  const homePpg = mean(homeRecent.map((m) => pointsForLegacy(m, ctx.home.identity.id)))!;
  const awayPpg = mean(awayRecent.map((m) => pointsForLegacy(m, ctx.away.identity.id)))!;
  const homeStrength = 0.65 + (homePpg / 3) * 0.7;
  const awayStrength = 0.65 + (awayPpg / 3) * 0.7;
  const lambdaHome = clamp(ctx.baseline.homeGoalsPerMatch * homeStrength * (2 - awayStrength) * 0.85 + 0.12, 0.15, 5.5);
  const lambdaAway = clamp(ctx.baseline.awayGoalsPerMatch * awayStrength * (2 - homeStrength) * 0.85 + 0.12, 0.15, 5.5);
  return {
    name: "form", version: "1.0.0",
    outcomes: outcomesFromLambdas(lambdaHome, lambdaAway, ctx.rho),
    expectedGoals: { home: lambdaHome, away: lambdaAway, total: lambdaHome + lambdaAway },
    selfConfidence: 0.42 + Math.min(0.2, (homeRecent.length + awayRecent.length) / 60),
    weight: 0, applicable: true, signals: [],
  };
}

function outcomesFromLambdas(lh: number, la: number, rho: number) {
  const matrix = buildScoreMatrix(lh, la, { rho });
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
    }
  const t = home + draw + away || 1;
  return { home: home / t, draw: draw / t, away: away / t };
}

// ---------------------------------------------------------------------------
// Métriques
// ---------------------------------------------------------------------------

interface Verdict {
  n: number;
  acc1x2: number;
  brier1x2: number;
  logloss1x2: number;
  accOu: number;
  brierOu: number;
  loglossOu: number;
  accBtts: number;
  brierBtts: number;
  loglossBtts: number;
  top1: number;
  top3: number;
  top5: number;
  pReel: number;
  logScore: number;
  distance: number;
  conc11: number;
  suggestions: Record<string, number>;
  correct1x2: boolean[];
  correctOu: boolean[];
  correctBtts: boolean[];
  correctTop1: boolean[];
  bins1x2: { sum: number; hits: number; count: number }[];
  binsOu: { sum: number; hits: number; count: number }[];
  binsBtts: { sum: number; hits: number; count: number }[];
  binsScore: { sum: number; hits: number; count: number }[];
}

function emptyVerdict(): Verdict {
  return {
    n: 0, acc1x2: 0, brier1x2: 0, logloss1x2: 0,
    accOu: 0, brierOu: 0, loglossOu: 0,
    accBtts: 0, brierBtts: 0, loglossBtts: 0,
    top1: 0, top3: 0, top5: 0, pReel: 0, logScore: 0, distance: 0, conc11: 0,
    suggestions: {},
    correct1x2: [], correctOu: [], correctBtts: [], correctTop1: [],
    bins1x2: mkBins(), binsOu: mkBins(), binsBtts: mkBins(), binsScore: mkBins(),
  };
}

function mkBins() {
  return Array.from({ length: 10 }, () => ({ sum: 0, hits: 0, count: 0 }));
}

function pushBin(bins: Verdict["bins1x2"], p: number, hit: boolean) {
  const i = Math.min(9, Math.max(0, Math.floor(p * 10)));
  bins[i].sum += p;
  bins[i].count += 1;
  if (hit) bins[i].hits += 1;
}

function feed(
  v: Verdict,
  r: {
    outcomes: { home: number; draw: number; away: number };
    matrix: number[][];
    top: { score: string; probability: number }[];
    mostLikely: { score: string; probability: number };
  },
  actual: { hg: number; ag: number },
) {
  v.n++;
  const outcome: Outcome = actual.hg > actual.ag ? "HOME_WIN" : actual.hg < actual.ag ? "AWAY_WIN" : "DRAW";
  const target = outcome === "HOME_WIN" ? [1, 0, 0] : outcome === "DRAW" ? [0, 1, 0] : [0, 0, 1];
  const p = [r.outcomes.home, r.outcomes.draw, r.outcomes.away];
  const actualIdx = outcome === "HOME_WIN" ? 0 : outcome === "DRAW" ? 1 : 2;
  v.brier1x2 += p.reduce((a, x, i) => a + (x - target[i]) ** 2, 0);
  v.logloss1x2 += -Math.log(Math.max(1e-15, Math.min(1 - 1e-15, p[actualIdx])));
  const predIdx = p.indexOf(Math.max(...p));
  const hit1x2 = predIdx === actualIdx;
  if (hit1x2) v.acc1x2 += 1;
  v.correct1x2.push(hit1x2);
  pushBin(v.bins1x2, p[predIdx], hit1x2);

  const total = actual.hg + actual.ag;
  const ou = overUnderProbability(r.matrix, 2.5);
  const actualOver = total > 2.5;
  const hitOu = (ou.over >= 0.5) === actualOver;
  if (hitOu) v.accOu += 1;
  v.brierOu += (ou.over - (actualOver ? 1 : 0)) ** 2;
  v.loglossOu += -Math.log(Math.max(1e-15, Math.min(1 - 1e-15, actualOver ? ou.over : ou.under)));
  v.correctOu.push(hitOu);
  pushBin(v.binsOu, Math.max(ou.over, ou.under), hitOu);

  const bt = bttsProbability(r.matrix);
  const actualBtts = actual.hg > 0 && actual.ag > 0;
  const hitBtts = (bt.yes >= 0.5) === actualBtts;
  if (hitBtts) v.accBtts += 1;
  v.brierBtts += (bt.yes - (actualBtts ? 1 : 0)) ** 2;
  v.loglossBtts += -Math.log(Math.max(1e-15, Math.min(1 - 1e-15, actualBtts ? bt.yes : bt.no)));
  v.correctBtts.push(hitBtts);
  pushBin(v.binsBtts, Math.max(bt.yes, bt.no), hitBtts);

  const actualScore = `${actual.hg}-${actual.ag}`;
  const rank = r.top.findIndex((s) => s.score === actualScore);
  const top1Hit = rank === 0 && r.mostLikely.score === actualScore;
  const mostHit = r.mostLikely.score === actualScore;
  if (mostHit) v.top1 += 1;
  v.correctTop1.push(mostHit);
  if (rank >= 0 && rank < 3) v.top3 += 1;
  if (rank >= 0 && rank < 5) v.top5 += 1;
  const pActual = rank >= 0 ? r.top[rank].probability : 0;
  v.pReel += pActual;
  v.logScore += -Math.log(Math.max(1e-15, pActual));
  const [mh, ma] = r.mostLikely.score.split("-").map(Number);
  v.distance += Math.abs(mh - actual.hg) + Math.abs(ma - actual.ag);
  v.suggestions[r.mostLikely.score] = (v.suggestions[r.mostLikely.score] ?? 0) + 1;
  if (r.mostLikely.score === "1-1") v.conc11 += 1;
  pushBin(v.binsScore, r.mostLikely.probability, mostHit);
  void top1Hit;
}

function finalize(v: Verdict) {
  const n = v.n || 1;
  return {
    sample: v.n,
    acc1x2: v.acc1x2 / n, brier1x2: v.brier1x2 / n, logloss1x2: v.logloss1x2 / n,
    accOu: v.accOu / n, brierOu: v.brierOu / n, loglossOu: v.loglossOu / n,
    accBtts: v.accBtts / n, brierBtts: v.brierBtts / n, loglossBtts: v.loglossBtts / n,
    top1: v.top1 / n, top3: v.top3 / n, top5: v.top5 / n,
    pReel: v.pReel / n, logScore: v.logScore / n, distance: v.distance / n,
    conc11: v.conc11 / n,
    suggestions: Object.entries(v.suggestions).sort((a, b) => b[1] - a[1]).slice(0, 12),
    bins1x2: v.bins1x2.filter((b) => b.count > 0).map((b) => ({ predicted: b.sum / b.count, observed: b.hits / b.count, count: b.count })),
    binsOu: v.binsOu.filter((b) => b.count > 0).map((b) => ({ predicted: b.sum / b.count, observed: b.hits / b.count, count: b.count })),
    binsBtts: v.binsBtts.filter((b) => b.count > 0).map((b) => ({ predicted: b.sum / b.count, observed: b.hits / b.count, count: b.count })),
    binsScore: v.binsScore.filter((b) => b.count > 0).map((b) => ({ predicted: b.sum / b.count, observed: b.hits / b.count, count: b.count })),
  };
}

// --- Significativité : McNemar exact (binomial) + IC Wilson ---------------

function mcnemar(a: boolean[], b: boolean[]): { b01: number; b10: number; p: number } {
  let b01 = 0, b10 = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) b10++;
    if (!a[i] && b[i]) b01++;
  }
  const n = b01 + b10;
  if (n === 0) return { b01, b10, p: 1 };
  // test binomial bilatéral : P(X >= max) * 2
  const k = Math.min(b01, b10);
  let p = 0;
  for (let i = 0; i <= k; i++) {
    p += binom(n, i) * Math.pow(0.5, n);
  }
  return { b01, b10, p: Math.min(1, p * 2) };
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function wilsonDiff(h1: number, n1: number, h2: number, n2: number) {
  const p1 = h1 / n1, p2 = h2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { diff: p1 - p2, lo95: p1 - p2 - 1.96 * se, hi95: p1 - p2 + 1.96 * se };
}

// ---------------------------------------------------------------------------
// Boucle principale
// ---------------------------------------------------------------------------

interface Row {
  league: string;
  hg: number;
  ag: number;
  v0: Verdict;
  a0: Verdict;
  a1: Verdict;
  bMinus: Verdict;
  bPlus: Verdict;
  v3: Verdict;
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
      id: true, utcDate: true, homeScore: true, awayScore: true,
      league: { select: { name: true } },
    },
    take: 500,
  });
}

async function runSample(fromDays: number, toDays: number, label: string) {
  const matches = await sampleMatches(fromDays, toDays);
  const rows: Row[] = [];
  let leak = 0;
  let withXg = 0, withSot = 0, complete = 0, missing = 0;

  for (const m of matches) {
    const { context } = await buildMatchContext(m.id, m.utcDate);
    if (!context) continue;
    // --- Anti-fuite strict ---
    const future = [...context.home.seasonMatches, ...context.away.seasonMatches, ...context.home.headToHead]
      .filter((mm) => mm.date.getTime() >= m.utcDate.getTime());
    if (future.length > 0) throw new Error(`FUITE DÉTECTÉE sur ${m.id}`);

    const hg = m.homeScore!, ag = m.awayScore!;
    const r: Row = { league: m.league.name, hg, ag, v0: emptyVerdict(), a0: emptyVerdict(), a1: emptyVerdict(), bMinus: emptyVerdict(), bPlus: emptyVerdict(), v3: emptyVerdict() };

    // v0 — moteur ancien complet
    const old = generatePredictionOld(context);
    feed(r.v0, { outcomes: old.outcomes, matrix: old.scoreMatrix, top: old.markets.exactScore.top.map((s) => ({ score: s.score, probability: s.probability })), mostLikely: { score: old.markets.exactScore.mostLikely.score, probability: old.markets.exactScore.mostLikely.probability } }, { hg, ag });

    // v3 — 84d8301 complet
    const cur = generatePrediction(context);
    feed(r.v3, { outcomes: cur.outcomes, matrix: cur.scoreMatrix, top: cur.markets.exactScore.top.map((s) => ({ score: s.score, probability: s.probability })), mostLikely: { score: cur.markets.exactScore.mostLikely.score, probability: cur.markets.exactScore.mostLikely.probability } }, { hg, ag });

    // Variantes intermédiaires — mêmes modèles, chaîne locale.
    const ctxM = buildModelContext(context.home, context.away, context.leagueBaseline, estimateRhoLike(context));
    const legacy = formModelLegacy(ctxM);
    const fixed = formModel(ctxM);

    const set = (fm: ModelPrediction, withShots: boolean) => {
      const models = [poissonModel(ctxM), statisticalModel(ctxM), xgModel(ctxM), ...(withShots ? [shotsModel(ctxM)] : []), homeAwayModel(ctxM), fm];
      return chain(context, models, "mode");
    };
    const cA0 = set(legacy, false);
    const cA1 = set(fixed, false);
    const cBMinus = cA1; // sans shots = A1 (même variante, effet B isolé ci-dessous)
    const cBPlus = set(fixed, true);

    const pack = (c: ReturnType<typeof chain>) => ({
      outcomes: c.outcomes, matrix: c.matrix, top: c.top, mostLikely: c.mostLikely,
    });
    feed(r.a0, pack(cA0), { hg, ag });
    feed(r.a1, pack(cA1), { hg, ag });
    feed(r.bMinus, pack(cBMinus), { hg, ag });
    feed(r.bPlus, pack(cBPlus), { hg, ag });

    // Couverture
    const homeM = context.home.seasonMatches;
    const hasXg = homeM.some((x) => x.homeXg !== null || x.awayXg !== null);
    const hasSot = homeM.some((x) => x.homeShotsOnTarget !== null || x.awayShotsOnTarget !== null);
    if (hasXg) withXg++;
    if (hasSot) withSot++;
    if (hasXg && hasSot && homeM.length >= 6) complete++;
    if (!hasSot) missing++;

    rows.push(r);
    leak++;
  }

  const vs: Record<string, Verdict> = { v0: emptyVerdict(), a0: emptyVerdict(), a1: emptyVerdict(), bMinus: emptyVerdict(), bPlus: emptyVerdict(), v3: emptyVerdict() };
  for (const r of rows) {
    for (const k of Object.keys(vs)) {
      const src = (r as never as Record<string, Verdict>)[k];
      const dst = vs[k];
      dst.n += src.n;
      dst.acc1x2 += src.acc1x2; dst.brier1x2 += src.brier1x2; dst.logloss1x2 += src.logloss1x2;
      dst.accOu += src.accOu; dst.brierOu += src.brierOu; dst.loglossOu += src.loglossOu;
      dst.accBtts += src.accBtts; dst.brierBtts += src.brierBtts; dst.loglossBtts += src.loglossBtts;
      dst.top1 += src.top1; dst.top3 += src.top3; dst.top5 += src.top5;
      dst.pReel += src.pReel; dst.logScore += src.logScore; dst.distance += src.distance;
      dst.conc11 += src.conc11;
      for (const [s, c] of Object.entries(src.suggestions)) dst.suggestions[s] = (dst.suggestions[s] ?? 0) + c;
      dst.correct1x2.push(...src.correct1x2); dst.correctOu.push(...src.correctOu);
      dst.correctBtts.push(...src.correctBtts); dst.correctTop1.push(...src.correctTop1);
      for (let i = 0; i < 10; i++) {
        for (const [bk, dk] of [["bins1x2", "bins1x2"], ["binsOu", "binsOu"], ["binsBtts", "binsBtts"], ["binsScore", "binsScore"]] as const) {
          (dst as never as Record<string, { sum: number; hits: number; count: number }[]>)[dk][i].sum += (src as never as Record<string, { sum: number; hits: number; count: number }[]>)[bk][i].sum;
          (dst as never as Record<string, { sum: number; hits: number; count: number }[]>)[dk][i].hits += (src as never as Record<string, { sum: number; hits: number; count: number }[]>)[bk][i].hits;
          (dst as never as Record<string, { sum: number; hits: number; count: number }[]>)[dk][i].count += (src as never as Record<string, { sum: number; hits: number; count: number }[]>)[bk][i].count;
        }
      }
    }
  }

  // Par compétition (v3 vs v0, 1X2)
  const byLeague: Record<string, { n: number; v0: number; v3: number; v3b: number; v3bt: number }> = {};
  for (const r of rows) {
    byLeague[r.league] ??= { n: 0, v0: 0, v3: 0, v3b: 0, v3bt: 0 };
    const e = byLeague[r.league];
    e.n++;
    if (r.v0.correct1x2[0]) e.v0++;
    if (r.v3.correct1x2[0]) e.v3++;
    e.v3b += r.v3.brier1x2;
    e.v3bt += r.v3.brierBtts;
  }

  return {
    label,
    fromDays, toDays,
    examined: matches.length,
    computed: leak,
    coverage: { withXg, withSot, complete, missing },
    metrics: Object.fromEntries(Object.entries(vs).map(([k, v]) => [k, finalize(v)])),
    mcnemar: {
      "1X2 v0→v3": mcnemar(vs.v0.correct1x2, vs.v3.correct1x2),
      "O/U v0→v3": mcnemar(vs.v0.correctOu, vs.v3.correctOu),
      "BTTS v0→v3": mcnemar(vs.v0.correctBtts, vs.v3.correctBtts),
      "Score top1 v0→v3": mcnemar(vs.v0.correctTop1, vs.v3.correctTop1),
      "1X2 A0→A1 (fix)": mcnemar(vs.a0.correct1x2, vs.a1.correct1x2),
      "1X2 A1→B+ (shots)": mcnemar(vs.a1.correct1x2, vs.bPlus.correct1x2),
      "O/U A1→B+ (shots)": mcnemar(vs.a1.correctOu, vs.bPlus.correctOu),
    },
    wilson: {
      "1X2 v0→v3": wilsonDiff(vs.v3.acc1x2, vs.v3.n, vs.v0.acc1x2, vs.v0.n),
      "O/U v0→v3": wilsonDiff(vs.v3.accOu, vs.v3.n, vs.v0.accOu, vs.v0.n),
      "BTTS v0→v3": wilsonDiff(vs.v3.accBtts, vs.v3.n, vs.v0.accBtts, vs.v0.n),
      "Score v0→v3": wilsonDiff(vs.v3.top1, vs.v3.n, vs.v0.top1, vs.v0.n),
      "O/U A1→B+": wilsonDiff(vs.bPlus.accOu, vs.bPlus.n, vs.a1.accOu, vs.a1.n),
    },
    byLeague: Object.fromEntries(
      Object.entries(byLeague).map(([k, e]) => [k, { n: e.n, acc_v0: e.v0 / e.n, acc_v3: e.v3 / e.n, brier_v3: e.v3b / e.n }]),
    ),
  };
}

async function main() {
  console.log("Mission 24 — validation (mesure seule)…");
  const principal = await runSample(45, 0, "PRINCIPAL (0-45 j — échantillon M22/M23)");
  console.log(`  principal : ${principal.computed} matchs`);
  const holdout = await runSample(135, 45, "HOLD-OUT (45-135 j — indépendant)");
  console.log(`  hold-out : ${holdout.computed} matchs`);

  const out = {
    generatedAt: new Date().toISOString(),
    engine: "84d8301",
    antiLeak: "0 fuite — contrôle systématique (contextes reconstruits asOf = date du match, aucun match du contexte >= coup d'envoi)",
    principal,
    holdout,
  };
  fs.writeFileSync("/tmp/audit-24.json", JSON.stringify(out, null, 2));
  console.log("→ /tmp/audit-24.json");
  await prisma.$disconnect();
}

main().catch((e) => { console.error("ÉCHEC:", e.message); process.exit(1); });
