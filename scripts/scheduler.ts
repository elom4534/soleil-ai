#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * SOLEIL — Phase 16 · §27 · Ordonnanceur
 * ============================================================================
 * La machine ne possède aucun démon `cron` (vérifié en audit : `crontab`
 * absent). La planification est donc portée par l'application, avec trois
 * façons de l'utiliser — la même logique dans les trois cas, aucune
 * duplication :
 *
 *   npx tsx scripts/scheduler.ts --list          # état des tâches
 *   npx tsx scripts/scheduler.ts --once          # exécute les tâches dues, puis rend la main
 *   npx tsx scripts/scheduler.ts --run <id>      # force une tâche précise
 *   npx tsx scripts/scheduler.ts --daemon        # boucle permanente
 *
 * `--once` est la forme à appeler depuis un planificateur externe (cron
 * système, tâche planifiée, conteneur) : chaque appel est idempotent, un
 * déclenchement manqué n'est donc pas dramatique.
 *
 * Options :
 *   --dates 2026-10-03,2026-10-04   journées explicites (tâche d'ingestion)
 *   --network                        autorise le réseau pour cette exécution
 *   --force                          ignore le verrou (intervention manuelle)
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { JOBS, findJob, runJob, runDueJobs, lastRun, networkAllowed, networkRefusalReason, totalDailyCredits } from "../src/server/schedule/jobs";
import { describeCron, nextRun, parseCron } from "../src/server/schedule/cron";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(line: string): void {
  console.log(`[${stamp()}] ${line}`);
}

/** `--network` n'ouvre le réseau que pour cette exécution. */
function applyNetworkFlag(): void {
  if (has("--network")) {
    process.env.SOLEIL_SCHEDULER_NETWORK = "on";
    log("⚠ Réseau autorisé pour cette exécution uniquement (--network).");
  }
}

function printSchedule(): void {
  log("Tâches planifiées :");
  for (const job of JOBS) {
    const next = nextRun(parseCron(job.schedule), new Date());
    const record = lastRunSync(job.id);
    console.log(
      `   · ${job.id.padEnd(26)} ${job.schedule.padEnd(14)} ${describeCron(job.schedule)}` +
        `\n     ${job.purpose}` +
        `\n     coût : ${job.estimatedCredits} crédit(s)/exécution${job.usesNetwork ? "" : " (aucun réseau)"}` +
        `\n     prochain : ${next ? next.toISOString() : "jamais"}` +
        (record ? `\n     dernier : ${record.completedAt} · ${record.ok ? "OK" : "ÉCHEC"} · ${record.summary}` : "\n     dernier : jamais exécutée"),
    );
  }
  log(
    `Coût quotidien maximal : ${totalDailyCredits()} crédit(s) — ` +
      `réseau actuellement ${networkAllowed() ? "OUVERT" : `fermé (${networkRefusalReason()})`}.`,
  );
}

/** Lecture synchrone impossible avec Prisma : on garde un cache mémoire simple. */
const lastRunCache = new Map<string, Awaited<ReturnType<typeof lastRun>>>();
function lastRunSync(id: string) {
  return lastRunCache.get(id) ?? null;
}

async function warmLastRuns(): Promise<void> {
  for (const job of JOBS) lastRunCache.set(job.id, await lastRun(job.id));
}

async function runOne(id: string, force: boolean): Promise<boolean> {
  const job = findJob(id);
  if (!job) {
    log(`✖ Tâche inconnue : ${id}. Connues : ${JOBS.map((j) => j.id).join(", ")}`);
    return false;
  }

  log(`▶ ${job.id} — ${job.label}`);
  const record = await runJob(job, { force, onLog: (line) => console.log(`   ${line}`) });
  log(`${record.ok ? "✔" : "✖"} ${record.summary} (${record.durationMs} ms, ${record.creditsSpent} crédit(s))`);
  return record.ok;
}

/** Exécute les tâches dont l'échéance est passée depuis le dernier passage. */
async function runDue(): Promise<void> {
  // Logique unique : `runDueJobs` (jobs.ts) — partagée avec le cœur applicatif.
  await runDueJobs({ onLog: (line) => log(`· ${line}`) });
}

async function daemon(): Promise<void> {
  log("Ordonnanceur démarré (mode démon). Ctrl-C pour arrêter.");
  // Le réveil se fait chaque minute : c'est la granularité des expressions.
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    await runDue();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }

  log("Ordonnanceur arrêté.");
}

async function main(): Promise<void> {
  applyNetworkFlag();

  if (has("--list")) {
    await warmLastRuns();
    printSchedule();
    return;
  }

  const explicit = valueOf("--run");
  if (explicit) {
    await runOne(explicit, has("--force"));
    return;
  }

  if (has("--dates")) {
    // Journées imposées : utile pour vérifier une date précise avant de
    // l'intégrer à la cadence normale.
    const dates = (valueOf("--dates") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const { runUpcomingPipeline } = await import("../src/server/data/upcoming-pipeline");
    const report = await runUpcomingPipeline({
      dates,
      competitionCodes: ["E0", "SP1", "D1", "I1", "F1", "UCL", "UEL", "UNL", "N1", "P1", "BRA1", "RU1"],
      allowNetwork: networkAllowed() || has("--network"),
      predict: true,
      log: (line) => console.log(`   ${line}`),
    });
    log(`Terminé : ${report.totals.inserted} création(s), ${report.totals.updated} mise(s) à jour, ${report.totals.creditsSpent} crédit(s).`);
    return;
  }

  if (has("--once")) {
    await runDue();
    return;
  }

  if (has("--daemon")) {
    await daemon();
    return;
  }

  console.log(
    [
      "Ordonnanceur SOLEIL — utilisation :",
      "  --list              état des tâches, prochaine échéance, dernier résultat",
      "  --once              exécute les tâches dues et rend la main",
      "  --run <id>          force une tâche précise",
      "  --daemon            boucle permanente",
      "  --dates a,b         journées explicites (ingestion)",
      "  --network           autorise le réseau pour cette exécution",
      "",
      `Tâches : ${JOBS.map((j) => j.id).join(", ")}`,
    ].join("\n"),
  );
}

main()
  .catch((error) => {
    console.error(`✖ ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
