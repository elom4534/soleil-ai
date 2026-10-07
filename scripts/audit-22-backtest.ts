/**
 * SOLEIL — Mission 22 · Audit scientifique (MESURE UNIQUEMENT)
 *
 * Backtest hors-ligne sur matchs historiques récents :
 *   pour chaque match FINISHED, on reconstruit le contexte COMME IL ÉTAIT
 *   AVANT le coup d'envoi (asOf = utcDate du match), on exécute le moteur
 *   inchangé, et on compare aux résultats réellement observés.
 *
 * ⚠️ Ce script ne modifie RIEN : aucune écriture en base, aucun changement
 *    du moteur. Sortie : JSON + résumé texte.
 */

import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { prisma } from "@/lib/prisma";
import { buildMatchContext } from "@/server/predictions/context";
import { generatePrediction, evaluatePredictions } from "@/server/engine";
import type { MatchContext, PredictionResult } from "@/server/engine/types";

// ---------------------------------------------------------------------------
// 1 — Échantillon : matchs joués récemment (résultats connus)
// ---------------------------------------------------------------------------

const DAYS = Number(process.env.AUDIT_DAYS ?? 45);
const LEAGUE_NAMES = [
  "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1",
  "UCL", "UEL", "UNL", "CCNL",
];

interface Row {
  matchId: string;
  date: string;
  league: string;
  home: string;
  away: string;
  actualGoals: [number, number];
  actualHt: [number, number] | null;
  actualOutcome: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  context: {
    homeMatches: number;
    awayMatches: number;
    homeRecent6: string[]; // dates des 6 derniers matchs (examen récence)
    h2h: number;
    homeWithXg: number;
    awayWithXg: number;
    homeWithShots: number;
    homeWithCorners: number;
    baselineSample: number;
    sources: string[];
  };
  prediction: {
    publishable: boolean;
    blockingReason?: string;
    outcomes: { home: number; draw: number; away: number };
    consensusPick: "HOME_WIN" | "DRAW" | "AWAY_WIN";
    xgModelApplicable: boolean;
    poissonApplicable: boolean;
    statisticalApplicable: boolean;
    formApplicable: boolean;
    homeAwayApplicable: boolean;
    confidence: number;
    agreement: number;
    lambdaHome: number;
    lambdaAway: number;
    // Marchés
    ou25Over: number;
    ou25Under: number;
    bttsYes: number;
    topScore: string;
    topScoreProb: number;
    probActualScore: number;
    probActualOutcome: number;
  } | null;
}

function contextStats(ctx: MatchContext) {
  const countWith = (matches: MatchContext["home"]["seasonMatches"], field: "xg" | "shots" | "corners") => {
    return matches.filter((m) => {
      if (field === "xg") return m.homeXg !== null || m.awayXg !== null;
      if (field === "shots") return m.homeShots !== null || m.awayShots !== null;
      return m.homeCorners !== null || m.awayCorners !== null;
    }).length;
  };
  const sources = new Set<string>();
  for (const m of [...ctx.home.seasonMatches, ...ctx.away.seasonMatches]) sources.add(m.source);
  return {
    homeMatches: ctx.home.seasonMatches.length,
    awayMatches: ctx.away.seasonMatches.length,
    homeRecent6: ctx.home.seasonMatches.slice(0, 6).map((m) => m.date.toISOString().slice(0, 10)),
    h2h: ctx.home.headToHead.length,
    homeWithXg: countWith(ctx.home.seasonMatches, "xg"),
    awayWithXg: countWith(ctx.away.seasonMatches, "xg"),
    homeWithShots: countWith(ctx.home.seasonMatches, "shots"),
    homeWithCorners: countWith(ctx.home.seasonMatches, "corners"),
    baselineSample: ctx.leagueBaseline.sampleSize,
    sources: [...sources],
  };
}

function probOf(matrix: number[][], hg: number, ag: number) {
  return matrix[hg]?.[ag] ?? 0;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const matches = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { gte: since },
      homeScore: { not: null },
      awayScore: { not: null },
      league: { name: { in: LEAGUE_NAMES } },
    },
    orderBy: { utcDate: "desc" },
    select: {
      id: true, utcDate: true,
      homeScore: true, awayScore: true,
      halfTimeHomeScore: true, halfTimeAwayScore: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
    },
    take: 400,
  });

  console.log(`Échantillon : ${matches.length} matchs FINISHED depuis ${DAYS} jours\n`);

  const rows: Row[] = [];
  let leakChecked = 0;

  for (const m of matches) {
    // Vérification anti-fuite : le contexte est reconstruit à la date du match.
    const asOf = m.utcDate;
    const { context } = await buildMatchContext(m.id, asOf);
    if (!context) continue;
    leakChecked++;

    // Contrôle de fuite explicite : aucun match du contexte >= coup d'envoi.
    const future = [...context.home.seasonMatches, ...context.away.seasonMatches].filter(
      (mm) => mm.date.getTime() >= asOf.getTime(),
    );
    if (future.length > 0) throw new Error(`FUITE DÉTECTÉE sur ${m.id}`);

    const result: PredictionResult = generatePrediction(context);
    const actualOutcome: "HOME_WIN" | "DRAW" | "AWAY_WIN" =
      m.homeScore! > m.awayScore! ? "HOME_WIN" : m.homeScore! < m.awayScore! ? "AWAY_WIN" : "DRAW";

    const top = result.markets.exactScore.mostLikely;
    const ou25 = result.markets.totalGoals.find((l) => l.line === 2.5)!;

    rows.push({
      matchId: m.id,
      date: m.utcDate.toISOString(),
      league: m.league.name,
      home: m.homeTeam.name,
      away: m.awayTeam.name,
      actualGoals: [m.homeScore!, m.awayScore!],
      actualHt: m.halfTimeHomeScore !== null ? [m.halfTimeHomeScore, m.halfTimeAwayScore!] : null,
      actualOutcome,
      context: contextStats(context),
      prediction: result.publishable
        ? {
            publishable: result.publishable,
            outcomes: result.outcomes,
            consensusPick: result.consensusPick,
            xgModelApplicable: result.consensus.models.find((x) => x.name === "xg")?.applicable ?? false,
            poissonApplicable: result.consensus.models.find((x) => x.name === "poisson")?.applicable ?? false,
            statisticalApplicable: result.consensus.models.find((x) => x.name === "statistical")?.applicable ?? false,
            formApplicable: result.consensus.models.find((x) => x.name === "form")?.applicable ?? false,
            homeAwayApplicable: result.consensus.models.find((x) => x.name === "home_away")?.applicable ?? false,
            confidence: result.confidence.score,
            agreement: result.consensus.agreement,
            lambdaHome: result.expectedGoals.home,
            lambdaAway: result.expectedGoals.away,
            ou25Over: ou25.over,
            ou25Under: ou25.under,
            bttsYes: result.markets.bothTeamsToScore.yes,
            topScore: top.score,
            topScoreProb: top.probability,
            probActualScore: probOf(result.scoreMatrix, m.homeScore!, m.awayScore!),
            probActualOutcome:
              actualOutcome === "HOME_WIN"
                ? result.outcomes.home
                : actualOutcome === "DRAW"
                  ? result.outcomes.draw
                  : result.outcomes.away,
          }
        : { publishable: false, blockingReason: result.blockingReason, outcomes: { home: 0, draw: 0, away: 0 }, consensusPick: "DRAW", xgModelApplicable: false, poissonApplicable: false, statisticalApplicable: false, formApplicable: false, homeAwayApplicable: false, confidence: result.confidence.score, agreement: result.consensus.agreement, lambdaHome: result.expectedGoals.home, lambdaAway: result.expectedGoals.away, ou25Over: 0, ou25Under: 0, bttsYes: 0, topScore: "-", topScoreProb: 0, probActualScore: 0, probActualOutcome: 0 },
    });
  }

  // ---------------------------------------------------------------------
  // 2 — Métriques
  // ---------------------------------------------------------------------
  const published = rows.filter((r) => r.prediction?.publishable);
  const entries = published.map((r) => ({
    probabilities: r.prediction!.outcomes,
    actual: r.actualOutcome,
  }));
  const metrics = entries.length ? evaluatePredictions(entries) : null;

  // Over/Under 2.5
  let ou25Hits = 0, ou25Brier = 0;
  for (const r of published) {
    const actualOver = r.actualGoals[0] + r.actualGoals[1] > 2.5;
    const predOver = r.prediction!.ou25Over >= 0.5;
    if (actualOver === predOver) ou25Hits++;
    const pOver = r.prediction!.ou25Over;
    ou25Brier += (pOver - (actualOver ? 1 : 0)) ** 2;
  }

  // BTTS
  let bttsHits = 0, bttsBrier = 0;
  for (const r of published) {
    const actualBtts = r.actualGoals[0] > 0 && r.actualGoals[1] > 0;
    const predBtts = r.prediction!.bttsYes >= 0.5;
    if (actualBtts === predBtts) bttsHits++;
    const p = r.prediction!.bttsYes;
    bttsBrier += (p - (actualBtts ? 1 : 0)) ** 2;
  }

  // Score exact
  let exactHits = 0, distanceSum = 0, probActualSum = 0, logScore = 0;
  for (const r of published) {
    const [topH, topA] = r.prediction!.topScore.split("-").map(Number);
    if (topH === r.actualGoals[0] && topA === r.actualGoals[1]) exactHits++;
    distanceSum += Math.abs(topH - r.actualGoals[0]) + Math.abs(topA - r.actualGoals[1]);
    probActualSum += r.prediction!.probActualScore;
    logScore += -Math.log(Math.max(1e-15, r.prediction!.probActualScore));
  }

  // Par compétition
  const byLeague: Record<string, { n: number; hits: number; brier: number[] }> = {};
  for (const r of published) {
    byLeague[r.league] ??= { n: 0, hits: 0, brier: [] };
    byLeague[r.league].n++;
    if (r.prediction!.consensusPick === r.actualOutcome) byLeague[r.league].hits++;
    const t = r.actualOutcome === "HOME_WIN" ? [1, 0, 0] : r.actualOutcome === "DRAW" ? [0, 1, 0] : [0, 0, 1];
    const p = [r.prediction!.outcomes.home, r.prediction!.outcomes.draw, r.prediction!.outcomes.away];
    byLeague[r.league].brier.push(p.reduce((a, v, i) => a + (v - t[i]) ** 2, 0));
  }

  // Disponibilité des données dans les contextes
  const availability = {
    matches: rows.length,
    avgHomeMatches: avg(rows.map((r) => r.context.homeMatches)),
    avgAwayMatches: avg(rows.map((r) => r.context.awayMatches)),
    avgH2h: avg(rows.map((r) => r.context.h2h)),
    withXg: rows.filter((r) => r.context.homeWithXg > 0).length,
    withShots: rows.filter((r) => r.context.homeWithShots > 0).length,
    withCorners: rows.filter((r) => r.context.homeWithCorners > 0).length,
    sources: [...new Set(rows.flatMap((r) => r.context.sources))],
    avgBaselineSample: avg(rows.map((r) => r.context.baselineSample)),
  };

  // Récence : les matchs récents sont-ils bien les premiers du contexte ?
  const recency = rows.slice(0, 40).map((r) => ({
    match: `${r.home} – ${r.away}`,
    date: r.date.slice(0, 10),
    last6: r.context.homeRecent6,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    sample: { days: DAYS, total: rows.length, published: published.length, unpublishable: rows.length - published.length, leakChecked },
    metrics1x2: metrics,
    overUnder25: { sample: published.length, accuracy: published.length ? ou25Hits / published.length : null, brierScore: published.length ? ou25Brier / published.length : null },
    btts: { sample: published.length, accuracy: published.length ? bttsHits / published.length : null, brierScore: published.length ? bttsBrier / published.length : null },
    exactScore: {
      sample: published.length,
      accuracy: published.length ? exactHits / published.length : null,
      avgDistance: published.length ? distanceSum / published.length : null,
      probActualScoreAvg: published.length ? probActualSum / published.length : null,
      logScore: published.length ? logScore / published.length : null,
    },
    byLeague: Object.fromEntries(
      Object.entries(byLeague).map(([k, v]) => [
        k,
        { sample: v.n, accuracy: v.hits / v.n, brierScore: v.brier.reduce((a, b) => a + b, 0) / v.brier.length },
      ]),
    ),
    availability,
    recency,
    rows,
  };

  fs.writeFileSync("/tmp/audit-22.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, rows: undefined, recency: report.recency.slice(0, 5) }, null, 2).slice(0, 6000));
  console.log("\n→ rapport complet : /tmp/audit-22.json");
  await prisma.$disconnect();
}

function avg(v: number[]) {
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : 0;
}

main().catch((e) => {
  console.error("ÉCHEC:", e.message);
  process.exit(1);
});
