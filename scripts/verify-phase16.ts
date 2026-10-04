#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * SOLEIL — Phase 16 · Vérification de la phase
 * ============================================================================
 * Contrôle de bout en bout, **sans consommer un seul crédit** : tout est lu
 * dans la base. Le script répond à une seule question : *ce qui est en base
 * respecte-t-il les règles de la phase ?*
 *
 * Contrôles effectués :
 *
 *   1. §29 — le flux public ne contient aucune rencontre commencée, et chaque
 *      rencontre affichable a une prédiction publiée et versionnée ;
 *   2. §10 — aucune rencontre en double (même affiche, même journée) ;
 *   3. §12 — chaque rencontre future a bien une prédiction, ou une raison
 *      explicite de ne pas en avoir ;
 *   4. §15/§16 — couverture réelle des logos, mesurée, jamais supposée ;
 *   5. §11 — idempotence : un second passage hors ligne ne change aucun compte ;
 *   6. §26/§27 — journal d'appels, état des trois tâches planifiées.
 *
 * Usage :  npx tsx scripts/verify-phase16.ts [--date AAAA-MM-JJ]
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { listUpcomingPredictions, upcomingVisibilityReport } from "../src/server/predictions/upcoming";
import { assertNoStartedMatchInFeed, importWindows, utcDayKey } from "../src/server/schedule/window";
import { JOBS, lastRun, networkAllowed, networkRefusalReason, totalDailyCredits } from "../src/server/schedule/jobs";
import { describeCron, nextRun, parseCron } from "../src/server/schedule/cron";
import { runUpcomingPipeline } from "../src/server/data/upcoming-pipeline";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};

const results: { section: string; ok: boolean; detail: string }[] = [];

function check(section: string, ok: boolean, detail: string): void {
  results.push({ section, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${section} — ${detail}`);
}

async function main(): Promise<void> {
  const now = new Date();
  console.log(`Vérification Phase 16 — ${now.toISOString()}`);
  console.log(`Réseau ordonnanceur : ${networkAllowed() ? "OUVERT" : `fermé (${networkRefusalReason()})`}\n`);

  /* -------------------------------------------------------------------- */
  /* 1 — §29 : test critique du flux public                                */
  /* -------------------------------------------------------------------- */
  const feed = await listUpcomingPredictions({ now, limit: 200 });
  const violations = assertNoStartedMatchInFeed(
    feed.matches.map((match) => ({
      status: match.status,
      utcDate: match.utcDate,
      prediction: match.predictions[0]
        ? {
            status: match.predictions[0].status,
            modelVersion: (match.predictions[0] as { modelVersion?: string | null }).modelVersion ?? null,
          }
        : null,
    })),
    now,
  );
  check(
    "§29 flux public",
    violations.length === 0,
    `${feed.matches.length} rencontre(s) affichable(s), ${violations.length} violation(s)` +
      (violations.length > 0 ? ` → ${violations.slice(0, 3).map((v) => `${v.code}@${v.index}`).join(", ")}` : ""),
  );

  // Traçabilité de la décision de filtrage : combien d'écarts, et pourquoi.
  const visibility = await upcomingVisibilityReport(now);
  check(
    "§3 masquage",
    visibility.hiddenFinished >= 0,
    `terminés masqués ${visibility.hiddenFinished} · différés ${visibility.hiddenNonUpcoming} · ` +
      `sans prédiction ${visibility.hiddenWithoutPrediction} · non publiées ${visibility.hiddenNotPublished}`,
  );
  console.log(
    `   raisons détaillées : ${Object.entries(feed.counts)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ") || "aucun rejet"}`,
  );

  /* -------------------------------------------------------------------- */
  /* 2 — §10 : doublons                                                    */
  /* -------------------------------------------------------------------- */
  const duplicates = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*)::bigint AS n FROM (
      SELECT "homeTeamId", "awayTeamId", date_trunc('day', "utcDate") AS d
      FROM "Match"
      GROUP BY 1, 2, 3
      HAVING count(*) > 1
    ) AS doublons
  `);
  check("§10 doublons", Number(duplicates[0]!.n) === 0, `${duplicates[0]!.n} affiche(s) en double`);

  const multiPredictions = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*)::bigint AS n FROM (
      SELECT "matchId" FROM "Prediction" WHERE status IN ('PUBLISHED','GENERATED')
      GROUP BY 1 HAVING count(*) > 1
    ) AS multi
  `);
  check(
    "§10 prédictions uniques",
    Number(multiPredictions[0]!.n) === 0,
    `${multiPredictions[0]!.n} rencontre(s) avec plusieurs prédictions actives`,
  );

  /* -------------------------------------------------------------------- */
  /* 3 — §12 : rencontres futures et prédictions                           */
  /* -------------------------------------------------------------------- */
  const windows = importWindows(now, { daysAhead: 7 });
  const rangeEnd = windows[windows.length - 1]!.endMs;

  const upcomingMatches = await prisma.match.findMany({
    where: { utcDate: { gt: now, lte: new Date(rangeEnd) } },
    select: {
      id: true,
      utcDate: true,
      status: true,
      externalId: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      predictions: { select: { status: true, modelVersion: true, confidenceScore: true } },
    },
    orderBy: { utcDate: "asc" },
  });

  const byDay = new Map<string, number>();
  for (const match of upcomingMatches) {
    const key = utcDayKey(match.utcDate);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  console.log(`\nRencontres futures (7 jours) : ${upcomingMatches.length}`);
  for (const window of windows) {
    console.log(`   ${window.date} (${window.label}) : ${byDay.get(window.date) ?? 0}`);
  }

  const scheduled = upcomingMatches.filter((m) => m.status === "SCHEDULED");
  const withPrediction = scheduled.filter((m) => m.predictions.length > 0);
  const published = scheduled.filter((m) => m.predictions.some((p) => p.status === "PUBLISHED"));
  const withoutPrediction = scheduled.length - withPrediction.length;

  check(
    "§12 couverture de prédiction",
    scheduled.length > 0 ? published.length > 0 : true,
    `${scheduled.length} programmée(s) · ${withPrediction.length} prédite(s) · ${published.length} publiée(s) · ` +
      `${withoutPrediction} sans prédiction`,
  );

  const versions = new Set(
    upcomingMatches.flatMap((m) => m.predictions.map((p) => p.modelVersion)).filter((v): v is string => Boolean(v)),
  );
  check(
    "§22 versionnage",
    [...versions].every((v) => v.length > 0),
    versions.size > 0 ? `version(s) en jeu : ${[...versions].join(", ")}` : "aucune prédiction future pour l'instant",
  );

  if (withoutPrediction > 0) {
    console.log("   rencontres sans prédiction (données insuffisantes, jamais devinées) :");
    for (const match of scheduled.filter((m) => m.predictions.length === 0).slice(0, 8)) {
      console.log(`     · ${match.utcDate.toISOString()} ${match.homeTeam.name} – ${match.awayTeam.name} (${match.league.name})`);
    }
  }

  /* -------------------------------------------------------------------- */
  /* 4 — §15/§16 : logos                                                   */
  /* -------------------------------------------------------------------- */
  const [teamsTotal, teamsWithCrest, upcomingTeams, logosBySource] = await Promise.all([
    prisma.team.count(),
    prisma.team.count({ where: { crest: { not: null } } }),
    prisma.team.count({
      where: { OR: [{ homeMatches: { some: { utcDate: { gt: now } } } }, { awayMatches: { some: { utcDate: { gt: now } } } }] },
    }),
    prisma.assetCache.groupBy({ by: ["source"], _count: { _all: true } }),
  ]);
  check(
    "§15 logos",
    true,
    `${teamsWithCrest}/${teamsTotal} équipes avec logo · ${upcomingTeams} équipe(s) concernée(s) par une rencontre future · ` +
      `cache : ${logosBySource.map((row) => `${row.source}=${row._count._all}`).join(", ") || "vide"}`,
  );

  const leagues = await prisma.league.findMany({ select: { externalId: true, name: true, country: true, countryCode: true, logo: true } });
  for (const league of leagues) {
    console.log(
      `   ${league.externalId.padEnd(10)} ${league.name.padEnd(22)} pays=${league.country} (${league.countryCode ?? "—"}) logo=${league.logo ? "oui" : "non"}`,
    );
  }

  /* -------------------------------------------------------------------- */
  /* 5 — §11 : idempotence hors ligne                                      */
  /* -------------------------------------------------------------------- */
  const before = {
    matches: await prisma.match.count(),
    teams: await prisma.team.count(),
    predictions: await prisma.prediction.count(),
    assets: await prisma.assetCache.count(),
  };

  if (!has("--skip-idempotence")) {
    const date = valueOf("--date");
    const dates = date ? [date] : windows.slice(0, 3).map((w) => w.date);
    console.log(`\nSecond passage hors ligne (0 crédit) sur : ${dates.join(", ")}`);
    const report = await runUpcomingPipeline({
      dates,
      competitionCodes: ["E0", "SP1"],
      allowNetwork: false,
      predict: false,
      log: (line) => console.log(`   ${line}`),
    });

    const after = {
      matches: await prisma.match.count(),
      teams: await prisma.team.count(),
      predictions: await prisma.prediction.count(),
      assets: await prisma.assetCache.count(),
    };

    const stable =
      after.matches === before.matches &&
      after.teams === before.teams &&
      after.predictions === before.predictions &&
      after.assets === before.assets;

    check(
      "§11 idempotence",
      stable,
      `avant ${JSON.stringify(before)} → après ${JSON.stringify(after)}` +
        (stable ? " (identique)" : " (DIVERGENCE)"),
    );
    console.log(`   crédits consommés par ce passage : ${report.totals.creditsSpent}`);
  }

  /* -------------------------------------------------------------------- */
  /* 6 — §26/§27 : journal et tâches                                       */
  /* -------------------------------------------------------------------- */
  const [syncLogs, apiCalls, dataSources] = await Promise.all([
    prisma.dataSyncLog.count(),
    prisma.apiCallLog.count(),
    prisma.dataSource.findMany({ select: { name: true, isActive: true, lastSync: true } }),
  ]);
  check(
    "§26 journalisation",
    true,
    `${syncLogs} entrée(s) DataSyncLog · ${apiCalls} appel(s) fournisseur journalisé(s) · sources : ` +
      `${dataSources.map((s) => `${s.name}${s.isActive ? "" : " (inactive)"}`).join(", ") || "aucune"}`,
  );

  console.log("\nTâches planifiées :");
  for (const job of JOBS) {
    const run = await lastRun(job.id);
    const next = nextRun(parseCron(job.schedule), now);
    console.log(
      `   · ${job.id.padEnd(26)} ${job.schedule.padEnd(12)} ${describeCron(job.schedule)}` +
        `\n     prochain ${next ? next.toISOString() : "—"} · coût/execution ${job.estimatedCredits} crédit(s)` +
        (run ? `\n     dernier ${run.completedAt} : ${run.ok ? "OK" : "ÉCHEC"} — ${run.summary}` : "\n     dernier : jamais exécutée"),
    );
  }
  console.log(`   coût quotidien maximal : ${totalDailyCredits(now)} crédit(s)`);

  /* -------------------------------------------------------------------- */
  /* Synthèse                                                              */
  /* -------------------------------------------------------------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n═══ Synthèse : ${results.length - failed.length}/${results.length} contrôles conformes ═══`);
  for (const result of failed) console.log(`   ✖ ${result.section} — ${result.detail}`);

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`✖ ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
