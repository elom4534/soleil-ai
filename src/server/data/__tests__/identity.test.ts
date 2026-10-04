/**
 * ============================================================================
 * SOLEIL — Phase 16 · §28 · Tests des doublons, des identités et des logos
 * ============================================================================
 * Trois familles de pièges, testées ici sans base ni réseau :
 *
 *   · **doublons** (§10) — deux écritures de la même rencontre ne doivent pas
 *     produire deux rencontres, donc deux prédictions ;
 *   · **identités** (§17) — un nom n'est pas un identifiant : sans identifiant
 *     fournisseur, la fusion reste approximative et doit être signalée ;
 *   · **logos** (§15, §30) — aucune URL n'est construite ; un logo absent reste
 *     absent, l'affichage se rabattra sur le monogramme.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTeamIdentity,
  decideMatch,
  fallbackMatchKeys,
  isTestFixture,
  providerMatchKey,
  providerRef,
  relaxedTeamKey,
  TEST_FIXTURE_PREFIX,
} from "../identity";
import { normalizeTeamName, teamSlug, resolveTeamId } from "../teams";
import { LFA_PROVIDER_NAME, kickoffToUtc, toCommonStatus, extractSideload } from "../providers/liveFootballApi";
import { normalizeMatch } from "../providers/apiFootballLive/normalize";

/* -------------------------------------------------------------------------- */
/* §17 — Identifiants fournisseur                                              */
/* -------------------------------------------------------------------------- */

test("§17 — l'identifiant fournisseur est conservé tel quel, avec sa source", () => {
  assert.equal(providerRef("live-football-api", "3u9qf9ju8eym4g8qsa0avfjm2"), "live-football-api:3u9qf9ju8eym4g8qsa0avfjm2");
  // Un identifiant absent ne se remplace jamais par un nom : `null`, pas « ».
  assert.equal(providerRef("live-football-api", ""), null);
  assert.equal(providerRef("live-football-api", "   "), null);
  assert.equal(providerRef("live-football-api", null), null);
  assert.equal(providerMatchKey("live-football-api", "abc123"), "live-football-api:abc123");
});

test("§17 — une identité sans identifiant fournisseur est déclarée faible", () => {
  const strong = buildTeamIdentity(
    { providerId: "abc", providerName: "Arsenal", logo: "https://live-football-api.com/teams/abc.png" },
    "live-football-api",
  );
  assert.equal(strong.strongIdentity, true);
  assert.equal(strong.name, "Arsenal");
  assert.equal(strong.crest, "https://live-football-api.com/teams/abc.png");

  const weak = buildTeamIdentity({ providerName: "Arsenal FC" }, "live-football-api");
  assert.equal(weak.strongIdentity, false, "sans identifiant, le rapprochement par nom reste approximatif");
  assert.equal(weak.providerRef, null);
});

test("§15 — un logo absent n'est jamais fabriqué, un pays jamais déduit du nom", () => {
  const identity = buildTeamIdentity({ providerId: "x", providerName: "Arsenal" }, "live-football-api");
  assert.equal(identity.crest, null, "aucune URL construite à partir de l'identifiant");
  assert.equal(identity.country, null, "aucun pays deviné à partir du nom");
});

/* -------------------------------------------------------------------------- */
/* §10 — Déduplication                                                         */
/* -------------------------------------------------------------------------- */

test("§10 — la clé de secours est bornée à ±1 jour, jamais ouverte", () => {
  const keys = fallbackMatchKeys({
    competition: "code:E0",
    homeTeamId: "h1",
    awayTeamId: "a1",
    dayKey: "2026-10-03",
  });
  assert.equal(keys.length, 3, "exactement trois clés : J-1, J, J+1");
  assert.deepEqual(keys, [
    "code:E0|h1|a1|2026-10-02",
    "code:E0|h1|a1|2026-10-03",
    "code:E0|h1|a1|2026-10-04",
  ]);
});

test("§10 — la clé de secours est vide si la date est illisible", () => {
  assert.deepEqual(
    fallbackMatchKeys({ competition: "code:E0", homeTeamId: "h", awayTeamId: "a", dayKey: "3 octobre" }),
    [],
  );
});

test("§10 — une rencontre déjà connue est mise à jour, jamais recréée", () => {
  const decision = decideMatch({
    providerKey: "live-football-api:abc",
    existingByProviderKey: true,
    fallbackKeys: ["k1"],
    existingFallbackKeys: new Set(),
  });
  assert.equal(decision.action, "update");
  assert.equal(decision.reason, "IDENTIFIANT_FOURNISSEUR");
  assert.equal(decision.approximate, false);
});

test("§10 — la clé de secours rattrape une rencontre que l'identifiant a manquée, et le dit", () => {
  const decision = decideMatch({
    providerKey: "live-football-api:inconnu",
    existingByProviderKey: false,
    fallbackKeys: ["code:E0|h1|a1|2026-10-03"],
    existingFallbackKeys: new Set(["code:E0|h1|a1|2026-10-03"]),
  });
  assert.equal(decision.action, "update");
  assert.equal(decision.reason, "CLE_DE_SECOURS");
  assert.equal(decision.approximate, true, "une fusion approximative doit rester visible dans les rapports");
});

test("§10 — deux rencontres différentes ne fusionnent pas : jours éloignés", () => {
  const decision = decideMatch({
    providerKey: null,
    existingByProviderKey: false,
    fallbackKeys: fallbackMatchKeys({
      competition: "code:E0",
      homeTeamId: "h1",
      awayTeamId: "a1",
      dayKey: "2026-10-10",
    }),
    // La même affiche existait le 3 octobre : à une semaine d'écart, c'est une
    // autre rencontre (coupe, match en retard), pas un doublon.
    existingFallbackKeys: new Set(["code:E0|h1|a1|2026-10-03"]),
  });
  assert.equal(decision.action, "create");
});

test("§10 — deux affiches inversées ne sont pas confondues (domicile / extérieur)", () => {
  const decision = decideMatch({
    providerKey: null,
    existingByProviderKey: false,
    fallbackKeys: fallbackMatchKeys({
      competition: "code:E0",
      homeTeamId: "PSG",
      awayTeamId: "OM",
      dayKey: "2026-10-03",
    }),
    existingFallbackKeys: new Set(["code:E0|OM|PSG|2026-10-03"]),
  });
  assert.equal(decision.action, "create", "l'inversion domicile/extérieur change la rencontre");
});

/* -------------------------------------------------------------------------- */
/* §31 — Séparation test / production                                          */
/* -------------------------------------------------------------------------- */

test("§31 — une rencontre de test est identifiable sans ambiguïté", () => {
  assert.equal(isTestFixture(`${TEST_FIXTURE_PREFIX}match-1`), true);
  assert.equal(isTestFixture("live-football-api:abc"), false);
  assert.equal(isTestFixture(null), false);
  assert.equal(isTestFixture(""), false);
});

/* -------------------------------------------------------------------------- */
/* §17 — Rapprochement avec l'historique existant                              */
/* -------------------------------------------------------------------------- */

test("§17 — le slug canonique est identique à celui de l'ingestion historique", () => {
  // C'est cette égalité qui permet à « Man United » (historique) et
  // « Manchester United » (calendrier) de désigner la même équipe.
  assert.equal(teamSlug("Man United"), teamSlug("Manchester United"));
  assert.equal(teamSlug("Arsenal"), "arsenal");
  // L'apostrophe sépare les jetons : la clé canonique de « Nott'm Forest » ne
  // peut pas rejoindre l'alias « nottm forest ». La clé relâchée, elle, les
  // réunit — c'est ce qui évite une équipe dupliquée sans historique (§12).
  assert.notEqual(teamSlug("Nott'm Forest"), teamSlug("Nottingham Forest"));
  assert.equal(relaxedTeamKey("Nott'm Forest"), relaxedTeamKey("Nottingham Forest"));
  assert.equal(relaxedTeamKey("Nott'm Forest"), "nottingham forest");
  assert.equal(normalizeTeamName("Atlético Madrid"), normalizeTeamName("Atletico Madrid"));
});

test("§17 — le rapprochement par similarité reste soumis à un seuil", () => {
  const known = [
    { id: "t1", name: "Ath Madrid" },
    { id: "t2", name: "Barcelona" },
  ];
  assert.equal(resolveTeamId("Athletic Bilbao", known, 0.72), null, "un nom proche ne suffit pas : pas de fusion à l'aveugle");
  assert.equal(resolveTeamId("Barcelona", known, 0.72), "t2");
});

/* -------------------------------------------------------------------------- */
/* §8, §9 — Conversions issues du calendrier fournisseur                       */
/* -------------------------------------------------------------------------- */

test("§8 — date + heure + UTC → horodatage, sans interprétation locale", () => {
  assert.equal(kickoffToUtc("2026-10-03", "14:00")?.toISOString(), "2026-10-03T14:00:00.000Z");
  assert.equal(kickoffToUtc("2026-10-03", "00:00")?.toISOString(), "2026-10-03T00:00:00.000Z");
  // Sans heure, aucune rencontre n'est inventée à minuit.
  assert.equal(kickoffToUtc("2026-10-03", null), null);
  assert.equal(kickoffToUtc(null, "14:00"), null);
  assert.equal(kickoffToUtc("03/10/2026", "14:00"), null);
});

test("§9 — les statuts du fournisseur sont traduits sans optimisme", () => {
  assert.equal(toCommonStatus("scheduled"), "scheduled");
  assert.equal(toCommonStatus("live"), "live");
  assert.equal(toCommonStatus("half-time"), "live");
  assert.equal(toCommonStatus("finished"), "finished");
  assert.equal(toCommonStatus("postponed"), "postponed");
  assert.equal(toCommonStatus("cancelled"), "cancelled");
  // Valeur volontairement hors nomenclature : un statut inconnu doit rester
  // inclassable plutôt que d'être rangé par défaut dans « programmé ».
  assert.equal(toCommonStatus("inconnu" as never), "unknown");
});

/* -------------------------------------------------------------------------- */
/* §15, §16 — Chargement annexe : identifiants et logos                        */
/* -------------------------------------------------------------------------- */

const RAW_MATCH = {
  id: "axt8dtutmfftyoyayddxy5vro",
  league: { id: "cesdwwnxbc5fmajgroc0hqzy2", name: "Premier League", country: "England" },
  week: "Week 7",
  kickoff: "14:00",
  date: "2026-10-03",
  status: { status: "scheduled", display: "14:00", is_live: false, state: "preGame" },
  home: { id: "home-1", name: "Arsenal", logo: "https://live-football-api.com/teams/home-1.png", score: null },
  away: { id: "away-1", name: "Chelsea", logo: null, score: null },
  halftime: { home: null, away: null },
};

test("§15 — le logo vient de la source, ou n'existe pas", () => {
  const normalized = normalizeMatch(RAW_MATCH);
  const sideload = extractSideload([normalized]);

  const arsenal = sideload.teams.find((t) => t.providerName === "Arsenal");
  const chelsea = sideload.teams.find((t) => t.providerName === "Chelsea");

  assert.equal(arsenal?.logo, "https://live-football-api.com/teams/home-1.png");
  assert.equal(chelsea?.logo, null, "pas de logo publié → aucune URL reconstruite depuis l'identifiant");
});

test("§17 — le chargement annexe conserve les identifiants des deux équipes", () => {
  const normalized = normalizeMatch(RAW_MATCH);
  const sideload = extractSideload([normalized]);
  const externalId = `${LFA_PROVIDER_NAME}:${normalized.providerId}`;

  // Le nom technique vient de la constante du connecteur : si l'étiquette de
  // la source change un jour, le test suit au lieu de diverger en silence.
  assert.deepEqual(sideload.teamRefsByMatch[externalId], {
    homeRef: `${LFA_PROVIDER_NAME}:home-1`,
    awayRef: `${LFA_PROVIDER_NAME}:away-1`,
  });
  assert.equal(sideload.competitionByMatch[externalId]?.country, "England");
  assert.equal(sideload.leagues[0]?.providerName, "Premier League");
  assert.equal(sideload.weekByMatch[externalId], "Week 7");
});

test("§13 — un logo existant n'est jamais effacé par un passage sans logo", () => {
  const withLogo = normalizeMatch({ ...RAW_MATCH, id: "m2" });
  const withoutLogo = normalizeMatch({
    ...RAW_MATCH,
    id: "m3",
    home: { ...RAW_MATCH.home, logo: null },
    away: RAW_MATCH.away,
  });

  const sideload = extractSideload([withLogo, withoutLogo]);
  const arsenal = sideload.teams.find((t) => t.providerId === "home-1");
  assert.equal(arsenal?.logo, "https://live-football-api.com/teams/home-1.png", "le logo connu est conservé");
});
