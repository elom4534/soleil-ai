#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * SOLEIL — Alimentation des matchs à venir via TheSportsDB (0 crédit)
 * ============================================================================
 * Coquille CLI autour de `src/server/data/upcoming-tsdb.ts` (le vrai travail
 * est partagé avec la tâche planifiée `alimentation-matchs-a-venir`).
 *
 * Usage :
 *   node_modules/.bin/tsx scripts/ingest-upcoming-tsdb.ts             # réseau + ingestion
 *   node_modules/.bin/tsx scripts/ingest-upcoming-tsdb.ts --cache-only # relit le disque
 *   node_modules/.bin/tsx scripts/ingest-upcoming-tsdb.ts --dry-run   # aperçu seul, aucune écriture
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { collectTsdbUpcoming, ingestTsdbUpcoming } from "../src/server/data/upcoming-tsdb";
import { tsdbEventToFixture } from "../src/server/data/providers/theSportsDbFixtures";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);

function log(line = ""): void {
  console.log(line);
}

function header(title: string): void {
  log(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  const cacheOnly = has("--cache-only");
  const dryRun = has("--dry-run");

  header("ANNONCE — source gratuite TheSportsDB (0 crédit, aucune clé payante)");
  log("  SOURCE          TheSportsDB (niveau libre) — déjà présent dans le projet");
  log("  ENDPOINTS       eventsnextleague (E0, SP1) + eventsround (journée courante et suivante)");
  log("  COÛT ESTIMÉ     0 crédit (aucun appel vers LiveFootballApi)");
  log("  DONNÉES         matchs à venir E0/SP1 : identifiants, équipes, logos publiés, coup d'envoi, statut");
  log("  RAISON          alimenter la page publique en rencontres à venir pendant que les clés payantes sont bloquées (403)");
  log(`  MODE            ${cacheOnly ? "cache disque uniquement (0 requête)" : dryRun ? "aperçu seul" : "réseau puis ingestion hors ligne"}`);

  if (dryRun) {
    header("APERÇU — aucune écriture");
    const collected = await collectTsdbUpcoming({ cacheOnly, log: (l) => log(`   ${l}`) });
    const now = new Date();
    const rows = [...collected.values()]
      .map((event) => ({ event, fixture: tsdbEventToFixture(event) }))
      .filter((row) => row.fixture !== null && row.fixture.utcDate.getTime() > now.getTime() && row.fixture.status === "scheduled")
      .sort((a, b) => a.fixture!.utcDate.getTime() - b.fixture!.utcDate.getTime());
    for (const row of rows.slice(0, 15)) {
      const d = row.fixture!.utcDate;
      log(`   · ${d.toISOString().slice(0, 16).replace("T", " ")}Z · ${row.fixture!.competition.code} · ${row.fixture!.homeTeamName} – ${row.fixture!.awayTeamName}`);
    }
    if (rows.length > 15) log(`   … et ${rows.length - 15} autre(s)`);
    return;
  }

  header("INGESTION (pipeline commun — 0 crédit)");
  const report = await ingestTsdbUpcoming({ cacheOnly, log: (l) => log(`   ${l}`) });

  log("");
  log(`  journées : ${report.dates.join(", ") || "aucune"}`);
  log(`  crédits consommés : ${report.creditsSpent} (source gratuite)`);
  log(`  rencontres créées : ${report.inserted} · mises à jour : ${report.updated}`);
  log(
    `  prédictions : ${report.predictionsGenerated} générée(s), ${report.predictionsPublished} publiée(s), ` +
      `${report.predictionsWithheld} retenue(s)`,
  );
  for (const error of report.errors) log(`   ⚠ ${error}`);

  header("JOURNAL");
  const calls = await prisma.apiCallLog.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  for (const call of calls) {
    log(
      `   ${call.createdAt.toISOString()} ${call.provider}/${call.endpoint} · coût ${call.cost} · ` +
        `HTTP ${call.statusCode ?? "—"} · cache ${call.fromCache ? "oui" : "non"}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(`\n✖ ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
