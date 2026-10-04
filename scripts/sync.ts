/**
 * ============================================================================
 * SOLEIL — Script de synchronisation (ligne de commande)
 * ============================================================================
 * Usage :
 *   npm run sync                      → synchronisation complète
 *   npm run sync -- --competitions E0,SP1
 *   npm run sync -- --backfill 400    → rétro-remplissage de l'historique
 *   npm run sync -- --no-predict      → ingestion seule
 */

import "dotenv/config";
import { runSync, backfillHistory } from "../src/server/jobs/sync";
import { prisma } from "../src/lib/prisma";

interface Args {
  competitions?: string[];
  seasons?: string[];
  predict: boolean;
  settle: boolean;
  backfill: number;
  maxPredictions: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    competitions: get("--competitions")?.split(",").filter(Boolean),
    seasons: get("--seasons")?.split(",").filter(Boolean),
    predict: !argv.includes("--no-predict"),
    settle: !argv.includes("--no-settle"),
    backfill: Number(get("--backfill") ?? 0),
    maxPredictions: Number(get("--max-predictions") ?? 120),
  };
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("☀️  SOLEIL — synchronisation des données");
  console.log("─".repeat(64));

  const report = await runSync({
    competitions: args.competitions,
    seasons: args.seasons,
    predict: args.predict,
    settle: args.settle,
    maxPredictions: args.maxPredictions,
    log: true,
  });

  console.log(`\n📡 Fournisseurs interrogés : ${new Set(report.providerReports.map((p) => p.provider)).size}`);
  console.log(`🌐 Requêtes réseau effectuées : ${report.apiRequests}`);
  console.log(`🏆 Compétitions traitées : ${report.leaguesProcessed}`);
  console.log(`📥 Rencontres reçues : ${report.fixturesFetched}`);
  console.log(`   ├─ insérées : ${report.fixturesInserted}`);
  console.log(`   ├─ mises à jour : ${report.fixturesUpdated}`);
  console.log(`   └─ équipes créées : ${report.teamsCreated}`);
  console.log(`🔮 Prédictions générées : ${report.predictionsGenerated}`);
  console.log(`   ├─ publiées : ${report.predictionsPublished}`);
  console.log(`   └─ retenues (données insuffisantes) : ${report.predictionsWithheld}`);
  console.log(`⚖️  Prédictions réglées : ${report.settled}`);

  if (report.errors.length > 0) {
    console.log(`\n⚠️  ${report.errors.length} avertissement(s) :`);
    for (const e of report.errors.slice(0, 8)) console.log(`   · ${e}`);
  }

  if (args.backfill > 0) {
    console.log("\n🕰️  Rétro-remplissage de l'historique (backtest honnête)…");
    const bf = await backfillHistory({ limit: args.backfill });
    console.log(`   ├─ prédictions générées : ${bf.generated}`);
    console.log(`   ├─ publiées : ${bf.published}`);
    console.log(`   ├─ réglées : ${bf.settled}`);
    console.log(`   └─ correctes : ${bf.correct}${bf.settled ? ` (${((bf.correct / bf.settled) * 100).toFixed(1)} %)` : ""}`);
  }

  const counts = {
    leagues: await prisma.league.count(),
    teams: await prisma.team.count(),
    matches: await prisma.match.count(),
    finished: await prisma.match.count({ where: { status: "FINISHED" } }),
    upcoming: await prisma.match.count({ where: { status: "SCHEDULED" } }),
    predictions: await prisma.prediction.count(),
    published: await prisma.prediction.count({ where: { status: "PUBLISHED" } }),
    settled: await prisma.prediction.count({ where: { status: "SETTLED" } }),
  };

  console.log("\n📊 Base de données");
  console.log(`   Compétitions : ${counts.leagues}`);
  console.log(`   Équipes      : ${counts.teams}`);
  console.log(`   Matchs       : ${counts.matches} (terminés ${counts.finished} · à venir ${counts.upcoming})`);
  console.log(`   Prédictions  : ${counts.predictions} (publiées ${counts.published} · réglées ${counts.settled})`);

  console.log(`\n✅ Terminé en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main()
  .catch((error) => {
    console.error("\n❌ Échec de la synchronisation :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
