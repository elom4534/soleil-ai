/**
 * ============================================================================
 * SOLEIL — Phase 16 · §27 · Tests de la planification
 * ============================================================================
 * La machine n'a pas de démon `cron` : les échéances sont calculées par le
 * code. Ces calculs doivent donc être **plus** sûrs qu'un `crontab`, pas moins,
 * car personne ne les relira à l'œil chaque semaine.
 *
 * 🔒 Aucune base, aucun réseau.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CronSyntaxError, describeCron, isValidCron, nextRun, parseCron, parseField } from "../cron";
import { JOBS, runsPerDay, totalDailyCredits } from "../jobs";

/* -------------------------------------------------------------------------- */
/* Analyse des expressions                                                     */
/* -------------------------------------------------------------------------- */

test("§27 — une expression classique à cinq champs est acceptée", () => {
  const cron = parseCron("0 6 * * *");
  assert.deepEqual(cron.minute, [0]);
  assert.deepEqual(cron.hour, [6]);
  assert.equal(cron.restrictedDays, false);
});

test("§27 — les pas, listes et intervalles sont développés correctement", () => {
  assert.deepEqual(parseField("minute", "*/6"), [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
  assert.deepEqual(parseField("heure", "6,18"), [6, 18]);
  assert.deepEqual(parseField("heure", "9-12"), [9, 10, 11, 12]);
  assert.deepEqual(parseField("jour-de-semaine", "1-5"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseField("minute", "0"), [0]);
});

test("§27 — une expression ambiguë est refusée, pas interprétée", () => {
  assert.throws(() => parseCron("0 6 * *"), CronSyntaxError, "quatre champs");
  assert.throws(() => parseCron("0 6 * * * *"), CronSyntaxError, "six champs");
  assert.throws(() => parseCron("60 6 * * *"), CronSyntaxError, "minute hors bornes");
  assert.throws(() => parseCron("0 24 * * *"), CronSyntaxError, "heure hors bornes");
  assert.throws(() => parseCron("0 6 * * 8"), CronSyntaxError, "jour de semaine hors bornes");
  assert.throws(() => parseCron("@daily"), CronSyntaxError, "alias non supporté");
  assert.throws(() => parseCron("0 6 */0 * *"), CronSyntaxError, "pas nul");
  assert.equal(isValidCron("0 6 * * *"), true);
  assert.equal(isValidCron("@daily"), false);
});

/* -------------------------------------------------------------------------- */
/* Prochaine échéance                                                          */
/* -------------------------------------------------------------------------- */

test("§27 — la prochaine échéance est calculée en UTC et strictement future", () => {
  const from = new Date("2026-10-01T00:54:00.000Z");
  assert.equal(nextRun("0 6 * * *", from)?.toISOString(), "2026-10-01T06:00:00.000Z");
  assert.equal(nextRun("0 */6 * * *", from)?.toISOString(), "2026-10-01T06:00:00.000Z");
  assert.equal(nextRun("30 3 * * *", from)?.toISOString(), "2026-10-01T03:30:00.000Z");
});

test("§27 — un instant qui tombe pile sur une échéance renvoie la suivante", () => {
  const from = new Date("2026-10-01T06:00:00.000Z");
  assert.equal(nextRun("0 6 * * *", from)?.toISOString(), "2026-10-02T06:00:00.000Z");
});

test("§27 — les secondes et millisecondes de départ sont ignorées, jamais arrondies au hasard", () => {
  const from = new Date("2026-10-01T05:59:59.999Z");
  assert.equal(nextRun("0 6 * * *", from)?.toISOString(), "2026-10-01T06:00:00.000Z");
});

test("§27 — une expression impossible ne produit aucune échéance", () => {
  assert.equal(nextRun("0 0 31 2 *", new Date("2026-10-01T00:00:00.000Z")), null, "31 février n'existe pas");
});

test("§27 — une expression journalière avance bien d'un jour à chaque fois", () => {
  let cursor = new Date("2026-10-01T06:00:00.000Z");
  const days: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const next = nextRun("0 6 * * *", cursor)!;
    days.push(next.toISOString().slice(0, 10));
    cursor = next;
  }
  assert.deepEqual(days, ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
});

/* -------------------------------------------------------------------------- */
/* Tâches planifiées : cadence et coût                                         */
/* -------------------------------------------------------------------------- */

test("§27 — quatre tâches sont créées, toutes actives, toutes valides", () => {
  assert.equal(JOBS.length, 4);
  assert.deepEqual(
    JOBS.map((job) => job.id).sort(),
    ["alimentation-matchs-a-venir", "ingestion-calendrier", "maintenance-donnees", "rafraichissement-jour-j"],
  );
  for (const job of JOBS) {
    assert.equal(isValidCron(job.schedule), true, `${job.id} : expression valide`);
    assert.ok(job.label.length > 0);
    assert.ok(job.purpose.length > 20, `${job.id} : la raison d'être de la tâche est documentée`);
    assert.equal(typeof job.handler, "function");
  }
});

test("§27 — le coût annoncé est cohérent avec l'usage du réseau", () => {
  for (const job of JOBS) {
    if (job.usesNetwork) {
      assert.ok(job.estimatedCredits > 0, `${job.id} : une tâche réseau annonce un coût non nul`);
    } else {
      assert.equal(job.estimatedCredits, 0, `${job.id} : une tâche locale ne consomme rien`);
    }
  }
});

test("§27 — le nombre de déclenchements quotidiens est déduit de l'expression", () => {
  const from = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(runsPerDay("0 6 * * *", from), 1);
  assert.equal(runsPerDay("0 */6 * * *", from), 4);
  assert.equal(runsPerDay("30 3 * * *", from), 1);
});

test("§27 — le coût quotidien maximal correspond aux cadences réelles", () => {
  // Ingestion : 4 journées × 1 crédit × 1 passage = 4.
  // Rafraîchissement : 1 journée × 1 crédit × 4 passages = 4.
  // Maintenance : 0.
  assert.equal(totalDailyCredits(new Date("2026-10-01T00:00:00.000Z")), 8);
});

test("§27 — l'ordonnanceur parle français à l'administrateur", () => {
  assert.match(describeCron("0 6 * * *"), /06:00/);
  assert.match(describeCron("0 */6 * * *"), /00:00|06:00/);
  assert.match(describeCron("pas une expression"), /invalide/i);
});
