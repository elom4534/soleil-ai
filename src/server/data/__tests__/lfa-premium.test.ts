/**
 * ============================================================================
 * SOLEIL — Tests des données premium (Live Football API)
 * ============================================================================
 * Logique pure uniquement : 🔒 aucun réseau, aucune base, aucune clé.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { lfaStatusToInternal, num, lfaKeys } from "../providers/liveFootballApiV1";
import { lfaSeasonLabel, LFA_LEAGUES } from "../lfaPremium";

test("statuts LFA → statuts internes", () => {
  assert.equal(lfaStatusToInternal({ status: "finished", state: "postGame" }), "finished");
  assert.equal(lfaStatusToInternal({ status: "FT" }), "finished");
  assert.equal(lfaStatusToInternal({ status: "live", state: "inPlay", is_live: true }), "live");
  assert.equal(lfaStatusToInternal({ status: "postponed" }), "postponed");
  assert.equal(lfaStatusToInternal({ status: "cancelled" }), "cancelled");
  assert.equal(lfaStatusToInternal({ status: "scheduled" }), "scheduled");
  assert.equal(lfaStatusToInternal("11"), "scheduled");
});

test("conversion numérique tolérante", () => {
  assert.equal(num("2"), 2);
  assert.equal(num(3), 3);
  assert.equal(num("62%"), 62);
  assert.equal(num(null), null);
  assert.equal(num("abc"), null);
});

test("saison LFA : juillet bascule sur la nouvelle saison", () => {
  assert.equal(lfaSeasonLabel(new Date("2026-10-06")), "2026/2027");
  assert.equal(lfaSeasonLabel(new Date("2026-02-10")), "2025/2026");
});

test("cartographie des compétitions prioritaires complète (10)", () => {
  assert.equal(Object.keys(LFA_LEAGUES).length, 10);
  for (const code of ["UNL", "CCNL", "E0", "SP1", "I1", "D1", "F1", "UCL", "UEL", "ECL"]) {
    assert.ok(LFA_LEAGUES[code], `compétition ${code} cartographiée`);
    assert.ok(LFA_LEAGUES[code].length > 10, `identifiant LFA réel pour ${code}`);
  }
});

test("les clés ne sont lues que depuis l'environnement, jamais exposées", () => {
  const saved = process.env.LFA_API_KEYS;
  delete process.env.LFA_API_KEYS;
  assert.deepEqual(lfaKeys(), []);
  process.env.LFA_API_KEYS = "fake_key_for_test_only_0123456789";
  assert.equal(lfaKeys().length, 1);
  if (saved === undefined) delete process.env.LFA_API_KEYS;
  else process.env.LFA_API_KEYS = saved;
});
