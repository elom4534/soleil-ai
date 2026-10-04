/**
 * ============================================================================
 * SOLEIL — Phase 16 · §5, §27, §34 · Tests du garde-fou de dépense
 * ============================================================================
 * Le point le plus coûteux d'une phase data est toujours le même : une tâche
 * planifiée qui se met à dépenser sans que personne ne l'ait demandé. Ces tests
 * vérifient que le garde-fou tient **par défaut** : sans autorisation explicite,
 * aucune tâche ne sort sur le réseau, même si elle s'exécute.
 *
 * 🔒 Aucune base, aucun réseau, aucun crédit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { JOBS, networkAllowed, networkRefusalReason, runsPerDay } from "../jobs";
import { isValidCron } from "../cron";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Le garde-fou de dépense                                                     */
/* -------------------------------------------------------------------------- */

test("§34 — par défaut, l'ordonnanceur n'ouvre aucun accès réseau", () => {
  withEnv({ SOLEIL_SCHEDULER_NETWORK: undefined, SOLEIL_API_DAILY_BUDGET: undefined }, () => {
    assert.equal(networkAllowed(), false, "aucune autorisation → aucune dépense possible");
    const reason = networkRefusalReason();
    assert.match(reason, /SOLEIL_SCHEDULER_NETWORK/);
    assert.match(reason, /DAILY_BUDGET/);
  });
});

test("§34 — une autorisation sans plafond ne suffit pas", () => {
  withEnv({ SOLEIL_SCHEDULER_NETWORK: "on", SOLEIL_API_DAILY_BUDGET: "0" }, () => {
    assert.equal(networkAllowed(), false, "autoriser sans plafonner n'est pas autoriser");
  });
});

test("§34 — un plafond sans autorisation ne suffit pas non plus", () => {
  withEnv({ SOLEIL_SCHEDULER_NETWORK: undefined, SOLEIL_API_DAILY_BUDGET: "25" }, () => {
    assert.equal(networkAllowed(), false);
  });
});

test("§34 — les deux conditions réunies ouvrent le réseau", () => {
  withEnv({ SOLEIL_SCHEDULER_NETWORK: "on", SOLEIL_API_DAILY_BUDGET: "25" }, () => {
    assert.equal(networkAllowed(), true);
  });
});

test("§34 — une valeur fantaisiste n'ouvre rien", () => {
  withEnv({ SOLEIL_SCHEDULER_NETWORK: "maybe", SOLEIL_API_DAILY_BUDGET: "25" }, () => {
    assert.equal(networkAllowed(), false, "seules les formes on/true ouvrent le réseau");
  });
});

/* -------------------------------------------------------------------------- */
/* Cohérence du registre                                                       */
/* -------------------------------------------------------------------------- */

test("§27 — les quatre tâches attendues sont présentes et planifiables", () => {
  assert.equal(JOBS.length, 4);
  const ids = JOBS.map((job) => job.id);
  assert.ok(ids.includes("ingestion-calendrier"));
  assert.ok(ids.includes("rafraichissement-jour-j"));
  assert.ok(ids.includes("maintenance-donnees"));
  assert.ok(ids.includes("alimentation-matchs-a-venir"));
});

test("§27 — la maintenance et la source gratuite sont gratuites, les deux autres annoncent leur coût", () => {
  for (const id of ["maintenance-donnees", "alimentation-matchs-a-venir"] as const) {
    const free = JOBS.find((job) => job.id === id)!;
    assert.equal(free.usesNetwork, false);
    assert.equal(free.estimatedCredits, 0);
  }

  for (const id of ["ingestion-calendrier", "rafraichissement-jour-j"] as const) {
    const job = JOBS.find((j) => j.id === id)!;
    assert.equal(job.usesNetwork, true);
    assert.ok(job.estimatedCredits > 0);
  }
});

test("§27 — chaque tâche payante indique ce qu'elle coûte par jour, au maximum", () => {
  const ingestion = JOBS.find((job) => job.id === "ingestion-calendrier")!;
  const refresh = JOBS.find((job) => job.id === "rafraichissement-jour-j")!;
  const from = new Date("2026-10-01T00:00:00.000Z");

  assert.equal(ingestion.estimatedCredits * runsPerDay(ingestion.schedule, from), 4);
  assert.equal(refresh.estimatedCredits * runsPerDay(refresh.schedule, from), 4);
  assert.equal(isValidCron(ingestion.schedule) && isValidCron(refresh.schedule), true);
});

test("§25 — une tâche payante s'exécute à une heure creuse, pas à la minute de pointe", () => {
  // Une ingestion qui tomberait pendant les matchs travaillerait sur des
  // données encore mouvantes ; on la place donc en début de matinée UTC.
  const ingestion = JOBS.find((job) => job.id === "ingestion-calendrier")!;
  assert.match(ingestion.schedule, /^0 6 /);
});
