/**
 * ============================================================================
 * SOLEIL — Tests du suivi des crédits (LiveFootballApi)
 * ============================================================================
 * Enjeu : la phase 10 exige que **chaque appel payant soit traçable**
 * (crédits avant / après, endpoint, nombre d'appels) et qu'un API CREDIT
 * MONITOR puisse afficher les crédits restants.
 *
 * Or LiveFootballApi publie son solde dans le CORPS de la réponse
 * (`credits_remaining`) et non dans les en-têtes. Lire les en-têtes laissait
 * `ApiCallLog.quotaAfter` vide en base — défaut constaté le 29/09/2026 sur les
 * 36 appels journalisés. Ces tests protègent la correction.
 *
 * Règle : un solde absent reste absent. On ne l'estime jamais, on ne le
 * déduit jamais d'un compteur local.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readBodyQuota } from "../client";

test("readBodyQuota lit le solde réel de l'enveloppe du fournisseur", () => {
  // Réponse réelle observée : enveloppe LiveFootballApi.
  const envelope = {
    success: true,
    message: null,
    timestamp: "2026-09-29T22:23:50+00:00",
    credits_remaining: 464,
    data: { matches: [] },
  };
  assert.deepEqual(readBodyQuota(envelope), { remaining: 464 });
});

test("readBodyQuota tolère un solde transmis sous forme de chaîne", () => {
  // La documentation affirme des nombres JSON, ses exemples montrent des
  // chaînes : on parse défensivement.
  assert.deepEqual(readBodyQuota({ credits_remaining: "464" }), { remaining: 464 });
});

test("readBodyQuota accepte la variante camelCase", () => {
  assert.deepEqual(readBodyQuota({ creditsRemaining: 12 }), { remaining: 12 });
});

test("readBodyQuota renvoie null quand le solde est absent — jamais une estimation", () => {
  assert.equal(readBodyQuota({ success: true, data: {} }), null);
  assert.equal(readBodyQuota({ credits_remaining: null }), null);
  assert.equal(readBodyQuota({ credits_remaining: "" }), null);
  assert.equal(readBodyQuota({ credits_remaining: "n/a" }), null);
});

test("readBodyQuota ne déduit pas un solde de `credits_used`", () => {
  // Utiliser « crédits utilisés » pour deviner « crédits restants » serait une
  // invention : la consommation totale du compte est inconnue côté client.
  assert.equal(readBodyQuota({ credits_used: 3 }), null);
});

test("readBodyQuota résiste aux corps inattendus", () => {
  assert.equal(readBodyQuota(null), null);
  assert.equal(readBodyQuota(undefined), null);
  assert.equal(readBodyQuota("464"), null);
  assert.equal(readBodyQuota(464), null);
  assert.equal(readBodyQuota([]), null);
});

test("un solde de zéro crédit est conservé tel quel", () => {
  // Zéro est une mesure, pas une absence : ne pas le confondre avec `null`.
  assert.deepEqual(readBodyQuota({ credits_remaining: 0 }), { remaining: 0 });
});
