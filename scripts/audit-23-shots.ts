/**
 * Mission 23 · Étape 2 — mesure de la valeur prédictive des tirs cadrés (SOT)
 * AVANT toute implémentation dans le moteur (règle : prouver la valeur d'abord).
 *
 * Lecture seule. Sortie : corrélations, taux de conversion, couverture.
 */

import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { prisma } from "@/lib/prisma";

function corr(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy || 1);
}

async function main() {
  const matches = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      homeScore: { not: null },
      awayScore: { not: null },
      liveData: { isNot: null },
    },
    select: {
      homeScore: true, awayScore: true,
      league: { select: { name: true } },
      liveData: {
        select: {
          homeShots: true, awayShots: true,
          homeShotsOnTarget: true, awayShotsOnTarget: true,
          homeXg: true, awayXg: true,
        },
      },
    },
    take: 20000,
  });

  const homeSot: number[] = [], homeGoals: number[] = [];
  const homeShots: number[] = [];
  const byLeague = new Map<string, { sot: number[]; goals: number[]; shots: number[] }>();
  let withSot = 0, withXg = 0, sotNoXg = 0, total = 0;

  for (const m of matches) {
    const d = m.liveData!;
    total++;
    const hasXg = d.homeXg !== null || d.awayXg !== null;
    if (hasXg) withXg++;
    const sotH = d.homeShotsOnTarget, shH = d.homeShots, gH = m.homeScore!;
    if (sotH !== null && shH !== null) {
      withSot++;
      if (!hasXg) sotNoXg++;
      homeSot.push(sotH);
      homeGoals.push(gH);
      homeShots.push(shH);
      const key = m.league.name;
      if (!byLeague.has(key)) byLeague.set(key, { sot: [], goals: [], shots: [] });
      byLeague.get(key)!.sot.push(sotH);
      byLeague.get(key)!.goals.push(gH);
      byLeague.get(key)!.shots.push(shH);
    }
  }

  console.log(`Échantillon : ${total} matchs avec liveData · avec SOT : ${withSot} · avec xG : ${withXg} · SOT sans xG : ${sotNoXg}`);
  console.log(`corr(SOT domicile, buts domicile) = ${corr(homeSot, homeGoals).toFixed(4)}`);
  console.log(`corr(TIRS domicile, buts domicile) = ${corr(homeShots, homeGoals).toFixed(4)}`);
  const convRate = homeGoals.reduce((a, b) => a + b, 0) / homeSot.reduce((a, b) => a + b, 0);
  console.log(`conversion SOT→but (global) = ${convRate.toFixed(3)} but / SOT`);
  console.log(`moyenne SOT domicile = ${(homeSot.reduce((a, b) => a + b, 0) / withSot).toFixed(2)} · buts = ${(homeGoals.reduce((a, b) => a + b, 0) / withSot).toFixed(2)}`);

  console.log("\nPar compétition (corr SOT↔buts, conversion, n) :");
  for (const [league, v] of [...byLeague.entries()].sort()) {
    if (v.sot.length < 30) continue;
    const c = corr(v.sot, v.goals);
    const conv = v.goals.reduce((a, b) => a + b, 0) / v.sot.reduce((a, b) => a + b, 0);
    console.log(`  ${league.padEnd(20)} corr=${c.toFixed(3)} conv=${conv.toFixed(3)} n=${v.sot.length}`);
  }

  // Pouvoir discriminant : un proxy lambda = a·SOT réduit-il l'erreur vs buts réels
  // par rapport à une constante (moyenne de ligue) ? Mesure de gain explicatif.
  let sseConst = 0, sseSot = 0;
  const gMean = homeGoals.reduce((a, b) => a + b, 0) / homeGoals.length;
  // régression simple SOT → buts (a·x + b) estimée par MC sur tout l'échantillon
  const n = homeSot.length;
  const mx = homeSot.reduce((a, b) => a + b, 0) / n;
  const my = gMean;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (homeSot[i] - mx) * (homeGoals[i] - my); sxx += (homeSot[i] - mx) ** 2; }
  const slope = sxy / (sxx || 1);
  const intercept = my - slope * mx;
  for (let i = 0; i < n; i++) {
    sseConst += (homeGoals[i] - gMean) ** 2;
    sseSot += (homeGoals[i] - (intercept + slope * homeSot[i])) ** 2;
  }
  console.log(`\nGain explicatif du proxy SOT : variance expliquée R² = ${(1 - sseSot / sseConst).toFixed(4)} (0 = aucune, 1 = parfaite)`);
  console.log(`proxy : buts ≈ ${slope.toFixed(3)}·SOT + ${intercept.toFixed(3)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error("ÉCHEC:", e.message); process.exit(1); });
