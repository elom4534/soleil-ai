/**
 * Mission 23 — tests de non-régression du bug de résultat de match.
 *
 * Avant correction, `matchOutcome` renvoyait "DRAW" pour une défaite et
 * "LOSS" pour un nul : les défaites valaient 1 point et les nuls 0 point,
 * ce qui faussait le modèle de forme et l'indice `formIndex`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchOutcome, pointsFor, computeTeamRatings } from "../ratings";
import type { LeagueBaseline, MatchRecord, TeamSnapshot } from "../types";

const TEAM = "team-a";
const OTHER = "team-b";

function match(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: "m1",
    date: new Date("2026-10-01T12:00:00Z"),
    competition: "Test",
    homeTeamId: TEAM,
    awayTeamId: OTHER,
    homeGoals: 0,
    awayGoals: 0,
    halfTimeHomeGoals: null,
    halfTimeAwayGoals: null,
    homeXg: null,
    awayXg: null,
    homeShots: null,
    awayShots: null,
    homeShotsOnTarget: null,
    awayShotsOnTarget: null,
    homeCorners: null,
    awayCorners: null,
    homeYellowCards: null,
    awayYellowCards: null,
    source: "test",
    ...overrides,
  };
}

describe("matchOutcome — correction Mission 23", () => {
  it("une victoire à domicile est un WIN (3 points)", () => {
    const m = match({ homeGoals: 2, awayGoals: 1 });
    assert.equal(matchOutcome(m, TEAM), "WIN");
    assert.equal(pointsFor(m, TEAM), 3);
  });

  it("une défaite est un LOSS (0 point) — pas un DRAW", () => {
    const m = match({ homeGoals: 0, awayGoals: 2 });
    assert.equal(matchOutcome(m, TEAM), "LOSS");
    assert.equal(pointsFor(m, TEAM), 0);
  });

  it("un nul est un DRAW (1 point) — pas un LOSS", () => {
    const m = match({ homeGoals: 1, awayGoals: 1 });
    assert.equal(matchOutcome(m, TEAM), "DRAW");
    assert.equal(pointsFor(m, TEAM), 1);
  });

  it("valable aussi du point de vue de l'extérieur", () => {
    const m = match({ homeGoals: 3, awayGoals: 0 });
    assert.equal(matchOutcome(m, OTHER), "LOSS");
    assert.equal(pointsFor(m, OTHER), 0);
  });
});

describe("computeTeamRatings — indice de forme cohérent avec les points", () => {
  const baseline: LeagueBaseline = {
    homeGoalsPerMatch: 1.5,
    awayGoalsPerMatch: 1.2,
    totalGoalsPerMatch: 2.7,
    bttsRate: 0.5,
    firstHalfGoalRate: 0.7,
    firstHalfGoalShare: 0.45,
    sampleSize: 100,
  };

  function snapshot(matches: MatchRecord[]): TeamSnapshot {
    return {
      identity: {
        id: TEAM,
        name: "Team A",
        shortName: null,
        tla: null,
        crest: null,
        leagueId: "L1",
        leagueName: "Test",
      },
      seasonMatches: matches,
      headToHead: [],
      hasXg: false,
      sourceScores: { test: 0.9 },
    };
  }

  it("trois victoires → formIndex élevé (~100) et 3 pts/match", () => {
    const wins = [
      match({ homeGoals: 2, awayGoals: 0, date: new Date("2026-10-03") }),
      match({ homeGoals: 3, awayGoals: 1, date: new Date("2026-10-02") }),
      match({ homeGoals: 1, awayGoals: 0, date: new Date("2026-10-01") }),
    ];
    const r = computeTeamRatings(snapshot(wins), baseline);
    assert.ok(r.formIndex > 90, `formIndex=${r.formIndex}`);
    assert.ok(Math.abs((r.recentPointsPerGame ?? 0) - 3) < 0.01);
  });

  it("trois défaites → formIndex bas (~0) et 0 pt/match", () => {
    const losses = [
      match({ homeGoals: 0, awayGoals: 2, date: new Date("2026-10-03") }),
      match({ homeGoals: 1, awayGoals: 3, date: new Date("2026-10-02") }),
      match({ homeGoals: 0, awayGoals: 1, date: new Date("2026-10-01") }),
    ];
    const r = computeTeamRatings(snapshot(losses), baseline);
    assert.ok(r.formIndex < 10, `formIndex=${r.formIndex}`);
    assert.ok(Math.abs(r.recentPointsPerGame ?? 99) < 0.01);
  });

  it("trois nuls → 1 pt/match (entre les deux)", () => {
    const draws = [
      match({ homeGoals: 1, awayGoals: 1, date: new Date("2026-10-03") }),
      match({ homeGoals: 0, awayGoals: 0, date: new Date("2026-10-02") }),
      match({ homeGoals: 2, awayGoals: 2, date: new Date("2026-10-01") }),
    ];
    const r = computeTeamRatings(snapshot(draws), baseline);
    assert.ok(r.formIndex > 20 && r.formIndex < 50, `formIndex=${r.formIndex}`);
    assert.ok(Math.abs((r.recentPointsPerGame ?? 0) - 1) < 0.01);
  });
});
