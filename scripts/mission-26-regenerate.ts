/**
 * SOLEIL — Mission 26 · Régénération des prédictions après recalibration
 *
 * Bascule `1.0.0-matrix-ensemble` → `1.0.1-calibrated` : toutes les prédictions
 * de matchs À VENIR (SCHEDULED) sont recalculées avec le moteur calibré.
 *  - Les prédictions SETTLED ne sont JAMAIS touchées (règle M17).
 *  - Aucun crédit API consommé (aucun appel réseau — contextes locaux).
 *  - Les matchs commencés/finis ne sont pas concernés.
 *
 * Sortie : compteurs console (créées / recalculées / SETTLED protégées).
 */

import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { prisma } from "@/lib/prisma";
import { generateAndPersist } from "@/server/predictions/service";

async function main() {
  console.log("Mission 26 — régénération des prédictions (1.0.1-calibrated)");
  const upcoming = await prisma.match.findMany({
    where: { status: "SCHEDULED", utcDate: { gt: new Date() } },
    orderBy: { utcDate: "asc" },
    take: 200,
    select: { id: true },
  });
  let settled = 0;
  let regenerated = 0;
  let published = 0;
  let skipped = 0;
  for (const match of upcoming) {
    const existing = await prisma.prediction.findFirst({
      where: { matchId: match.id },
      orderBy: { generatedAt: "desc" },
      select: { id: true, status: true },
    });
    if (existing?.status === "SETTLED") {
      settled += 1;
      continue;
    }
    const outcome = await generateAndPersist(match.id, { asOf: new Date() });
    if (outcome.status === "skipped") {
      skipped += 1;
      continue;
    }
    regenerated += 1;
    if (outcome.status === "published") published += 1;
  }
  const agg = await prisma.prediction.groupBy({ by: ["modelVersion"], _count: true });
  console.log(`  matchs à venir : ${upcoming.length}`);
  console.log(`  SETTLED protégées : ${settled} · régénérées : ${regenerated} (dont ${published} publiées) · ignorées : ${skipped}`);
  console.log(`  versions en base : ${agg.map((a) => `${a.modelVersion}=${a._count}`).join(" · ")}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
