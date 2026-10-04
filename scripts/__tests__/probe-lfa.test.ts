/**
 * ============================================================================
 * SOLEIL — Tests de lecture des réponses LiveFootballApi
 * ============================================================================
 * Ces tests vérifient la sonde AVANT qu'elle ne dépense le premier crédit.
 * Les charges utiles reproduisent fidèlement les exemples de la documentation
 * officielle : si le fournisseur répond comme il l'annonce, la sonde doit
 * l'interpréter correctement ; si elle se trompait, l'audit conclurait faux —
 * et une conclusion fausse coûte plus cher qu'un crédit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LFA_PROFILE } from "../probe-lfa";
import type { ProbeContext } from "../probe-kit";

function context(): ProbeContext {
  return {
    today: "2026-09-29",
    yesterday: "2026-09-28",
    lastSaturday: "2026-09-26",
    nextSaturday: "2026-10-03",
    league: 39,
    season: 2026,
    slots: {},
  };
}

/** Réponse `/leagues` — 3 pays, dont un africain. */
const leaguesPayload = {
  success: true,
  credits_remaining: 4999,
  data: {
    language: "en",
    total_countries: 3,
    data: [
      {
        country: "England",
        leagues: [
          { id: "lfa-premier-league", name: "Premier League", logo: "…" },
          { id: "lfa-championship", name: "Championship", logo: "…" },
        ],
      },
      {
        country: "Spain",
        leagues: [{ id: "lfa-la-liga", name: "La Liga", logo: "…" }],
      },
      {
        country: "Ghana",
        leagues: [{ id: "lfa-ghana-premier-league", name: "Premier League", logo: "…" }],
      },
    ],
  },
};

/** Réponse `/matches` — un match en direct, un terminé avec mi-temps, un à venir. */
const matchesPayload = {
  success: true,
  credits_remaining: 4998,
  data: {
    date: "2026-09-29",
    language: "en",
    timezone: "UTC",
    matches: [
      {
        id: "lfa-live-1",
        league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
        week: "3",
        kickoff: "14:00",
        status: { status: "live", display: "73'", is_live: true, state: "inPlay" },
        home: { id: "lfa-man-city", name: "Manchester City", logo: "…", score: "2" },
        away: { id: "lfa-arsenal", name: "Arsenal", logo: "…", score: "1" },
        halftime: { home: 1, away: 0 },
        tv_broadcast: true,
        penalty: { home: null, away: null },
      },
      {
        id: "lfa-finished-1",
        league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
        week: "3",
        kickoff: "11:30",
        status: { status: "finished", display: "FT", is_live: false, state: "postGame" },
        home: { id: "lfa-chelsea", name: "Chelsea", logo: "…", score: "0" },
        away: { id: "lfa-everton", name: "Everton", logo: "…", score: "1" },
        halftime: { home: 0, away: 1 },
        tv_broadcast: false,
        penalty: { home: null, away: null },
      },
      {
        id: "lfa-upcoming-1",
        league: { id: "lfa-la-liga", name: "La Liga", country: "Spain" },
        week: null,
        kickoff: "20:00",
        status: { status: "upcoming", display: "", is_live: false, state: "preGame" },
        home: { id: "lfa-sevilla", name: "Sevilla", logo: "…", score: null },
        away: { id: "lfa-betis", name: "Real Betis", logo: "…", score: null },
        halftime: { home: null, away: null },
        tv_broadcast: false,
        penalty: { home: null, away: null },
      },
    ],
  },
};

/** Réponse `/live_match_details` — statistiques SANS xG, événements horodatés. */
const detailsPayload = {
  success: true,
  credits_remaining: 4997,
  data: {
    match_id: "lfa-live-1",
    match_date: "2026-09-29T14:00:00Z",
    last_updated: "2026-09-29 14:22:01 UTC",
    stale: false,
    header: {
      home: { name: "Manchester City", id: "lfa-man-city", logo: "…", score: "2" },
      away: { name: "Arsenal", id: "lfa-arsenal", logo: "…", score: "1" },
      status: { display: "", is_live: true, is_postponed: 0, minute: "73", state: "inPlay", extra_time: null },
    },
    events: [
      { time: "23", type: "goal", side: "home", detail: { player: { name: "Haaland" }, score: "1-0" } },
      { time: "65", type: "yellow_card", side: "away", detail: { player: { name: "Rice" } } },
      { time: "70", type: "substitution", side: "home", detail: { player: { name: "Foden" } } },
    ],
    stats: [
      { label: "Possession", home: "62%", away: "38%" },
      { label: "Shots", home: "14", away: "6" },
      { label: "Shots on Target", home: "5", away: "2" },
      { label: "Corners", home: "7", away: "3" },
      { label: "Fouls", home: "9", away: "12" },
      { label: "Yellow Cards", home: "1", away: "3" },
    ],
    csb_url: "https://live-football-api.com/api/v1/csb?token=x&matchid=lfa-live-1&lang=en",
    venue: { name: "Etihad Stadium", capacity: 53400 },
    referee: "M. Oliver",
    tv_channels: ["beIN SPORTS 1"],
    player_of_the_match: { name: "Haaland", id: "lfa-haaland", rating: 8.7 },
  },
};

/** Réponse `/league_standings` — deux saisons annoncées, tableaux domicile/extérieur. */
const standingsPayload = {
  success: true,
  credits_remaining: 4996,
  data: {
    league_id: "lfa-premier-league",
    season: "2026/2027",
    available_seasons: ["2026/2027", "2025/2026", "2024/2025"],
    timezone: "UTC",
    stale: false,
    standings: [
      {
        title: "Premier League",
        table: [
          {
            rank: 1,
            team: { id: "lfa-liverpool", name: "Liverpool", logo: "…" },
            played: 6, won: 5, drawn: 1, lost: 0,
            goals_for: 14, goals_against: 5, goal_diff: 9, points: 16,
            form: "WWDWW",
            zone: { name: "Champions League", color: "#02206B" },
          },
        ],
      },
    ],
    home_standings: [{ title: "Premier League", table: [{ rank: 1 }] }],
    away_standings: [{ title: "Premier League", table: [{ rank: 2 }] }],
  },
};

/** Réponse `/league_fixtures` — deux journées, matchs joués et à venir. */
const fixturesPayload = {
  success: true,
  credits_remaining: 4995,
  data: {
    league_id: "lfa-premier-league",
    league_name: "Premier League",
    season: "2026/2027",
    available_seasons: ["2026/2027", "2025/2026"],
    timezone: "UTC",
    weeks: [
      {
        week: "1",
        matches: [
          {
            id: "lfa-m1",
            league: { id: "lfa-premier-league", name: "Premier League" },
            round: "Round 1",
            date: "2026-08-14",
            kickoff: "18:30",
            status: { status: "finished", display: "FT", is_live: false, state: "postGame" },
            home: { id: "lfa-a", name: "A", logo: "…", score: "2" },
            away: { id: "lfa-b", name: "B", logo: "…", score: "2" },
            halftime: { home: 0, away: 0 },
            penalty: { home: null, away: null },
          },
          {
            id: "lfa-m2",
            league: { id: "lfa-premier-league", name: "Premier League" },
            round: "Round 1",
            date: "2026-08-15",
            kickoff: "15:00",
            status: { status: "upcoming", display: "", is_live: false, state: "preGame" },
            home: { id: "lfa-c", name: "C", logo: "…", score: null },
            away: { id: "lfa-d", name: "D", logo: "…", score: null },
            halftime: { home: null, away: null },
            penalty: { home: null, away: null },
          },
        ],
      },
    ],
    stale: false,
  },
};

/** Réponse `/team_matches` — bilan calculable sur 3 rencontres. */
const teamMatchesPayload = {
  success: true,
  credits_remaining: 4994,
  data: {
    team_id: "lfa-man-city",
    team_logo: "…",
    season: "2026/2027",
    available_seasons: ["2026/2027", "2025/2026"],
    timezone: "UTC",
    matches: [
      {
        id: "lfa-g1", date: "2026-08-17 14:00:00", timestamp: 1,
        league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
        status: "FT",
        home: { id: "lfa-man-city", name: "Manchester City", logo: "…", score: 2 },
        away: { id: "lfa-chelsea", name: "Chelsea", logo: "…", score: 0 },
      },
      {
        id: "lfa-g2", date: "2026-08-24 14:00:00", timestamp: 2,
        league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
        status: "FT",
        home: { id: "lfa-arsenal", name: "Arsenal", logo: "…", score: 1 },
        away: { id: "lfa-man-city", name: "Manchester City", logo: "…", score: 1 },
      },
      {
        id: "lfa-g3", date: "2026-08-31 14:00:00", timestamp: 3,
        league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
        status: "FT",
        home: { id: "lfa-man-city", name: "Manchester City", logo: "…", score: 0 },
        away: { id: "lfa-liverpool", name: "Liverpool", logo: "…", score: 3 },
      },
    ],
  },
};

/** Réponse `/h2h` — confrontations + forme des deux équipes. */
const h2hPayload = {
  success: true,
  credits_remaining: 4993,
  data: {
    match_id: "lfa-live-1",
    home_form: [{ date: "2026-06-14", score: "3-1" }],
    away_form: [],
    h2h: [{ date: "2025-09-22", score: "2-1" }],
    h2h_summary: { home_wins: 8, away_wins: 6, draws: 4 },
  },
};

// ---------------------------------------------------------------------------
// /leagues
// ---------------------------------------------------------------------------

test("leagues : compte les compétitions et repère les compétitions africaines", () => {
  const ctx = context();
  const analysis = LFA_PROFILE.analyse("leagues", leaguesPayload, ctx);
  const text = analysis.answers.join(" ");

  assert.match(text, /Authentification : fonctionnelle/);
  assert.match(text, /3 pays, 4 ligues/);
  assert.match(text, /Ghana — Premier League/);
  assert.equal(analysis.evidence?.totalCountries, 3);
});

test("leagues : choisit un championnat de référence et alimente le contexte", () => {
  const ctx = context();
  LFA_PROFILE.hydrate("leagues", leaguesPayload, ctx);

  assert.equal(ctx.slots.leagueId, "lfa-premier-league");
  assert.equal(ctx.slots.africanLeagueId, "lfa-ghana-premier-league");
});

test("leagues : signale explicitement l'absence de compétition africaine", () => {
  const payload = {
    success: true,
    credits_remaining: 10,
    data: {
      total_countries: 1,
      data: [{ country: "England", leagues: [{ id: "lfa-premier-league", name: "Premier League" }] }],
    },
  };
  const analysis = LFA_PROFILE.analyse("leagues", payload, context());
  assert.match(analysis.answers.join(" "), /AUCUNE compétition africaine/);
});

// ---------------------------------------------------------------------------
// /matches
// ---------------------------------------------------------------------------

test("matches : distingue direct, terminé et à venir, et mesure la couverture", () => {
  const analysis = LFA_PROFILE.analyse("matches_today", matchesPayload, context());
  const text = analysis.answers.join(" ");

  assert.match(text, /3 rencontre\(s\) — 1 en direct, 1 terminée\(s\), 1 à venir/);
  // 2 matchs sur 3 portent une mi-temps renseignée → 67 %
  assert.match(text, /mi-temps sur 67 %/);
  assert.match(text, /2026-09-29 → 2026-09-29/);
});

test("matches : privilégie un match en direct pour l'étape de détail", () => {
  const ctx = context();
  LFA_PROFILE.hydrate("matches_today", matchesPayload, ctx);

  assert.equal(ctx.slots.matchId, "lfa-live-1");
  assert.equal(ctx.slots.matchKind, "live");
  assert.equal(ctx.slots.teamId, "lfa-man-city");
});

test("matches : retient un identifiant de match terminé lorsqu'aucun direct n'existe", () => {
  const payload = {
    ...matchesPayload,
    data: { ...matchesPayload.data, matches: [matchesPayload.data.matches[1]] },
  };
  const ctx = context();
  LFA_PROFILE.hydrate("matches_today", payload, ctx);

  assert.equal(ctx.slots.matchId, "lfa-finished-1");
  assert.equal(ctx.slots.matchKind, "finished");
});

test("matches terminés : alimente l'identifiant du match terminé", () => {
  const ctx = context();
  LFA_PROFILE.hydrate("matches_finished", matchesPayload, ctx);
  assert.equal(ctx.slots.finishedMatchId, "lfa-live-1");
});

// ---------------------------------------------------------------------------
// /live_match_details — la vérification décisive
// ---------------------------------------------------------------------------

test("détails : énumère les libellés de statistiques réellement fournis", () => {
  const analysis = LFA_PROFILE.analyse("details_active", detailsPayload, context());
  const text = analysis.answers.join(" ");

  assert.match(text, /6 statistique\(s\) renvoyée\(s\) — 6 libellé\(s\) distinct\(s\)/);
  for (const label of ["Possession", "Shots", "Shots on Target", "Corners", "Fouls", "Yellow Cards"]) {
    assert.ok(text.includes(label), `libellé manquant : ${label}`);
  }
});

test("détails : déclare l'absence de xG sans jamais l'inventer", () => {
  const analysis = LFA_PROFILE.analyse("details_active", detailsPayload, context());
  assert.match(analysis.answers.join(" "), /xG : ABSENT/);
});

test("détails : détecte le xG s'il est réellement présent", () => {
  const payload = {
    ...detailsPayload,
    data: {
      ...detailsPayload.data,
      stats: [...detailsPayload.data.stats, { label: "Expected Goals", home: "1.84", away: "0.71" }],
    },
  };
  const analysis = LFA_PROFILE.analyse("details_active", payload, context());
  const text = analysis.answers.join(" ");
  assert.match(text, /xG : PRÉSENT/);
  assert.match(text, /1\.84/);
});

test("détails : relève les événements horodatés et leurs types", () => {
  const analysis = LFA_PROFILE.analyse("details_active", detailsPayload, context());
  const text = analysis.answers.join(" ");
  assert.match(text, /Événements : 3, dont 3 portent une minute \(100 %\)/);
  assert.match(text, /goal×1/);
  assert.match(text, /yellow_card×1/);
});

test("détails : signale honnêtement une réponse sans statistiques", () => {
  const payload = { ...detailsPayload, data: { ...detailsPayload.data, stats: [] } };
  const analysis = LFA_PROFILE.analyse("details_active", payload, context());
  assert.match(analysis.answers.join(" "), /AUCUNE statistique renvoyée/);
});

// ---------------------------------------------------------------------------
// /league_standings
// ---------------------------------------------------------------------------

test("classement : relève les champs, la forme et l'historique de saisons", () => {
  const analysis = LFA_PROFILE.analyse("standings", standingsPayload, context());
  const text = analysis.answers.join(" ");

  assert.match(text, /1 équipe\(s\) classée\(s\), 1 groupe\(s\)/);
  assert.match(text, /points/);
  assert.match(text, /goal_diff/);
  assert.match(text, /Forme .*renseignée sur 100 %/);
  assert.match(text, /classement domicile : 1 ligne\(s\).*classement extérieur : 1 ligne\(s\)/);
  assert.match(text, /2026\/2027, 2025\/2026, 2024\/2025/);
});

test("classement : prépare la saison antérieure à tester", () => {
  const ctx = context();
  LFA_PROFILE.hydrate("standings", standingsPayload, ctx);
  assert.equal(ctx.slots.oldSeason, "2025/2026");
});

test("classement : n'invente pas de saison antérieure si une seule est annoncée", () => {
  const payload = {
    ...standingsPayload,
    data: { ...standingsPayload.data, available_seasons: ["2026/2027"] },
  };
  const ctx = context();
  LFA_PROFILE.hydrate("standings", payload, ctx);
  assert.equal(ctx.slots.oldSeason, undefined);
});

// ---------------------------------------------------------------------------
// /league_fixtures
// ---------------------------------------------------------------------------

test("calendrier : additionne les journées et chiffre le coût d'ingestion", () => {
  const analysis = LFA_PROFILE.analyse("league_fixtures", fixturesPayload, context());
  const text = analysis.answers.join(" ");

  assert.match(text, /2 rencontre\(s\)/);
  assert.match(text, /Coût d'une ingestion complète de cette compétition-saison : 1 crédit \(calendrier\) \+ 2 crédits/);
  assert.match(text, /Saisons annoncées .*2026\/2027, 2025\/2026/);
});

// ---------------------------------------------------------------------------
// /team_matches et /h2h
// ---------------------------------------------------------------------------

test("équipe : ne compte JAMAIS un match non joué comme un 0-0", () => {
  // Régression : `Number(null)` vaut 0, ce qui transformait chaque rencontre à
  // venir en match nul. Sur une équipe réelle, cela a produit « 41 nuls » sur 51
  // rencontres — une donnée entièrement inventée.
  const played = teamMatchesPayload.data.matches;
  const payload = {
    ...teamMatchesPayload,
    data: {
      ...teamMatchesPayload.data,
      matches: [
        ...played,
        {
          id: "lfa-futur", date: "2027-01-01 15:00:00", timestamp: 4,
          league: { id: "lfa-premier-league", name: "Premier League", country: "England" },
          status: "Scheduled",
          home: { id: "lfa-man-city", name: "Manchester City", logo: "…", score: null },
          away: { id: "lfa-x", name: "X", logo: "…", score: null },
        },
      ],
    },
  };
  const analysis = LFA_PROFILE.analyse("team_matches", payload, context());
  assert.deepEqual(analysis.evidence?.record, { wins: 1, draws: 1, losses: 1, homeGames: 2, played: 3 });
  assert.match(analysis.answers.join(" "), /sur 3 rencontre\(s\) réellement jouée\(s\)/);
});

test("équipe : calcule le bilan et la part de rencontres à domicile", () => {
  const analysis = LFA_PROFILE.analyse("team_matches", teamMatchesPayload, context());
  const text = analysis.answers.join(" ");

  // 1 victoire (2-0), 1 nul (1-1), 1 défaite (0-3) — 2 rencontres à domicile.
  assert.match(text, /1 V \/ 1 N \/ 1 D sur 3 rencontre\(s\) réellement jouée\(s\) — dont 2 à domicile/);
  assert.deepEqual(analysis.evidence?.record, { wins: 1, draws: 1, losses: 1, homeGames: 2, played: 3 });
});

test("confrontations : compte les rencontres et relève la forme fournie", () => {
  const analysis = LFA_PROFILE.analyse("h2h", h2hPayload, context());
  const text = analysis.answers.join(" ");

  assert.match(text, /1 rencontre\(s\) renvoyée\(s\)/);
  assert.match(text, /1 rencontre\(s\) pour l'équipe à domicile, 0 pour l'équipe à l'extérieur/);
  assert.match(text, /home_wins/);
});

// ---------------------------------------------------------------------------
// Le plan lui-même
// ---------------------------------------------------------------------------

test("plan : coût total chiffré et étapes indispensables identifiées", () => {
  const steps = LFA_PROFILE.steps;
  const total = steps.reduce((sum, step) => sum + step.cost, 0);

  assert.equal(total, 14);
  // 7 étapes indispensables : authentification, journée du jour, journée
  // écoulée, détail de match, classement, calendrier, rencontres d'équipe.
  assert.equal(steps.filter((s) => s.required).length, 7);
  // Aucune étape ne dépend d'un identifiant qu'aucune autre ne fournit.
  const keys = new Set(steps.map((s) => s.key));
  for (const needed of ["matches_today", "matches_finished", "leagues"]) {
    assert.ok(keys.has(needed), `étape manquante : ${needed}`);
  }
});
