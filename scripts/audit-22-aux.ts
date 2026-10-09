/**
 * SOLEIL — Mission 22 · Mesures complémentaires (LECTURE SEULE)
 *
 *  §6  données stockées mais non consommées par le moteur
 *  §9  analyse détaillée du score exact
 *  §13 qualité des données
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

async function main() {
  // -------------------------------------------------------------------------
  // §6 — Couverture réelle des données stockées
  // -------------------------------------------------------------------------
  const live = await prisma.matchLiveData.findMany({
    select: {
      homePossession: true, awayPossession: true,
      homeRedCards: true, awayRedCards: true,
      homeXg: true, homeShots: true, homeCorners: true, homeYellowCards: true,
    },
    take: 50000,
  });
  const nn = (v: unknown) => v !== null && v !== undefined;
  const liveCount = live.length;
  const coverage = (fn: (r: (typeof live)[0]) => boolean) => live.filter(fn).length;

  const teamStats = await prisma.teamStatistics.count().catch(() => -1);
  const teamForm = await prisma.teamForm.count().catch(() => -1);
  const h2hTable = await prisma.headToHead.count().catch(() => -1);
  const strengths = await prisma.teamStrengthScore.count().catch(() => -1);
  // Les données premium contextuelles (blessures, compos, managers, stades)
  // ne sont PAS dans le schéma Prisma : elles vivent dans stats-cache/*.ndjson.
  const cacheFiles: { file: string; lines: number }[] = [];
  for (const dir of ["stats-cache"]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".ndjson")) continue;
        const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).length;
        cacheFiles.push({ file: f, lines });
      }
    } catch { cacheFiles.push({ file: "(absent)", lines: -1 }); }
  }

  // -------------------------------------------------------------------------
  // §9 — Score exact : rang du score réel, distribution des buts
  // -------------------------------------------------------------------------
  const matches = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { gte: new Date(Date.now() - 45 * 86_400_000) },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    select: {
      id: true, utcDate: true, homeScore: true, awayScore: true,
      league: { select: { name: true } },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
    take: 400,
    orderBy: { utcDate: "desc" },
  });

  let rankSum = 0, top1Hit = 0, top3Hit = 0, n = 0;
  const actualGoalsDist = new Map<string, number>();
  const topScoreDist = new Map<string, number>();
  const rankBuckets = { "1er": 0, "2-3": 0, "4-10": 0, ">10": 0 };
  const probActual: number[] = [];

  for (const m of matches) {
    const { context } = await buildMatchContext(m.id, m.utcDate);
    if (!context) continue;
    const result = generatePrediction(context);
    if (!result.publishable) continue;
    n++;
    const hg = m.homeScore!, ag = m.awayScore!;
    actualGoalsDist.set(`${hg}-${ag}`, (actualGoalsDist.get(`${hg}-${ag}`) ?? 0) + 1);
    topScoreDist.set(result.markets.exactScore.mostLikely.score, (topScoreDist.get(result.markets.exactScore.mostLikely.score) ?? 0) + 1);
    // Rang du score réel dans la matrice (tri décroissant).
    const flat: { s: string; p: number }[] = [];
    for (let h = 0; h < result.scoreMatrix.length; h++)
      for (let a = 0; a < result.scoreMatrix[h].length; a++)
        flat.push({ s: `${h}-${a}`, p: result.scoreMatrix[h][a] });
    flat.sort((x, y) => y.p - x.p);
    const rank = flat.findIndex((e) => e.s === `${hg}-${ag}`) + 1;
    rankSum += rank;
    if (rank === 1) top1Hit++;
    if (rank <= 3) top3Hit++;
    if (rank === 1) rankBuckets["1er"]++;
    else if (rank <= 3) rankBuckets["2-3"]++;
    else if (rank <= 10) rankBuckets["4-10"]++;
    else rankBuckets[">10"]++;
    probActual.push(flat.find((e) => e.s === `${hg}-${ag}`)!.p);
  }

  // -------------------------------------------------------------------------
  // §13 — Qualité : dates incohérentes, statuts, scores impossibles
  // -------------------------------------------------------------------------
  const futureFinished = await prisma.match.count({
    where: { status: "FINISHED", utcDate: { gt: new Date() } },
  });
  const scheduledPast = await prisma.match.count({
    where: { status: "SCHEDULED", utcDate: { lt: new Date(Date.now() - 3 * 86_400_000) } },
  });
  const negScore = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM "Match" WHERE "homeScore" < 0 OR "awayScore" < 0`.catch(() => [{ c: BigInt(-1) }]);
  const liveBefore = await prisma.matchLiveData.count({
    where: { match: { utcDate: { gt: new Date() } }, homeShots: { not: null } },
  });

  const distSorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const out = {
    couvertureStockee: {
      matchLiveData_total: liveCount,
      possession: coverage((r) => nn(r.homePossession)),
      cartons_rouges: coverage((r) => nn(r.homeRedCards) || nn(r.awayRedCards)),
      xG: coverage((r) => nn(r.homeXg)),
      tirs: coverage((r) => nn(r.homeShots)),
      corners: coverage((r) => nn(r.homeCorners)),
      cartons_jaunes: coverage((r) => nn(r.homeYellowCards)),
      tables: {
        TeamStatistics: teamStats, TeamForm: teamForm, HeadToHead: h2hTable,
        TeamStrengthScore: strengths,
        cache_fichiers_premium: cacheFiles,
      },
    },
    scoreExact: {
      sample: n,
      rang_moyen_score_reel: Math.round((rankSum / n) * 100) / 100,
      score_reel_au_rang_1: top1Hit,
      score_reel_dans_top3: top3Hit,
      rangs: rankBuckets,
      proba_score_reel_moyenne: Math.round((probActual.reduce((a, b) => a + b, 0) / n) * 10000) / 10000,
      scores_reels_observes: distSorted(actualGoalsDist),
      scores_predits_top1: distSorted(topScoreDist),
    },
    qualite: {
      finished_avec_date_future: futureFinished,
      scheduled_depuis_3j: scheduledPast,
      scores_negatifs: Number(negScore[0]?.c ?? -1),
      stats_live_sur_matchs_futurs: liveBefore,
    },
  };

  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync("/tmp/audit-22-aux.json", JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ÉCHEC:", e.message);
  process.exit(1);
});
