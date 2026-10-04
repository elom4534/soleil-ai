/**
 * ============================================================================
 * SOLEIL — Génération des prédictions historiques (Phase 14)
 * ============================================================================
 * Remplit la base avec de vraies prédictions **sans fuite temporelle** :
 * `buildMatchContext` ne lit que les rencontres STRICTEMENT antérieures à la
 * date du match (`utcDate: { lt: reference }`). Chaque prédiction est donc
 * exactement celle que le moteur aurait produite avant le coup d'envoi.
 *
 * 🔒 Aucun accès réseau, aucun crédit. Le moteur n'est pas modifié.
 *
 * Usage :
 *   npx tsx scripts/bootstrap-predictions.ts --limit 400
 *   npx tsx scripts/bootstrap-predictions.ts --limit 400 --competition E0
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { generateAndPersist, settlePredictions } from "../src/server/predictions/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const limit = Number(arg("--limit") ?? 300);
  const competition = arg("--competition");
  const daysBack = Number(arg("--daysBack") ?? 900);

  console.log("═".repeat(78));
  console.log("SOLEIL — PRÉDICTIONS HISTORIQUES (sans fuite, sans crédit)");
  console.log("═".repeat(78));

  const since = new Date(Date.now() - daysBack * 86_400_000);
  const matches = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      homeScore: { not: null },
      awayScore: { not: null },
      utcDate: { gte: since },
      ...(competition ? { league: { shortName: competition } } : {}),
      predictions: { none: { status: "SETTLED" } },
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    select: { id: true, utcDate: true },
  });

  console.log(`Rencontres retenues : ${matches.length} (les plus récentes depuis ${since.toISOString().slice(0, 10)})`);
  console.log("");

  let generated = 0;
  let published = 0;
  let withheld = 0;
  const started = Date.now();

  for (const [index, match] of matches.entries()) {
    try {
      const outcome = await generateAndPersist(match.id, { force: true });
      if (outcome.status === "skipped") {
        withheld += 1;
      } else {
        generated += 1;
        if (outcome.status === "published") published += 1;
      }
    } catch (error) {
      console.error(`  ⚠ ${match.id} : ${(error as Error).message}`);
    }

    if ((index + 1) % 50 === 0 || index === matches.length - 1) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${index + 1}/${matches.length} · générées ${generated} · publiées ${published} · ${elapsed} s`);
    }
  }

  console.log("");
  console.log("Règlement des prédictions contre les résultats réels…");
  const settled = await settlePredictions(matches.length + 50);

  const [total, settledCount, correct, publishedCount] = await Promise.all([
    prisma.prediction.count(),
    prisma.prediction.count({ where: { status: "SETTLED" } }),
    prisma.prediction.count({ where: { status: "SETTLED", isCorrect: true } }),
    prisma.prediction.count({ where: { status: "PUBLISHED" } }),
  ]);

  console.log("");
  console.log("─".repeat(78));
  console.log(`Générées : ${generated} · publiées : ${published} · retenues (données insuffisantes) : ${withheld}`);
  console.log(`Réglées  : ${settledCount} · correctes : ${correct}` + (settledCount ? ` (${((correct / settledCount) * 100).toFixed(1)} %)` : ""));
  console.log(`Base     : ${total} prédictions (dont ${publishedCount} publiées)`);
  console.log(`Durée    : ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log("🔒 Aucun appel réseau. Aucun crédit consommé.");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ Échec :", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
