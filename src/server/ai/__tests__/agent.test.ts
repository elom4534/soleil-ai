/**
 * ============================================================================
 * SOLEIL AI — Tests de compréhension de l'agent d'enquête
 * ============================================================================
 * Les cinq intentions du cahier des charges sont détectées sur des questions
 * réelles. 🔒 Aucune base, aucun réseau.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { understand } from "../agent";

test("« Est-ce que ce match est fiable ? » → analyse de fiabilité", () => {
  assert.equal(understand("Est-ce que ce match est fiable ?").intent, "reliability");
  assert.equal(understand("Peut-on faire confiance à cette prédiction ?").intent, "reliability");
});

test("« Pourquoi cette prédiction ? » → facteurs explicatifs", () => {
  assert.equal(understand("Pourquoi cette prédiction ?").intent, "explain_prediction");
  assert.equal(understand("Explique-moi d'où vient ce pronostic").intent, "explain_prediction");
});

test("« Quelle équipe a l'avantage ? » → comparaison", () => {
  assert.equal(understand("Quelle équipe a l'avantage ?").intent, "compare_teams");
  assert.equal(understand("Arsenal ou Leeds, qui est favori ?").intent, "compare_teams");
});

test("« Que s'est-il passé récemment ? » → recherche du récent", () => {
  assert.equal(understand("Que s'est-il passé récemment pour cette équipe ?").intent, "recent_news");
});

test("« Analyse complète de Chelsea–Bournemouth » → investigation large", () => {
  assert.equal(understand("Donne-moi une analyse complète de Chelsea-Bournemouth").intent, "full_analysis");
});

test("Blessures/absences → demande de recherche web détectée", () => {
  assert.equal(understand("Qui est blessé ou suspendu pour demain ?").wantsWeb, true);
  assert.equal(understand("Quelle est la composition probable ?").wantsWeb, true);
  assert.equal(understand("Qui est l'entraîneur actuel ?").wantsWeb, true);
});

test("« demain » est repéré comme ancre temporelle", () => {
  assert.equal(understand("Qui gagne demain ?").dateHint, "demain");
});
