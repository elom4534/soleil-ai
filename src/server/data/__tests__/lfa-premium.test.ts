/**
 * ============================================================================
 * SOLEIL — Tests des données premium (Live Football API)
 * ============================================================================
 * Logique pure uniquement : 🔒 aucun réseau, aucune base, aucune clé.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lfaStatusToInternal,
  num,
  lfaKeys,
  lfaDailyBudget,
  lfaBudgetExhausted,
  type LfaStatLine,
} from "../providers/liveFootballApiV1";
import { lfaSeasonLabel, LFA_LEAGUES, parsePair } from "../lfaPremium";

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

/* -------------------------------------------------------------------------- */
/* Appariement des libellés — correctif xG du 2026-10-09                       */
/* -------------------------------------------------------------------------- */

/**
 * Libellés RÉELLEMENT renvoyés par `/live_match_details`
 * (Marseille – Paris SG, 2026-09-20, `9oap5rimzh2a51t262izd979w`).
 * Plusieurs se contiennent les uns les autres (« Total Shots » / « Shots on
 * Target » / « Blocked Shots », « Red Cards » / « Direct Red Card ») : c'est
 * exactement le piège que l'appariement « exact d'abord » doit déjouer.
 */
const STATS_REELLES: LfaStatLine[] = [
  { label: "Expected Goals (xG)", home: "1.98", away: "5.09" },
  { label: "xG from Set Pieces", home: "0.31", away: "1.44" },
  { label: "Possession", home: "39", away: "61" },
  { label: "Total Shots", home: "12", away: "31" },
  { label: "Shots on Target", home: "4", away: "10" },
  { label: "Shots off Target", home: "12", away: "12" },
  { label: "Blocked Shots", home: "5", away: "9" },
  { label: "Corners", home: "3", away: "7" },
  { label: "Yellow Cards", home: "3", away: "1" },
  { label: "Second Yellow Card", home: "1", away: "0" },
  { label: "Direct Red Card", home: "0", away: "0" },
  { label: "Red Cards", home: "1", away: "0" },
];

const XG = ["expected goals (xg)", "expected goals"];
const XG_EXCLUS = ["set piece", "half", "penalt"];
const TIRS = ["total shots", "shots"];
const TIRS_EXCLUS = ["on target", "off target", "blocked", "woodwork"];

test("xG : le xG total est pris, jamais celui des coups de pied arrêtés", () => {
  assert.deepEqual(parsePair(STATS_REELLES, XG, XG_EXCLUS), [1.98, 5.09]);
});

test("xG : l'ordre renvoyé par le fournisseur ne change rien", () => {
  assert.deepEqual(parsePair([...STATS_REELLES].reverse(), XG, XG_EXCLUS), [1.98, 5.09]);
});

test("tirs : « Total Shots » est pris, pas « Shots on Target » ni « Blocked Shots »", () => {
  assert.deepEqual(parsePair(STATS_REELLES, TIRS, TIRS_EXCLUS), [12, 31]);
  // Avant le correctif, « shots » capturait « Shots on Target » selon l'ordre.
  assert.deepEqual(parsePair([...STATS_REELLES].reverse(), TIRS, TIRS_EXCLUS), [12, 31]);
});

test("tirs cadrés, corners et possession restent justes", () => {
  assert.deepEqual(parsePair(STATS_REELLES, ["shots on target"]), [4, 10]);
  assert.deepEqual(parsePair(STATS_REELLES, ["corners"]), [3, 7]);
  assert.deepEqual(parsePair(STATS_REELLES, ["possession"]), [39, 61]);
});

test("cartons : le total est pris, pas le second jaune ni le rouge direct", () => {
  assert.deepEqual(parsePair(STATS_REELLES, ["yellow cards", "yellow"], ["second"]), [3, 1]);
  assert.deepEqual(parsePair(STATS_REELLES, ["red cards", "red card"], ["second yellow", "direct"]), [1, 0]);
  assert.deepEqual(parsePair([...STATS_REELLES].reverse(), ["red cards", "red card"], ["second yellow", "direct"]), [1, 0]);
});

test("libellé absent ou valeur illisible : null, jamais d'invention", () => {
  assert.deepEqual(parsePair(STATS_REELLES, ["penalties scored"]), [null, null]);
  assert.deepEqual(parsePair([{ label: "Expected Goals (xG)", home: "N/A", away: null }], XG), [null, null]);
  assert.deepEqual(parsePair([], ["corners"]), [null, null]);
});

test("plafond quotidien : absent, nul ou fantaisiste ferme toute requête payante", () => {
  const saved = process.env.SOLEIL_API_DAILY_BUDGET;
  delete process.env.SOLEIL_API_DAILY_BUDGET;
  assert.equal(lfaDailyBudget(), 0);
  assert.equal(lfaBudgetExhausted(), true, "sans plafond explicite, rien ne part");
  process.env.SOLEIL_API_DAILY_BUDGET = "0";
  assert.equal(lfaDailyBudget(), 0);
  process.env.SOLEIL_API_DAILY_BUDGET = "260";
  assert.equal(lfaDailyBudget(), 260);
  assert.equal(lfaBudgetExhausted(), false);
  process.env.SOLEIL_API_DAILY_BUDGET = "fantaisie";
  assert.equal(lfaDailyBudget(), 0, "une valeur non numérique ne débloque rien");
  if (saved === undefined) delete process.env.SOLEIL_API_DAILY_BUDGET;
  else process.env.SOLEIL_API_DAILY_BUDGET = saved;
});
