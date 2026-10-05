/**
 * ============================================================================
 * SOLEIL — Tests de la règle de fraîcheur des prédictions
 * ============================================================================
 * La règle décide si un recalcul est légitime et pour quel motif. Elle est
 * pure : aucune base, aucun réseau. Trois propriétés :
 *
 *   1. enrichissement du contexte après génération → « context enriched » ;
 *   2. prédiction trop vieille pour un match à jouer → « stale prediction » ;
 *   3. rien de changé et prédiction jeune → aucun recalcul (pas de boucle).
 *
 * 🔒 Aucune base, aucun réseau.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { refreshReason, STALE_MAX_AGE_MS } from "../freshness";

const NOW = new Date("2026-10-05T20:00:00Z");

test("contexte enrichi après génération → motif « context enriched »", () => {
  const generatedAt = new Date("2026-10-05T18:49:00Z");
  const contextUpdatedAt = new Date("2026-10-05T19:30:00Z"); // import postérieur
  assert.equal(refreshReason(generatedAt, contextUpdatedAt, NOW), "context enriched");
});

test("prédiction de plus de 24 h sur match à venir → motif « stale prediction »", () => {
  const generatedAt = new Date(NOW.getTime() - STALE_MAX_AGE_MS - 60_000);
  assert.equal(refreshReason(generatedAt, null, NOW), "stale prediction");
});

test("prédiction jeune et contexte inchangé → aucun recalcul", () => {
  const generatedAt = new Date(NOW.getTime() - 60 * 60 * 1000); // 1 h
  assert.equal(refreshReason(generatedAt, null, NOW), null);
  // Contexte antérieur à la génération : inchangé.
  const contextUpdatedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
  assert.equal(refreshReason(generatedAt, contextUpdatedAt, NOW), null);
});

test("le motif « context enriched » prime sur la péremption", () => {
  const generatedAt = new Date(NOW.getTime() - STALE_MAX_AGE_MS * 2);
  const contextUpdatedAt = new Date(NOW.getTime() - 1000);
  assert.equal(refreshReason(generatedAt, contextUpdatedAt, NOW), "context enriched");
});

test("limite exacte : 24 h n'est pas encore périmé", () => {
  const generatedAt = new Date(NOW.getTime() - STALE_MAX_AGE_MS);
  assert.equal(refreshReason(generatedAt, null, NOW), null);
  const justOver = new Date(NOW.getTime() - STALE_MAX_AGE_MS - 1);
  assert.equal(refreshReason(justOver, null, NOW), "stale prediction");
});
