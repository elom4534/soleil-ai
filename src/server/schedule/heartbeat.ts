/**
 * ============================================================================
 * SOLEIL — Cœur d'ordonnanceur applicatif (AlwaysData)
 * ============================================================================
 * AlwaysData interdit `crontab` et ne gère aucun démon externe : le seul
 * processus maintenu en vie est l'application elle-même. La planification est
 * donc portée par un « cœur » périodique qui appelle exactement la même
 * logique que `scripts/scheduler.ts --once` : `runDueJobs`.
 *
 * · Premier passage 90 s après le démarrage (le temps que la base soit prête),
 *   puis toutes les 15 minutes.
 * · Chaque tâche n'est exécutée que si son expression cron le prévoit — les
 *   cadences réelles restent celles de `jobs.ts`.
 * · Un passage en cours n'est jamais interrompu par le suivant (verrou de
 *   cœur), et une erreur n'affecte jamais le service web.
 * · Désactivable : `SOLEIL_SCHEDULER_HEARTBEAT=off`.
 */

import { runDueJobs } from "./jobs";

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000;

let started = false;
let ticking = false;

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function tick(): Promise<void> {
  if (ticking) return; // jamais deux passages en parallèle
  ticking = true;
  try {
    await runDueJobs({
      onLog: (line) => console.log(`[soleil-scheduler ${stamp()}] ${line}`),
    });
  } catch (error) {
    // Le service web ne doit jamais tomber à cause de l'ordonnanceur.
    console.error(`[soleil-scheduler ${stamp()}] passage en erreur : ${(error as Error).message}`);
  } finally {
    ticking = false;
  }
}

export function startSchedulerHeartbeat(): void {
  if (started) return;
  const flag = (process.env.SOLEIL_SCHEDULER_HEARTBEAT ?? "").toLowerCase();
  if (flag === "off" || flag === "false") {
    console.log("[soleil-scheduler] cœur désactivé (SOLEIL_SCHEDULER_HEARTBEAT=off).");
    return;
  }
  started = true;
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_INTERVAL_MS);
  }, FIRST_TICK_DELAY_MS);
  console.log(
    `[soleil-scheduler] cœur actif — premier passage dans ${FIRST_TICK_DELAY_MS / 1000}s, ` +
      `puis toutes les ${TICK_INTERVAL_MS / 60000} min.`,
  );
}
