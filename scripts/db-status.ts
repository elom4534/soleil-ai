/**
 * Diagnostic factuel de la chaîne matchs (mission « absence de matchs »).
 * Lecture seule : totaux, statuts, rencontres à venir, prochaines prédictions.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const now = new Date();
  const total = await prisma.match.count();
  const upcoming = await prisma.match.count({ where: { utcDate: { gt: now }, status: "SCHEDULED" } });
  const finished = await prisma.match.count({ where: { status: "FINISHED" } });
  const predTotal = await prisma.prediction.count();
  const predPublished = await prisma.prediction.count({ where: { status: "PUBLISHED" } });
  const upcomingPublished = await prisma.prediction.count({
    where: { status: "PUBLISHED", match: { utcDate: { gt: now }, status: "SCHEDULED" } },
  });

  console.log(JSON.stringify({ now: now.toISOString(), total, upcoming, finished, predTotal, predPublished, upcomingPublished }, null, 2));

  const next = await prisma.match.findMany({
    where: { utcDate: { gt: now }, status: "SCHEDULED" },
    orderBy: { utcDate: "asc" },
    take: 5,
    include: {
      predictions: { select: { status: true, modelVersion: true }, take: 3 },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  for (const m of next) {
    console.log(
      `   ${m.utcDate.toISOString().slice(0, 16)} · ${m.homeTeam?.name ?? "?"} – ${m.awayTeam?.name ?? "?"} · ` +
        `statut=${m.status} · prédictions=${m.predictions.map((p) => `${p.status}`).join(",") || "aucune"}`,
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERREUR " + String((e as Error).message).slice(0, 200));
  process.exit(1);
});
