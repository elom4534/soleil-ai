import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectIntent } from "../engine";

/**
 * La détection d'intention est le seul point de l'agent qui interprète du texte
 * libre. Elle est donc testée explicitement, y compris sur les questions
 * d'exemple du cahier des charges (§16).
 */
describe("Détection d'intention de SOLEIL AI", () => {
  const cases: [string, string][] = [
    ["Pourquoi Soleil pense que cette équipe va gagner ?", "why_winner"],
    ["Pourquoi Paris va gagner ?", "why_winner"],
    ["Qui va remporter ce match ?", "why_winner"],
    ["Pourquoi Over 2.5 possède une forte probabilité ?", "why_over25"],
    ["Quel est le total de buts attendu ?", "why_over25"],
    ["Quel est le score le plus probable ?", "most_likely_score"],
    ["Quel score exact pour ce match ?", "most_likely_score"],
    ["Quelle mi-temps semble la plus susceptible de produire des buts ?", "which_half"],
    ["Quelle équipe possède l'avantage offensif ?", "offensive_advantage"],
    ["Comment le score de confiance est-il calculé ?", "confidence_explanation"],
    ["Quelle est la qualité des données ?", "data_quality"],
    ["Les deux équipes marquent ?", "btts"],
    ["BTTS Oui ou Non ?", "btts"],
    ["Comment fonctionne le moteur SOLEIL ?", "method"],
    ["Quels modèles utilisez-vous ?", "method"],
  ];

  for (const [question, expected] of cases) {
    it(`« ${question} » → ${expected}`, () => {
      assert.equal(detectIntent(question), expected);
    });
  }

  it("retourne « unknown » sur une question hors périmètre", () => {
    assert.equal(detectIntent("Quelle est la recette de la tarte aux pommes ?"), "unknown");
    assert.equal(detectIntent("bonjour"), "unknown");
  });
});
