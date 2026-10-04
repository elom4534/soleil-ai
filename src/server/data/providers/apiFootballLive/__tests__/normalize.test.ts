/**
 * ============================================================================
 * SOLEIL — Tests de normalisation LiveFootballApi
 * ============================================================================
 * Ces tests protègent contre les défauts constatés pendant l'audit du
 * 29/09/2026. Leur enjeu commun : **aucune donnée absente ne doit devenir un
 * zéro**. Un zéro inventé est plus dangereux qu'une absence, parce qu'il
 * ressemble à une mesure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeTeamRecord,
  getTeamMatches,
  getStandings,
  getAvailableCompetitions,
} from "../adapter";
import {
  goalsByHalf,
  mapStatLabel,
  normalizeEvents,
  normalizeMatch,
  normalizeMatchList,
  normalizeStats,
  normalizeStatus,
  parseScore,
  parseStatValue,
} from "../normalize";
import type { ApiFootballLiveClient } from "../client";

// ---------------------------------------------------------------------------
// Valeurs
// ---------------------------------------------------------------------------

test("parseStatValue : convertit les chaînes du fournisseur sans inventer de zéro", () => {
  assert.deepEqual(parseStatValue("62%"), { value: 62, unit: "percent", raw: "62%" });
  assert.deepEqual(parseStatValue("1.84"), { value: 1.84, unit: "count", raw: "1.84" });
  assert.deepEqual(parseStatValue("0,36"), { value: 0.36, unit: "count", raw: "0,36" });
  assert.deepEqual(parseStatValue("14"), { value: 14, unit: "count", raw: "14" });
});

test("parseStatValue : une absence reste une absence, jamais un zéro", () => {
  for (const empty of [null, undefined, "", "-", "—", "N/A"]) {
    const parsed = parseStatValue(empty);
    assert.equal(parsed.value, null, `valeur attendue nulle pour ${JSON.stringify(empty)}`);
  }
});

test("parseScore : distingue l'absence d'un score de 0", () => {
  assert.equal(parseScore(0), 0);
  assert.equal(parseScore("0"), 0);
  assert.equal(parseScore(null), null);
  assert.equal(parseScore(undefined), null);
  assert.equal(parseScore(""), null);
});

// ---------------------------------------------------------------------------
// Libellés de statistiques — tolérance aux fautes du fournisseur
// ---------------------------------------------------------------------------

test("mapStatLabel : reconnaît le xG et le xG sur coups de pied arrêtés séparément", () => {
  assert.equal(mapStatLabel("Expected Goals (xG)"), "xg");
  assert.equal(mapStatLabel("xG from Set Pieces"), "xgSetPieces");
  // Le second ne doit JAMAIS être confondu avec le premier.
  assert.notEqual(mapStatLabel("xG from Set Pieces"), "xg");
});

test("mapStatLabel : tolère la faute de frappe réelle du fournisseur", () => {
  // Libellé relevé tel quel dans une réponse réelle (sic).
  assert.equal(mapStatLabel("Ppda Opppostition Passes"), "ppdaOppositionPasses");
  assert.equal(mapStatLabel("Ppda Opposition Passes"), "ppdaOppositionPasses");
  assert.equal(mapStatLabel("Ppda Defensive Actions"), "ppdaDefensiveActions");
});

test("mapStatLabel : ne confond pas un second jaune avec un jaune", () => {
  assert.equal(mapStatLabel("Second Yellow Card"), "secondYellow");
  assert.equal(mapStatLabel("Yellow Cards"), "yellowCards");
  assert.equal(mapStatLabel("Direct Red Card"), "directRed");
  assert.equal(mapStatLabel("Red Cards"), "redCards");
});

test("mapStatLabel : renvoie null pour un libellé inconnu plutôt que de deviner", () => {
  assert.equal(mapStatLabel("Statistique inventée par le fournisseur"), null);
});

test("normalizeStats : signale les libellés non reconnus au lieu de les perdre", () => {
  const stats = normalizeStats([
    { label: "Possession", home: "62%", away: "38%" },
    { label: "Nouveau Libellé", home: "3", away: "5" },
  ]);
  assert.equal(stats.home.values.possession?.value, 62);
  assert.equal(stats.away.values.possession?.value, 38);
  assert.deepEqual(stats.home.unmappedLabels, ["Nouveau Libellé"]);
});

test("normalizeStats : une statistique absente d'un côté reste nulle de ce côté", () => {
  const stats = normalizeStats([{ label: "Corners", home: "7", away: null }]);
  assert.equal(stats.home.values.corners?.value, 7);
  assert.equal(stats.away.values.corners?.value, null);
});

// ---------------------------------------------------------------------------
// Statuts — deux formats coexistent chez le fournisseur
// ---------------------------------------------------------------------------

test("normalizeStatus : gère le format « objet » des endpoints de matchs", () => {
  assert.equal(normalizeStatus({ status: "live", state: "inPlay" }), "live");
  assert.equal(normalizeStatus({ status: "finished", state: "postGame" }), "finished");
  assert.equal(normalizeStatus({ status: "upcoming", state: "preGame" }), "scheduled");
});

test("normalizeStatus : gère le format « chaîne » des endpoints d'équipes", () => {
  // Sans cette prise en charge, tous les matchs passés paraîtraient non joués.
  assert.equal(normalizeStatus("FT"), "finished");
  assert.equal(normalizeStatus("Scheduled"), "scheduled");
});

test("normalizeStatus : reconnaît reports et annulations", () => {
  assert.equal(normalizeStatus({ state: "postponed" }), "postponed");
  assert.equal(normalizeStatus("Cancelled"), "cancelled");
  assert.equal(normalizeStatus(null), "unknown");
});

// ---------------------------------------------------------------------------
// Rencontres
// ---------------------------------------------------------------------------

test("normalizeMatch : un score présent sur un match non terminé n'est pas un résultat", () => {
  // Un match en cours porte un score provisoire : le prendre pour un résultat
  // fausserait silencieusement toute la mesure.
  const live = normalizeMatch({
    id: "m1",
    date: "2026-09-29",
    kickoff: "14:00",
    status: { status: "live", state: "inPlay", is_live: true },
    home: { id: "h", name: "H", score: "2" },
    away: { id: "a", name: "A", score: "1" },
    halftime: { home: 1, away: 0 },
  });
  assert.equal(live.status, "live");
  assert.equal(live.finalScore, null);
  assert.equal(live.home.score, 2);
});

test("normalizeMatch : un match terminé livre son résultat", () => {
  const finished = normalizeMatch({
    id: "m2",
    date: "2026-09-26",
    status: { status: "finished", state: "postGame" },
    home: { id: "h", name: "H", score: "2" },
    away: { id: "a", name: "A", score: "1" },
    halftime: { home: 1, away: 0 },
  });
  assert.deepEqual(finished.finalScore, { home: 2, away: 1 });
  assert.deepEqual(finished.halftime, { home: 1, away: 0 });
});

test("normalizeMatch : un match à venir ne produit ni score ni mi-temps", () => {
  const upcoming = normalizeMatch({
    id: "m3",
    date: "2026-10-03",
    status: { status: "upcoming", state: "preGame" },
    home: { id: "h", name: "H", score: null },
    away: { id: "a", name: "A", score: null },
    halftime: { home: null, away: null },
  });
  assert.equal(upcoming.status, "scheduled");
  assert.equal(upcoming.finalScore, null);
  assert.equal(upcoming.halftime.home, null);
});

test("normalizeMatch : extrait l'horaire du champ date quand kickoff est absent", () => {
  const fromTeamMatches = normalizeMatch({
    id: "m4",
    date: "2026-08-17 14:00:00",
    status: "FT",
    home: { id: "h", name: "H", score: 1 },
    away: { id: "a", name: "A", score: 0 },
  });
  assert.equal(fromTeamMatches.date, "2026-08-17");
  assert.equal(fromTeamMatches.kickoff, "14:00");
});

test("normalizeMatchList : lit les trois formes de réponse", () => {
  const fromMatches = normalizeMatchList({
    data: { matches: [{ id: "1", status: "FT", home: { id: "h", name: "H", score: 1 }, away: { id: "a", name: "A", score: 0 } }] },
  });
  const fromWeeks = normalizeMatchList({
    data: {
      weeks: [
        { week: "1", matches: [{ id: "2", status: "FT", home: { id: "h", name: "H", score: 2 }, away: { id: "a", name: "A", score: 2 } }] },
        { week: "2", matches: [{ id: "3", status: "FT", home: { id: "h2", name: "H2", score: 0 }, away: { id: "a2", name: "A2", score: 1 } }] },
      ],
    },
  });
  assert.equal(fromMatches.length, 1);
  assert.equal(fromWeeks.length, 2);
});

test("normalizeMatchList : écarte les rencontres sans identifiant ou sans équipes", () => {
  const list = normalizeMatchList({
    data: { matches: [{ id: "1", status: "FT" }, { id: "2", status: "FT", home: { id: "h", name: "H" }, away: { id: "a", name: "A" } }] },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].providerId, "2");
});

// ---------------------------------------------------------------------------
// Événements et mi-temps dérivées
// ---------------------------------------------------------------------------

test("goalsByHalf : répartit les buts par mi-temps à partir des minutes", () => {
  const events = normalizeEvents([
    { time: "23", type: "goal", side: "home", detail: { score: "1-0" } },
    { time: "45+2", type: "goal", side: "away", detail: {} },
    { time: "67", type: "goal", side: "home", detail: {} },
    { time: "88", type: "own_goal", side: "away", detail: {} },
    { time: "30", type: "yellow_card", side: "home", detail: {} },
  ]);

  const halves = goalsByHalf(events);
  assert.deepEqual(halves.firstHalf, { home: 1, away: 1, known: true });
  assert.deepEqual(halves.secondHalf, { home: 1, away: 1, known: true });
});

test("goalsByHalf : un but sans minute n'est affecté à aucune période", () => {
  // L'affecter au hasard inventerait une donnée : il est simplement écarté.
  const events = normalizeEvents([{ time: null, type: "goal", side: "home", detail: {} }]);
  const halves = goalsByHalf(events);
  assert.deepEqual(halves.firstHalf, { home: 0, away: 0, known: true });
  assert.deepEqual(halves.secondHalf, { home: 0, away: 0, known: true });
});

// ---------------------------------------------------------------------------
// Bilan d'équipe — le bug corrigé pendant l'audit
// ---------------------------------------------------------------------------

test("computeTeamRecord : les rencontres non jouées ne comptent pas comme des nuls", () => {
  const matches = normalizeMatchList({
    data: {
      matches: [
        { id: "1", date: "2026-08-17 14:00:00", status: "FT", home: { id: "T", name: "T", score: 3 }, away: { id: "x", name: "X", score: 0 } },
        { id: "2", date: "2026-08-24 14:00:00", status: "FT", home: { id: "y", name: "Y", score: 1 }, away: { id: "T", name: "T", score: 1 } },
        { id: "3", date: "2027-01-01 15:00:00", status: "Scheduled", home: { id: "T", name: "T", score: null }, away: { id: "z", name: "Z", score: null } },
        { id: "4", date: "2027-01-08 15:00:00", status: "Scheduled", home: { id: "T", name: "T", score: null }, away: { id: "w", name: "W", score: null } },
      ],
    },
  });

  const record = computeTeamRecord(matches, "T");
  assert.equal(record.played, 2, "seules les rencontres jouées comptent");
  assert.equal(record.wins, 1);
  assert.equal(record.draws, 1);
  assert.equal(record.losses, 0);
  assert.equal(record.goalsFor, 4);
  assert.equal(record.goalsAgainst, 1);
  assert.equal(record.homePlayed, 1);
});

// ---------------------------------------------------------------------------
// Adaptateur — avec un client simulé
// ---------------------------------------------------------------------------

/**
 * Client factice : reproduit le contrat RÉEL du client, qui extrait `raw.data`
 * (dataPath = ["data"]) avant de rendre la main. Un factice qui rendrait
 * l'enveloppe complète ferait passer des tests sur un contrat qui n'existe pas.
 */
function fakeClient(envelope: Record<string, unknown>): ApiFootballLiveClient {
  return {
    call: async <T,>() => ({
      data: envelope.data as T,
      raw: envelope,
      fromCache: false,
      stale: false,
      creditsSpent: 0,
      statusCode: 200,
      headers: {},
    }),
  } as unknown as ApiFootballLiveClient;
}

test("getAvailableCompetitions : aplatit les pays et compte les compétitions", async () => {
  const client = fakeClient({
    data: {
      total_countries: 2,
      language: "en",
      data: [
        { country: "England", leagues: [{ id: "lfa-pl", name: "Premier League", logo: "u1" }] },
        { country: "Togo", leagues: [{ id: "lfa-tg", name: "National Championship", logo: "u2" }] },
      ],
    },
  });
  const { data } = await getAvailableCompetitions(client);
  assert.equal(data.totalCountries, 2);
  assert.equal(data.totalCompetitions, 2);
  assert.equal(data.competitions[1].country, "Togo");
  assert.equal(data.competitions[1].logo, "u2");
});

test("getStandings : sépare classement général, domicile et extérieur", async () => {
  const client = fakeClient({
    data: {
      season: "2026/2027",
      available_seasons: ["2026/2027", "2025/2026"],
      stale: false,
      standings: [{ title: "L", table: [{ rank: 1, team: { id: "t1", name: "T1", logo: "l" }, played: 6, points: 16, goals_for: 14, goal_diff: 9, form: "WWDLW", zone: { name: "CL" } }] }],
      home_standings: [{ table: [{ rank: 1, team: { id: "t1", name: "T1" }, points: 9 }] }],
      away_standings: [{ table: [{ rank: 2, team: { id: "t1", name: "T1" }, points: 7 }] }],
    },
  });
  const { data } = await getStandings(client, "lfa-pl");
  assert.equal(data.overall[0].points, 16);
  assert.equal(data.overall[0].form, "WWDLW");
  assert.equal(data.home.length, 1);
  assert.equal(data.away.length, 1);
  assert.deepEqual(data.availableSeasons, ["2026/2027", "2025/2026"]);
});

test("getTeamMatches : lit la forme « data.matches »", async () => {
  const client = fakeClient({
    data: {
      team_id: "t1",
      season: "2026/2027",
      available_seasons: ["2026/2027"],
      matches: [
        { id: "m1", date: "2026-08-17 14:00:00", status: "FT", home: { id: "t1", name: "T1", score: 2 }, away: { id: "z", name: "Z", score: 0 } },
      ],
    },
  });
  const { data } = await getTeamMatches(client, "t1");
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].status, "finished");
  assert.deepEqual(data.matches[0].finalScore, { home: 2, away: 0 });
});
