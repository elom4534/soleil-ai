/**
 * ============================================================================
 * SOLEIL — Phase 16 · §28 · Tests des dates, des statuts et de la sûreté §29
 * ============================================================================
 * Ces tests couvrent la partie qui décide **quelles journées interroger** et
 * **ce qui a le droit d'être affiché**. Ce sont les deux endroits où une erreur
 * se paie soit en crédits, soit en confiance :
 *
 *   · une fenêtre trop large consomme des crédits inutilement ;
 *   · un filtre trop permissif laisse passer une rencontre déjà commencée.
 *
 * 🔒 Aucune base, aucun réseau, aucun crédit. Toutes les fonctions testées sont
 * pures et reçoivent leur instant de référence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertNoStartedMatchInFeed,
  dayLabel,
  importWindows,
  isFuture,
  PUBLIC_DISPLAY_STATUSES,
  toPublicStatus,
  toTimestamp,
  utcDayBounds,
  utcDayKey,
} from "../window";

/** Instant de référence : jeudi 1ᵉʳ octobre 2026, 00:54 UTC (date de la phase). */
const NOW = new Date("2026-10-01T00:54:00.000Z");

/* -------------------------------------------------------------------------- */
/* §8 — Horodatages                                                            */
/* -------------------------------------------------------------------------- */

test("§8 — une date illisible ne devient jamais un horodatage valide", () => {
  assert.equal(toTimestamp("pas une date"), null);
  assert.equal(toTimestamp(null), null);
  assert.equal(toTimestamp(undefined), null);
  assert.equal(toTimestamp(""), null);
  assert.equal(Number.isNaN(toTimestamp("n/a") as number), false, "jamais NaN : null explicite");
});

test("§8 — l'horodatage est lu en UTC, quelle que soit la forme d'entrée", () => {
  const iso = "2026-10-03T14:00:00.000Z";
  assert.equal(toTimestamp(iso), Date.parse(iso));
  assert.equal(toTimestamp(new Date(iso)), Date.parse(iso));
  assert.equal(toTimestamp(Date.parse(iso)), Date.parse(iso));
});

test("§8 — comparaison stricte : l'instant de référence n'est pas « futur »", () => {
  assert.equal(isFuture("2026-10-01T00:54:00.000Z", NOW), false);
  assert.equal(isFuture("2026-10-01T00:54:01.000Z", NOW), true);
  assert.equal(isFuture("2026-09-30T23:59:59.000Z", NOW), false);
  assert.equal(isFuture("illisible", NOW), false, "une date illisible n'est jamais considérée à venir");
});

test("§8 — la journée UTC est celle du calendrier, pas celle du fuseau local", () => {
  // 00:30 UTC le 1ᵉʳ octobre reste le 1ᵉʳ octobre, même pour un serveur à Paris.
  assert.equal(utcDayKey("2026-10-01T00:30:00.000Z"), "2026-10-01");
  assert.equal(utcDayKey("2026-10-01T23:59:59.999Z"), "2026-10-01");
  assert.equal(utcDayKey("2026-10-01T00:00:00.000Z"), "2026-10-01");
});

test("§8 — les bornes d'une journée couvrent exactement 24 heures", () => {
  const { startMs, endMs } = utcDayBounds("2026-10-03");
  assert.equal(endMs - startMs, 86_400_000 - 1);
  assert.equal(new Date(startMs).toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(new Date(endMs).toISOString(), "2026-10-03T23:59:59.999Z");
});

/* -------------------------------------------------------------------------- */
/* §7, §18 — Fenêtres d'import                                                 */
/* -------------------------------------------------------------------------- */

test("§7 — la fenêtre couvre aujourd'hui, demain et les jours suivants", () => {
  const windows = importWindows(NOW, { daysAhead: 3 });
  assert.deepEqual(
    windows.map((w) => w.date),
    ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
  );
});

test("§7 — la profondeur de fenêtre est explicite, jamais implicite", () => {
  assert.equal(importWindows(NOW, { daysAhead: 1 }).length, 2);
  assert.equal(importWindows(NOW, { daysAhead: 7 }).length, 8);
  assert.equal(importWindows(NOW, { daysAhead: 3, includeToday: false })[0]!.date, "2026-10-02");
});

test("§18 — les libellés parlent à l'utilisateur, pas au serveur", () => {
  const windows = importWindows(NOW, { daysAhead: 3 });
  assert.equal(windows[0]!.label, "Aujourd'hui");
  assert.equal(windows[1]!.label, "Demain");
  assert.match(windows[2]!.label, /^3 octobre$/);
  assert.match(windows[3]!.label, /^4 octobre$/);
  assert.equal(dayLabel(-1, Date.parse("2026-09-30T00:00:00.000Z")), "Hier");
});

test("§7 — chaque fenêtre est cohérente avec ses propres bornes", () => {
  for (const window of importWindows(NOW, { daysAhead: 5 })) {
    assert.equal(utcDayKey(new Date(window.startMs)), window.date);
    assert.equal(utcDayKey(new Date(window.endMs)), window.date);
    assert.ok(window.startMs <= window.endMs);
  }
});

/* -------------------------------------------------------------------------- */
/* §9 — Statuts                                                               */
/* -------------------------------------------------------------------------- */

test("§9 — chaque statut de la base a une projection publique explicite", () => {
  assert.equal(toPublicStatus("SCHEDULED"), "UPCOMING");
  assert.equal(toPublicStatus("LIVE"), "LIVE");
  assert.equal(toPublicStatus("IN_PLAY"), "LIVE");
  assert.equal(toPublicStatus("PAUSED"), "LIVE");
  assert.equal(toPublicStatus("FINISHED"), "FINISHED");
  assert.equal(toPublicStatus("POSTPONED"), "POSTPONED");
  assert.equal(toPublicStatus("CANCELLED"), "CANCELLED");
  // Une rencontre interrompue n'est pas « à venir » : elle n'est pas affichable.
  assert.equal(toPublicStatus("SUSPENDED"), "CANCELLED");
  // Entrées hors nomenclature : elles doivent ressortir en UNKNOWN, jamais
  // hériter d'un statut par défaut.
  assert.equal(toPublicStatus("statut-inconnu" as never), "UNKNOWN");
  assert.equal(toPublicStatus(null as never), "UNKNOWN");
});

test("§9 — le flux public n'accepte qu'un seul statut", () => {
  assert.deepEqual([...PUBLIC_DISPLAY_STATUSES], ["UPCOMING"]);
});

/* -------------------------------------------------------------------------- */
/* §29 — Test critique : rien de déjà commencé dans le flux public             */
/* -------------------------------------------------------------------------- */

const published = { status: "PUBLISHED", modelVersion: "1.0.0-matrix-xg0.2-matrix-ensemble" };

test("§29 — un flux conforme ne produit aucune violation", () => {
  const violations = assertNoStartedMatchInFeed(
    [
      { status: "SCHEDULED", utcDate: "2026-10-03T14:00:00.000Z", prediction: published },
      { status: "SCHEDULED", utcDate: "2026-10-04T19:45:00.000Z", prediction: published },
    ],
    NOW,
  );
  assert.deepEqual(violations, []);
});

test("§29 — une rencontre déjà commencée est signalée, jamais tolérée", () => {
  const violations = assertNoStartedMatchInFeed(
    [{ status: "LIVE", utcDate: "2026-09-30T18:00:00.000Z", prediction: published }],
    NOW,
  );
  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes("STATUT"), "statut non-UPCOMING");
  assert.ok(codes.includes("DEJA_COMMENCE"), "coup d'envoi passé");
});

test("§29 — coup d'envoi exactement à l'instant de référence : refusé", () => {
  const violations = assertNoStartedMatchInFeed(
    [{ status: "SCHEDULED", utcDate: NOW, prediction: published }],
    NOW,
  );
  assert.deepEqual(
    violations.map((v) => v.code),
    ["DEJA_COMMENCE"],
    "« à venir » signifie strictement postérieur",
  );
});

test("§29 — une prédiction absente, non publiée ou non versionnée bloque l'affichage", () => {
  const absent = assertNoStartedMatchInFeed([{ status: "SCHEDULED", utcDate: "2026-10-03T14:00:00.000Z" }], NOW);
  assert.deepEqual(absent.map((v) => v.code), ["SANS_PREDICTION"]);

  const notPublished = assertNoStartedMatchInFeed(
    [{ status: "SCHEDULED", utcDate: "2026-10-03T14:00:00.000Z", prediction: { status: "GENERATED", modelVersion: "x" } }],
    NOW,
  );
  assert.deepEqual(notPublished.map((v) => v.code), ["NON_PUBLIEE"]);

  const noVersion = assertNoStartedMatchInFeed(
    [{ status: "SCHEDULED", utcDate: "2026-10-03T14:00:00.000Z", prediction: { status: "PUBLISHED", modelVersion: "" } }],
    NOW,
  );
  assert.deepEqual(noVersion.map((v) => v.code), ["SANS_VERSION"]);
});

test("§29 — une date illisible ne peut pas être affichée", () => {
  const violations = assertNoStartedMatchInFeed(
    [{ status: "SCHEDULED", utcDate: "date-corrompue", prediction: published }],
    NOW,
  );
  assert.deepEqual(violations.map((v) => v.code), ["DATE_INVALIDE"]);
});

test("§29 — toutes les violations sont signalées, aucune n'est masquée", () => {
  const violations = assertNoStartedMatchInFeed(
    [
      { status: "SCHEDULED", utcDate: "2026-10-03T14:00:00.000Z", prediction: published },
      { status: "FINISHED", utcDate: "2026-09-27T14:00:00.000Z", prediction: published },
      { status: "POSTPONED", utcDate: "2026-10-03T18:00:00.000Z", prediction: null },
    ],
    NOW,
  );
  const indexes = new Set(violations.map((v) => v.index));
  assert.deepEqual([...indexes].sort(), [1, 2]);
});
