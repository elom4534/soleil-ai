/**
 * SOLEIL — Audit score exact (LECTURE SEULE — aucune écriture)
 *
 * Questions :
 *  1. La matrice contient-elle les scores élevés (3-2, 4-1, 4-2, 3-3, 5-2…) ?
 *  2. Quelles probabilités réelles sur plusieurs matchs à venir ?
 *  3. Présents mais à proba individuelle faible ?
 *  4. Règle d'affichage limitant les scores montrés ?
 *  5. Le Top score affiché = argmax de probabilité ?
 *  6. La recalibration 1.0.1-calibrated a-t-elle touché la matrice ?
 *     → comparaison numérique ancien (1.0.0) / nouveau moteur, mêmes contextes.
 *
 * Aucune écriture DB, aucune persistance, aucune modification de prédiction.
 * Sortie : /tmp/audit-27.json + tableau console.
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

const HIGH = ["3-2", "4-1", "4-2", "3-3", "5-2", "5-1", "4-3", "5-3", "4-4", "3-4", "2-5"];

interface Cell {
  score: string;
  home: number;
  away: number;
  probability: number;
}

function fullRanking(matrix: number[][]): Cell[] {
  const cells: Cell[] = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      cells.push({ score: `${h}-${a}`, home: h, away: a, probability: matrix[h]![a]! });
    }
  }
  return cells.sort((x, y) => y.probability - x.probability);
}

async function main() {
  console.log("Audit score exact — LECTURE SEULE\n");

  const matches = await prisma.match.findMany({
    where: { status: "SCHEDULED", utcDate: { gt: new Date() } },
    orderBy: { utcDate: "asc" },
    take: 6,
    select: {
      id: true,
      utcDate: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
    },
  });

  const report: unknown[] = [];

  for (const m of matches) {
    const { context } = await buildMatchContext(m.id, m.utcDate);
    if (!context) {
      console.log(`  ${m.homeTeam.name} - ${m.awayTeam.name} : contexte indisponible`);
      continue;
    }
    const r = generatePrediction(context) as unknown as {
      expectedGoals: { home: number; away: number; total: number };
      scoreMatrix: number[][];
      outcomes: { home: number; draw: number; away: number };
      consensusPick: string;
      markets: {
        exactScore: {
          mostLikely: { score: string; probability: number };
          top: Cell[];
        };
      };
    };
    const oldR = generatePredictionOld(context) as unknown as typeof r;

    const ranking = fullRanking(r.scoreMatrix);
    const top10 = r.markets.exactScore.top;
    const most = r.markets.exactScore.mostLikely;
    const argmax = ranking[0]!;

    // Q5 — le score affiché est-il l'argmax ?
    const isArgmax = most.score === argmax.score;

    // Q1-3 — rang réel (sur 121 cases) et proba des scores élevés.
    const highScores = HIGH.map((sc) => {
      const rank = ranking.findIndex((c) => c.score === sc);
      const cell = ranking.find((c) => c.score === sc)!;
      return {
        score: sc,
        probability: cell.probability,
        rank: rank + 1, // 1 = plus probable
        inTop10: rank < 10,
        inTop8: rank < 8,
        inTop3: rank < 3,
      };
    });

    // Masse cumulée : scores « élevés » (au moins 3 buts pour une équipe,
    // ou 5 buts au total), et cellules 0-5 x 0-5.
    const massHighTeam = ranking
      .filter((c) => (c.home >= 3 && c.away >= 2) || (c.home >= 2 && c.away >= 3) || c.home >= 4 || c.away >= 4)
      .reduce((s, c) => s + c.probability, 0);
    const mass5Plus = r.markets ? ranking.filter((c) => c.home + c.away >= 5).reduce((s, c) => s + c.probability, 0) : 0;

    // Sous-matrice 0-0 → 5-5 (comme demandé).
    const grid5x5: { score: string; p: number }[] = [];
    for (let h = 0; h <= 5; h++) {
      for (let a = 0; a <= 5; a++) {
        grid5x5.push({ score: `${h}-${a}`, p: r.scoreMatrix[h]![a]! });
      }
    }

    // Q6 — la matrice a-t-elle bougé avec la recalibration ? (non attendu)
    const oldRanking = fullRanking(oldR.scoreMatrix);
    let maxMatrixDiff = 0;
    for (let h = 0; h < r.scoreMatrix.length; h++) {
      for (let a = 0; a < r.scoreMatrix[h]!.length; a++) {
        maxMatrixDiff = Math.max(maxMatrixDiff, Math.abs(r.scoreMatrix[h]![a]! - oldR.scoreMatrix[h]![a]!));
      }
    }
    const oldMost = oldR.markets.exactScore.mostLikely;
    const top10Identical =
      top10.length === oldR.markets.exactScore.top.length &&
      top10.every((s, i) => s.score === oldR.markets.exactScore.top[i]!.score && Math.abs(s.probability - oldR.markets.exactScore.top[i]!.probability) < 1e-15);
    const rankingIdentical = ranking.every((c, i) => c.score === oldRanking[i]!.score);
    // Le 1X2 publié, lui, diffère (c'est le but de M26) :
    const x2Differs = r.outcomes.home !== oldR.outcomes.home;

    const row = {
      match: `${m.homeTeam.name} - ${m.awayTeam.name}`,
      league: m.league.name,
      utcDate: m.utcDate.toISOString(),
      lambdaHome: r.expectedGoals.home,
      lambdaAway: r.expectedGoals.away,
      outcomes: r.outcomes,
      consensusPick: r.consensusPick,
      mostLikelyDisplayed: most,
      argmax,
      mostIsArgmax: isArgmax,
      pickRule: "plateau ≥ 92 % de l'argmax, cohérence avec le pick 1X2, tie-break proximité (λH, λA)",
      top10,
      highScores,
      massHighScores: massHighTeam,
      mass5PlusGoals: mass5Plus,
      grid00to55: grid5x5,
      matrixVsOld: {
        maxAbsDiff: maxMatrixDiff,
        top10Identical,
        rankingIdentical,
        mostLikelyIdentical: oldMost.score === most.score && Math.abs(oldMost.probability - most.probability) < 1e-15,
        x2Differs,
      },
    };
    report.push(row);

    console.log(`\n=== ${row.match} (${row.league}) — ${row.utcDate.slice(0, 10)} ===`);
    console.log(`  λ = ${r.expectedGoals.home.toFixed(2)} / ${r.expectedGoals.away.toFixed(2)} · 1X2 publiés = ${(r.outcomes.home * 100).toFixed(1)} / ${(r.outcomes.draw * 100).toFixed(1)} / ${(r.outcomes.away * 100).toFixed(1)} % · pick ${r.consensusPick}`);
    console.log(`  Top affiché : ${most.score} (p=${(most.probability * 100).toFixed(2)} %) · argmax matrice = ${argmax.score} (p=${(argmax.probability * 100).toFixed(2)} %) · = argmax ? ${isArgmax}`);
    console.log(`  Top-10 (persisté) : ${top10.map((s) => `${s.score} ${(s.probability * 100).toFixed(2)}%`).join(" · ")}`);
    for (const hs of highScores) {
      console.log(`    ${hs.score} : p=${(hs.probability * 100).toFixed(2)} % · rang ${hs.rank}/121 · top-10 ? ${hs.inTop10}`);
    }
    console.log(`  Masse scores « élevés » : ${(massHighTeam * 100).toFixed(1)} % · masse ≥ 5 buts : ${(mass5Plus * 100).toFixed(1)} %`);
    console.log(`  Matrice vs ancien moteur : maxDiff=${maxMatrixDiff} · top10 identique ? ${top10Identical} · classement identique ? ${rankingIdentical} · 1X2 diffère ? ${x2Differs}`);
    console.log(`  Grille 0-0→5-5 :`);
    for (let h = 0; h <= 5; h++) {
      const line = [];
      for (let a = 0; a <= 5; a++) {
        line.push(`${h}-${a} ${(r.scoreMatrix[h]![a]! * 100).toFixed(2)}`.padEnd(11));
      }
      console.log("    " + line.join(""));
    }
  }

  fs.writeFileSync("/tmp/audit-27.json", JSON.stringify(report, null, 1));
  console.log("\n→ /tmp/audit-27.json");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
