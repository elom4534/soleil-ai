#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * SOLEIL — Matchs à venir depuis le cache TSDB, SANS prédiction
 * ============================================================================
 * Créé le 2026-10-08 pour la restauration locale post-recyclage du bac à sable.
 *
 * POURQUOI CE FICHIER EXISTE
 *   Mission 27 (`scripts/audit-27-exactscore.ts`) sélectionne ses cibles sur
 *   `{ status: "SCHEDULED", utcDate: { gt: new Date() } }`. Les scripts
 *   d'import historique (`bootstrap-local.ts`, `ingest-history-fdcouk.ts`) ne
 *   produisent que du FINISHED. Sans rencontres à venir, Mission 27 tourne à
 *   vide.
 *
 *   Le script existant `ingest-upcoming-tsdb.ts` sait les ingérer hors ligne
 *   (`--cache-only`), mais `ingestTsdbUpcoming()` appelle le pipeline avec
 *   `predict: true` **codé en dur** et n'expose aucun drapeau `--no-predict`.
 *   La mission du 2026-10-08 interdisant de créer la moindre prédiction, ce
 *   fichier reprend le mécanisme existant en changeant UN SEUL paramètre.
 *
 * CE QUI EST RÉUTILISÉ (aucune logique nouvelle)
 *   · `collectTsdbUpcoming({ cacheOnly: true })`  → 0 requête réseau
 *   · `tsdbEventToFixture`, `TSDB_LEAGUE_CODES`   → même chaîne de conversion
 *   · `tsdbFetchDayFromEvents`                    → même source branchable
 *   · `runUpcomingPipeline({ allowNetwork: false, predict: false })`
 *     → combinaison DÉJÀ employée par le projet dans `scripts/verify-phase16.ts`
 *       (l. 218 : `allowNetwork: false, predict: false`)
 *   La sélection des rencontres est la copie conforme de
 *   `src/server/data/upcoming-tsdb.ts` l. 160-167.
 *
 * 🔒 GARANTIES
 *   · allowNetwork: false → 0 requête HTTP, 0 crédit, aucune clé lue
 *   · predict: false      → 0 prédiction générée, publiée ou retenue
 *   · aucune écriture sur une base distante : garde-fou explicite sur
 *     DATABASE_URL (doit contenir `localhost`), sinon sortie immédiate
 *   · aucune modification du moteur, des modèles, des poids, des formules,
 *     du schéma Prisma ni des données historiques
 *   · import ADDITIF et idempotent (`ingestFixtures` / pipeline existant)
 *
 * Usage :
 *   npx tsx scripts/local-upcoming-nopredict.ts --dry-run   # aperçu, 0 écriture
 *   npx tsx scripts/local-upcoming-nopredict.ts             # ingestion réelle
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { collectTsdbUpcoming } from "../src/server/data/upcoming-tsdb";
import { runUpcomingPipeline } from "../src/server/data/upcoming-pipeline";
import {
  TSDB_LEAGUE_CODES,
  tsdbEventToFixture,
  tsdbFetchDayFromEvents,
} from "../src/server/data/providers/theSportsDbFixtures";

const COMPETITION_CODES = ["E0", "SP1", "D1", "I1", "F1", "UCL", "UEL", "UNL"];

function log(line = ""): void {
  console.log(line);
}

/** Garde-fou : refuse de toucher à autre chose qu'une base locale. */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.replace(/^.*@/, "").split(/[:/?]/)[0] ?? "";
  if (!/^(localhost|127\.0\.0\.1|::1)$/.test(host)) {
    console.error(
      `\n✖ ARRÊT : DATABASE_URL ne pointe pas vers une base locale (hôte « ${host || "inconnu"} »).\n` +
        `  Ce script ne doit jamais écrire ailleurs que dans le bac à sable.`,
    );
    process.exit(1);
  }
  log(`  BASE CIBLE      ${host} (locale) — toute base distante est refusée par ce garde-fou`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  log("═".repeat(78));
  log("SOLEIL — MATCHS À VENIR (cache TSDB) · 0 réseau · 0 crédit · 0 PRÉDICTION");
  log("═".repeat(78));
  assertLocalDatabase();
  log("  SOURCE          data/cache-tsdb/ (déjà présent dans le dépôt)");
  log("  RÉSEAU          interdit — allowNetwork: false + cacheOnly: true");
  log("  PRÉDICTIONS     interdites — predict: false");
  log(`  MODE            ${dryRun ? "aperçu seul, aucune écriture" : "ingestion locale additive"}`);
  log("");

  /* ---- Collecte : copie conforme de upcoming-tsdb.ts l. 160-167 ---------- */
  const collected = await collectTsdbUpcoming({
    cacheOnly: true,
    log: (line) => log(`   ${line}`),
  });
  const now = new Date();
  const rows = [...collected.values()]
    .map((event) => ({ event, fixture: tsdbEventToFixture(event) }))
    .filter(
      (row): row is { event: typeof row.event; fixture: NonNullable<typeof row.fixture> } =>
        row.fixture !== null,
    )
    .filter((row) => TSDB_LEAGUE_CODES[(row.event.idLeague ?? "").trim()] !== undefined)
    .filter((row) => row.fixture.utcDate.getTime() > now.getTime())
    .filter((row) => row.fixture.status === "scheduled")
    .sort((a, b) => a.fixture.utcDate.getTime() - b.fixture.utcDate.getTime());

  log("");
  log(`  ${rows.length} rencontre(s) à venir retenue(s) sur ${collected.size} événement(s) en cache`);
  for (const row of rows.slice(0, 12)) {
    const d = row.fixture.utcDate;
    log(
      `   · ${d.toISOString().slice(0, 16).replace("T", " ")}Z · ${row.fixture.competition.code.padEnd(4)}` +
        ` · ${row.fixture.homeTeamName} – ${row.fixture.awayTeamName}`,
    );
  }
  if (rows.length > 12) log(`   … et ${rows.length - 12} autre(s)`);

  if (rows.length === 0) {
    log("\n  Aucune rencontre à venir dans le cache : rien à ingérer.");
    return;
  }

  const dates = [...new Set(rows.map((row) => row.fixture.utcDate.toISOString().slice(0, 10)))].sort();
  log(`\n  Journées : ${dates.join(", ")}`);

  if (dryRun) {
    log("\n  --dry-run : aucune écriture effectuée.");
    return;
  }

  /* ---- Pipeline existant, predict: false (comme verify-phase16.ts) ------- */
  const before = {
    matches: await prisma.match.count(),
    predictions: await prisma.prediction.count(),
  };

  const report = await runUpcomingPipeline({
    dates,
    competitionCodes: COMPETITION_CODES,
    allowNetwork: false,
    predict: false,
    fetchDay: tsdbFetchDayFromEvents(rows.map((row) => row.event)),
    log: (line) => log(`   ${line}`),
  });

  const after = {
    matches: await prisma.match.count(),
    predictions: await prisma.prediction.count(),
  };

  log("");
  log("─".repeat(78));
  log("  RÉSULTAT");
  log("─".repeat(78));
  log(`  rencontres créées      : ${report.totals.inserted}`);
  log(`  rencontres mises à jour: ${report.totals.updated}`);
  log(`  équipes créées         : ${report.totals.teamsCreated}`);
  log(`  crédits consommés      : ${report.totals.creditsSpent} (doit être 0)`);
  log(`  prédictions générées   : ${report.totals.predictionsGenerated} (doit être 0)`);
  log(`  prédictions publiées   : ${report.totals.predictionsPublished} (doit être 0)`);
  log(`  matchs en base         : ${before.matches} → ${after.matches}`);
  log(`  prédictions en base    : ${before.predictions} → ${after.predictions} (doit être inchangé)`);
  // `totals.errors` est un NOMBRE ; les messages sont portés par chaque journée.
  const errors = report.days.flatMap((day) => day.errors);
  for (const error of errors) log(`   ⚠ ${error}`);
  if (errors.length === 0) log("  erreurs                : 0");

  const clean =
    report.totals.creditsSpent === 0 &&
    report.totals.predictionsGenerated === 0 &&
    before.predictions === after.predictions;
  log("");
  log(clean ? "  ✅ CONTRÔLE : 0 crédit, 0 prédiction créée." : "  🔴 CONTRÔLE EN ÉCHEC — voir ci-dessus.");
  if (!clean) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n✖ ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
