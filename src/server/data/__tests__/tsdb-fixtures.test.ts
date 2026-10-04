/**
 * Tests §28 — connecteur TheSportsDB (source de secours gratuite).
 * Module pur : aucun réseau, aucune base.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TSDB_PROVIDER_NAME,
  tsdbEventToFixture,
  tsdbEventUtcDate,
  tsdbEventsToSideload,
  tsdbFetchDayFromEvents,
  tsdbStatusToCommon,
  type TsdbEvent,
} from "../providers/theSportsDbFixtures";

const baseEvent: TsdbEvent = {
  idEvent: "2494052",
  idLeague: "4328",
  strLeague: "English Premier League",
  strCountry: "England",
  intRound: "8",
  strHomeTeam: "Arsenal",
  strAwayTeam: "Leeds United",
  idHomeTeam: "133604",
  idAwayTeam: "133635",
  strHomeTeamBadge: "https://r2.thesportsdb.com/images/media/team/badge/a.png",
  strAwayTeamBadge: "https://r2.thesportsdb.com/images/media/team/badge/b.png",
  strLeagueBadge: "https://r2.thesportsdb.com/images/media/league/badge/l.png",
  dateEvent: "2026-10-10",
  strTime: "11:30:00",
  strTimestamp: "2026-10-10T11:30:00",
  strStatus: "NS",
};

describe("theSportsDbFixtures", () => {
  it("convertit un événement NS en rencontre planifiée, sans rien inventer", () => {
    const fixture = tsdbEventToFixture(baseEvent);
    assert.ok(fixture);
    assert.equal(fixture.externalId, `${TSDB_PROVIDER_NAME}:2494052`);
    assert.equal(fixture.sourceRef, "tsdb:2494052");
    assert.equal(fixture.competition.code, "E0");
    assert.equal(fixture.competition.name, "Premier League");
    assert.equal(fixture.competition.country, "England");
    assert.equal(fixture.status, "scheduled");
    assert.equal(fixture.homeTeamName, "Arsenal");
    assert.equal(fixture.awayTeamName, "Leeds United");
    assert.equal(fixture.homeScore, null);
    assert.equal(fixture.homeXg, null);
    assert.equal(fixture.halfTimeHomeScore, null);
    assert.equal(fixture.referee, null);
    assert.equal(fixture.utcDate.toISOString(), "2026-10-10T11:30:00.000Z");
  });

  it("refuse les événements incomplets plutôt que d'inventer (§13)", () => {
    assert.equal(tsdbEventToFixture({ ...baseEvent, idEvent: "" }), null);
    assert.equal(tsdbEventToFixture({ ...baseEvent, strHomeTeam: null }), null);
    assert.equal(tsdbEventToFixture({ ...baseEvent, dateEvent: "", strTimestamp: "" }), null);
    // Compétition hors périmètre E0/SP1.
    assert.equal(tsdbEventToFixture({ ...baseEvent, idLeague: "4400" }), null);
  });

  it("préfère strTimestamp, sinon dateEvent+strTime, en UTC", () => {
    assert.equal(tsdbEventUtcDate(baseEvent)?.toISOString(), "2026-10-10T11:30:00.000Z");
    const noTs = { ...baseEvent, strTimestamp: undefined };
    assert.equal(tsdbEventUtcDate(noTs)?.toISOString(), "2026-10-10T11:30:00.000Z");
    const midnight = { ...baseEvent, strTimestamp: undefined, strTime: "" };
    assert.equal(tsdbEventUtcDate(midnight)?.toISOString(), "2026-10-10T00:00:00.000Z");
  });

  it("mappe les statuts : joué, reporté, annulé, inconnu", () => {
    assert.equal(tsdbStatusToCommon({ strStatus: "FT" }), "finished");
    assert.equal(tsdbStatusToCommon({ strStatus: "PST" }), "postponed");
    assert.equal(tsdbStatusToCommon({ strStatus: "CANCL" }), "cancelled");
    assert.equal(tsdbStatusToCommon({ strStatus: "2H" }), "live");
    assert.equal(tsdbStatusToCommon({ strStatus: "NS" }), "scheduled");
    assert.equal(tsdbStatusToCommon({ strStatus: "" }), "scheduled");
    assert.equal(tsdbStatusToCommon({ strStatus: "NS", strPostponed: "1" }), "postponed");
  });

  it("construit le sideload : identités the-sports-db + logos publiés par la source", () => {
    const sideload = tsdbEventsToSideload([baseEvent]);
    assert.equal(sideload.teams.length, 2);
    const arsenal = sideload.teams.find((t) => t.providerId === "133604");
    assert.equal(arsenal?.providerRef, `${TSDB_PROVIDER_NAME}:133604`);
    assert.equal(arsenal?.logo, "https://r2.thesportsdb.com/images/media/team/badge/a.png");
    assert.equal(sideload.leagues[0]?.providerId, "4328");
    assert.equal(sideload.teamRefsByMatch[`${TSDB_PROVIDER_NAME}:2494052`]?.homeRef, `${TSDB_PROVIDER_NAME}:133604`);
    assert.equal(sideload.competitionByMatch[`${TSDB_PROVIDER_NAME}:2494052`]?.providerRef, `${TSDB_PROVIDER_NAME}:4328`);
    assert.equal(sideload.weekByMatch[`${TSDB_PROVIDER_NAME}:2494052`], "8");
  });

  it("un logo déjà connu n'est jamais remplacé par une absence (§13)", () => {
    const sideload = tsdbEventsToSideload([
      baseEvent,
      {
        ...baseEvent,
        idEvent: "2494053",
        strHomeTeamBadge: "",
        strAwayTeamBadge: "",
        idHomeTeam: "133604",
        idAwayTeam: "133635",
      },
    ]);
    const arsenal = sideload.teams.find((t) => t.providerId === "133604");
    assert.equal(arsenal?.logo, "https://r2.thesportsdb.com/images/media/team/badge/a.png");
  });

  it("regroupe par journée UTC et filtre par compétition demandée", async () => {
    const other: TsdbEvent = {
      ...baseEvent,
      idEvent: "2506240",
      idLeague: "4335",
      strHomeTeam: "Málaga",
      strAwayTeam: "Espanyol",
      strTimestamp: "2026-10-09T19:00:00",
    };
    const fetchDay = tsdbFetchDayFromEvents([baseEvent, other]);
    const day10 = await fetchDay({ date: "2026-10-10", competitionCodes: ["E0", "SP1"], allowNetwork: false });
    assert.equal(day10.fixtures.length, 1);
    assert.equal(day10.fixtures[0]?.homeTeamName, "Arsenal");
    assert.equal(day10.creditsSpent, 0);
    assert.equal(day10.fromCache, true);
    const onlyE0 = await fetchDay({ date: "2026-10-09", competitionCodes: ["E0"], allowNetwork: false });
    assert.equal(onlyE0.fixtures.length, 0);
    const sp1 = await fetchDay({ date: "2026-10-09", competitionCodes: ["E0", "SP1"], allowNetwork: false });
    assert.equal(sp1.fixtures.length, 1);
    assert.equal(sp1.fixtures[0]?.externalId, `${TSDB_PROVIDER_NAME}:2506240`);
  });
});
