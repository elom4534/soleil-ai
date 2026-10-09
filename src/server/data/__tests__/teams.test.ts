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

describe("Identités distinctes — non-régression de l'audit 2026-10-08", () => {
  it("ne confond jamais deux clubs différents", () => {
    // « real » et « atletico » distinguent des clubs : ce ne sont pas des
    // mots-outils. Les retirer de la clé canonique fusionnait Real Madrid et
    // Atlético Madrid sous la même clé « madrid » (86 matchs pour une seule
    // identité en saison 2026/2027, dont 18 adversaires rencontrés 4 fois).
    assert.notEqual(canonicalTeamKey("Real Madrid"), canonicalTeamKey("Atlético Madrid"));
    assert.notEqual(teamSlug("Real Madrid"), teamSlug("Atlético Madrid"));
    assert.notEqual(canonicalTeamKey("Paris FC"), canonicalTeamKey("Paris SG"));
    assert.notEqual(canonicalTeamKey("Dinamo Batumi"), canonicalTeamKey("Dinamo Zagreb"));
    assert.notEqual(canonicalTeamKey("Partizani"), canonicalTeamKey("FK Partizan"));
    assert.notEqual(canonicalTeamKey("Tre Penne"), canonicalTeamKey("Tre Fiori"));
    assert.notEqual(canonicalTeamKey("Dominica"), canonicalTeamKey("Dominican Republic"));
    assert.notEqual(canonicalTeamKey("British Virgin Islands"), canonicalTeamKey("United States Virgin Islands"));
    assert.notEqual(canonicalTeamKey("Viking"), canonicalTeamKey("Vikingur Reykjavik"));
    assert.notEqual(canonicalTeamKey("Floriana"), canonicalTeamKey("Flora Tallinn"));
    assert.notEqual(canonicalTeamKey("Maccabi Haifa"), canonicalTeamKey("Maccabi Tel Aviv"));
    // Sint Maarten (partie néerlandaise) et Saint Martin (partie française)
    // sont deux sélections distinctes de la même île : jamais fusionner.
    assert.notEqual(canonicalTeamKey("Sint Maarten"), canonicalTeamKey("Saint Martin"));
  });

  it("rapproche les libellés d'une même équipe réelle", () => {
    // Formes courtes football-data.co.uk et formes longues des autres
    // fournisseurs. Chaque paire a été vérifiée en base : deux lignes Team
    // pour un seul club, dont l'une presque vide.
    const paires: [string, string][] = [
      ["Ath Madrid", "Atlético Madrid"],
      ["Ath Bilbao", "Athletic Bilbao"],
      ["Celta", "Celta Vigo"],
      ["Espanol", "Espanyol"],
      ["Sociedad", "R. Sociedad"],
      ["Vallecano", "Rayo Vallecano"],
      ["Alaves", "Deportivo Alavés"],
      ["La Coruna", "A Coruña"],
      ["Mainz", "Mainz 05"],
      ["RB Leipzig", "Leipzig"],
      ["Coventry City", "Coventry"],
      ["Ipswich Town", "Ipswich"],
      ["Club Brugge KV", "Club Brugge"],
      ["Shakhtar Donetsk", "Shakhtar"],
      ["Shamrock Rovers", "Shamrock"],
      ["Slavia Praha", "Slavia Prag"],
      ["Turkey", "Türkiye"],
      ["Czech Republic", "Czechia"],
      ["Cayman Islands", "Cayman"],
      ["Trinidad and Tobago", "Trinidad & Tobago"],
      ["St. Kitts and Nevis", "Saint Kitts and Nevis"],
      ["French Guiana", "French Guyana"],
      ["St. Vincent / Grenadines", "St. Vincent"],
      ["St. Vincent / Grenadines", "Saint Vincent and the Grenadines"],
      ["St. Vincent / Grenadines", "St. Vincent and the Grenadines"],
    ];
    for (const [a, b] of paires) {
      assert.equal(canonicalTeamKey(a), canonicalTeamKey(b), `${a} ≠ ${b}`);
    }
  });

  it("les alias historiques restent atteignables", () => {
    // Ces trois entrées de la table étaient mortes : le normaliseur retirait
    // « real » avant la consultation, donc la clé « real betis » n'existait
    // jamais. Elles s'appliquent désormais.
    assert.equal(canonicalTeamKey("Real Betis"), "betis");
    assert.equal(canonicalTeamKey("Real Sociedad"), "sociedad");
    assert.equal(canonicalTeamKey("Atlético Madrid"), "atletico madrid");
  });

  it("resolveTeamId n'attribue pas Real Madrid à Atlético Madrid", () => {
    const known = [
      { id: "atletico", name: "Atlético Madrid" },
      { id: "barca", name: "Barcelona" },
    ];
    assert.equal(resolveTeamId("Atlético Madrid", known), "atletico");
    assert.equal(resolveTeamId("Ath Madrid", known), "atletico");
    assert.equal(resolveTeamId("Real Madrid", known), null, "pas de fusion à l'aveugle");
    assert.equal(resolveTeamId("Barcelona", known), "barca");
  });
});
