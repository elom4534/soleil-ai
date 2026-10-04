import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTeamKey,
  normalizeTeamName,
  resolveTeamId,
  teamNameSimilarity,
  teamSlug,
} from "../teams";
import { num, parseCsv } from "../providers/csv";
import { toSeasonCode } from "../providers/footballDataCoUk";

describe("Rapprochement des noms d'équipes", () => {
  it("normalise la casse, les accents et les suffixes de club", () => {
    assert.equal(normalizeTeamName("Manchester United FC"), "manchester united");
    assert.equal(normalizeTeamName("Bayern München"), "bayern munchen");
    assert.equal(normalizeTeamName("AS Saint-Étienne"), "saint etienne");
  });

  it("applique les alias documentés", () => {
    assert.equal(canonicalTeamKey("Man United"), "manchester united");
    assert.equal(canonicalTeamKey("Man City"), "manchester city");
    assert.equal(teamSlug("Wolves"), "wolverhampton-wanderers");
  });

  it("mesure correctement la similarité", () => {
    assert.equal(teamNameSimilarity("Arsenal", "Arsenal"), 1);
    const mixed = teamNameSimilarity("Manchester United", "Manchester City");
    assert.ok(mixed > 0 && mixed < 1, `similarité inattendue : ${mixed}`);
    assert.equal(teamNameSimilarity("Arsenal", "zzz"), 0);
  });

  it("résout vers l'identifiant existant sans créer de doublon", () => {
    const known = [
      { id: "1", name: "Manchester United", shortName: "Man United", tla: "MUN" },
      { id: "2", name: "Manchester City", shortName: "Man City", tla: "MCI" },
    ];
    assert.equal(resolveTeamId("Man United", known), "1");
    assert.equal(resolveTeamId("Manchester United FC", known), "1");
    assert.equal(resolveTeamId("Manchester City", known), "2");
  });

  it("refuse de fusionner en cas de doute (§34)", () => {
    const known = [{ id: "1", name: "Arsenal", shortName: "Arsenal", tla: "ARS" }];
    assert.equal(resolveTeamId("Aston Villa", known), null);
    assert.equal(resolveTeamId("Totalement Inconnu", known), null);
  });
});

describe("Analyse CSV", () => {
  it("gère le BOM, les guillemets et les valeurs manquantes", () => {
    const csv = '\uFEFFA,B,C\n1,"texte, avec virgule",3\n4,,6\n';
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].B, "texte, avec virgule");
    assert.equal(rows[1].B, "");
  });

  it("convertit les nombres et retourne null sur les cellules vides", () => {
    assert.equal(num("3"), 3);
    assert.equal(num("2.75"), 2.75);
    assert.equal(num(""), null);
    assert.equal(num("-"), null);
    assert.equal(num(undefined), null);
    assert.equal(num("abc"), null);
  });
});

describe("Codes de saison", () => {
  it("convertit une saison en code source", () => {
    assert.equal(toSeasonCode("2026/2027"), "2627");
    assert.equal(toSeasonCode("2025/2026"), "2526");
    assert.equal(toSeasonCode("2026"), "2627");
  });

  it("rejette une saison invalide", () => {
    assert.throws(() => toSeasonCode("saison-inconnue"));
  });
});
