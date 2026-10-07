/**
 * SOLEIL — Mission 26 · Collecte des tuples (probabilités, issue) pour le FIT
 * de la recalibration 1X2. MESURE UNIQUEMENT — aucune écriture.
 *
 * Discipline (§21 M25) :
 *  - Série A (0-270 j)  = jeu d'AJUSTEMENT du calibrateur (uniquement).
 *  - Série B (270-600 j) = jeu de VALIDATION — jamais utilisé pour le fit.
 *  - Anti-fuite identique à l'audit-25 : contextes reconstruits pré-coup
 *    d'envoi ; toute stat >= kickoff = ARRÊT immédiat (0 fuite exigée).
 *
 * Sortie : /tmp/m26-data.json { antiLeak, principal: [...], holdout: [...] }
 * avec pour chaque observation : p (home/draw/away publiés), pred, actual,
 * league, date.
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

interface Obs {
  id: string;
  p: { home: number; draw: number; away: number };
  pred: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  actual: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  league: string;
  date: string;
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
      id: true,
      utcDate: true,
      homeScore: true,
      awayScore: true,
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
    const hg = m.homeScore!;
    const ag = m.awayScore!;
    obs.push({
      id: m.id,
      p: { home: r.outcomes.home, draw: r.outcomes.draw, away: r.outcomes.away },
      pred: r.consensusPick,
      actual: hg > ag ? "HOME_WIN" : hg < ag ? "AWAY_WIN" : "DRAW",
      league: m.league.name,
      date: m.utcDate.toISOString(),
    });
  }
  return { obs, examined: matches.length, leak, excluded };
}

async function main() {
  console.log("Mission 26 — collecte des tuples de fit/validation…");
  const principal = await collect(270, 0, 3000);
  console.log(`  principal (A, fit) : ${principal.obs.length} obs — examinés ${principal.examined} — fuites ${principal.leak} — exclus ${JSON.stringify(principal.excluded)}`);
  const holdout = await collect(600, 270, 2000);
  console.log(`  hold-out  (B, val)  : ${holdout.obs.length} obs — examinés ${holdout.examined} — fuites ${holdout.leak} — exclus ${JSON.stringify(holdout.excluded)}`);

  if (principal.leak > 0 || holdout.leak > 0) throw new Error("FUITE — sortie non écrite");

  const out = {
    generatedAt: new Date().toISOString(),
    engine: "1.0.0-matrix-ensemble (avant recalibration)",
    antiLeak: {
      principal: { examines: principal.examined, valides: principal.obs.length, fuites: principal.leak, exclus: principal.excluded },
      holdout: { examines: holdout.examined, valides: holdout.obs.length, fuites: holdout.leak, exclus: holdout.excluded },
    },
    principal: principal.obs,
    holdout: holdout.obs,
  };
  fs.writeFileSync("/tmp/m26-data.json", JSON.stringify(out));
  console.log("→ /tmp/m26-data.json");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
