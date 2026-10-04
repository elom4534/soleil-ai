/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Tests automatisés d'étanchéité temporelle
 * ============================================================================
 * §2 — « Créer un test automatisé qui détecte toute fuite temporelle. »
 *
 * Ces tests ne se contentent pas de vérifier une fonction : ils vérifient une
 * PROPRIÉTÉ. Le test de mutation est le plus important — il modifie l'avenir de
 * toutes les façons imaginables et exige que le contexte de prédiction reste
 * bit à bit identique. Symétriquement, il modifie le passé et exige que le
 * contexte CHANGE : sans cette seconde moitié, le test passerait même si la
 * fonction renvoyait un contexte vide.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MatchContext } from "../../../src/server/engine/types";
import { auditContextLeakage, buildBacktestContext, strictlyPrior, teamHistory } from "../context";
import { loadCompetition, type BacktestMatch } from "../dataset";

// ---------------------------------------------------------------------------
// Jeu de données réel (football-data.co.uk, gratuit) — chargé une seule fois.
// ---------------------------------------------------------------------------

let cached: BacktestMatch[] | null = null;
async function dataset(): Promise<BacktestMatch[]> {
  if (cached) return cached;
  const e0 = await loadCompetition("E0", ["2024/2025", "2025/2026"]);
  cached = e0;
  return e0;
}

function frozen(context: MatchContext): unknown {
  // Sérialisation stable : on compare l'information, pas les références.
  return JSON.parse(
    JSON.stringify({
      matchId: context.matchId,
      date: context.date,
      competition: context.competition,
      home: context.home,
      away: context.away,
      baseline: context.leagueBaseline,
    }),
  );
}

/** Une rencontre située au milieu de la période, avec de l'historique des deux côtés. */
function centralMatch(matches: BacktestMatch[]): BacktestMatch {
  const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  return sorted[Math.floor(sorted.length * 0.6)]!;
}

// ---------------------------------------------------------------------------

test("le contexte ne contient jamais la rencontre cible elle-même", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);

  const ids = [
    ...context.home.seasonMatches.map((m) => m.id),
    ...context.away.seasonMatches.map((m) => m.id),
    ...context.home.headToHead.map((m) => m.id),
  ];
  assert.equal(ids.includes(target.id), false, "la rencontre cible apparaît dans son propre contexte");
});

test("aucun match postérieur au coup d'envoi n'entre dans le contexte", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);

  const records = [
    ...context.home.seasonMatches,
    ...context.away.seasonMatches,
    ...context.home.headToHead,
  ];
  for (const record of records) {
    assert.ok(
      record.date.getTime() < target.date.getTime(),
      `${record.id} est postérieur au coup d'envoi`,
    );
  }
  assert.deepEqual(auditContextLeakage(context, matches), []);
});

test("MUTATION DU FUTUR : modifier tous les matchs postérieurs ne change RIEN", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const reference = frozen(buildBacktestContext(target, matches));

  // On sabote l'avenir de toutes les manières possibles : scores absurdes,
  // xG énormes, mi-temps inventées.
  const mutated = matches.map((m) =>
    m.date.getTime() > target.date.getTime()
      ? { ...m, homeGoals: 9, awayGoals: 7, halfTimeHomeGoals: 4, halfTimeAwayGoals: 3, homeXg: 9.99, awayXg: 8.88, homeShots: 40 }
      : m,
  );

  const afterMutation = frozen(buildBacktestContext(target, mutated));
  assert.deepEqual(afterMutation, reference, "le contexte a changé alors que seul le futur a été modifié");
});

test("MUTATION DU MATCH CIBLE : son propre score et ses propres xG ne l'influencent pas", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const reference = frozen(buildBacktestContext(target, matches));

  // Cas explicitement interdit par la phase 10 : « ne jamais prédire
  // Arsenal–Chelsea en utilisant les xG de ce match ».
  const mutated = matches.map((m) =>
    m.id === target.id
      ? { ...m, homeGoals: 8, awayGoals: 0, homeXg: 4.4, awayXg: 0.1, homeShots: 30, homeShotsOnTarget: 14 }
      : m,
  );

  assert.deepEqual(
    frozen(buildBacktestContext(target, mutated)),
    reference,
    "les statistiques du match cible influencent sa propre prédiction",
  );
});

test("SENSIBILITÉ AU PASSÉ : modifier le passé DOIT changer le contexte", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const reference = buildBacktestContext(target, matches);

  // Sans ce test, une fonction renvoyant toujours un contexte vide passerait
  // tous les tests précédents.
  const mutated = matches.map((m) =>
    m.date.getTime() < target.date.getTime() && m.homeTeamId === target.homeTeamId
      ? { ...m, homeGoals: m.homeGoals + 3 }
      : m,
  );

  const afterMutation = buildBacktestContext(target, mutated);
  assert.notDeepEqual(frozen(afterMutation), frozen(reference), "le passé modifié n'a eu aucun effet");
});

test("le contexte est identique pour des jeux mutés ailleurs dans la ligue", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const reference = frozen(buildBacktestContext(target, matches));

  // Modifier un AUTRE match du même jour ne doit rien changer : il n'est pas
  // antérieur au coup d'envoi (strictement).
  const sameDay = matches.filter(
    (m) => m.id !== target.id && m.date.getTime() === target.date.getTime(),
  );
  assert.ok(sameDay.length > 0, "aucun match simultané dans le jeu de test");

  const mutated = matches.map((m) =>
    m.date.getTime() === target.date.getTime() && m.id !== target.id ? { ...m, homeGoals: 6, awayGoals: 6 } : m,
  );
  assert.deepEqual(frozen(buildBacktestContext(target, mutated)), reference);
});

test("l'historique d'équipe est strictement antérieur, ordonné et borné", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);

  const history = teamHistory(matches, target.homeTeamId, target.date, 10);
  assert.ok(history.length > 0);
  assert.ok(history.length <= 10);
  for (let i = 1; i < history.length; i++) {
    assert.ok(
      history[i - 1]!.date.getTime() >= history[i]!.date.getTime(),
      "l'historique n'est pas trié du plus récent au plus ancien",
    );
  }
  assert.ok(strictlyPrior(matches, target.date).every((m) => m.date.getTime() < target.date.getTime()));
});

test("la base de compétition n'agrège que des matchs antérieurs de la même compétition", async () => {
  const e0 = await dataset();
  const sp1 = await loadCompetition("SP1", ["2024/2025", "2025/2026"]);
  const mixed = [...e0, ...sp1];
  const target = centralMatch(e0);

  const context = buildBacktestContext(target, mixed);
  const priorSameCompetition = mixed.filter(
    (m) => m.competition === target.competition && m.date.getTime() < target.date.getTime(),
  ).length;

  assert.ok(
    context.leagueBaseline.sampleSize <= priorSameCompetition,
    "la base de compétition dépasse le nombre de rencontres antérieures réelles",
  );
  assert.equal(auditContextLeakage(context, mixed).length, 0);
});

test("le contexte est déterministe — même entrée, même sortie (§22)", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  assert.deepEqual(
    frozen(buildBacktestContext(target, matches)),
    frozen(buildBacktestContext(target, matches)),
  );
});

test("un contexte falsifié est effectivement détecté par l'audit", async () => {
  const matches = await dataset();
  const target = centralMatch(matches);
  const context = buildBacktestContext(target, matches);

  // On injecte volontairement une fuite : le match cible dans son propre
  // historique. L'audit doit le voir — sinon il ne détecte rien.
  const leaked: MatchContext = {
    ...context,
    home: {
      ...context.home,
      seasonMatches: [
        {
          id: target.id,
          date: target.date,
          competition: target.competition,
          homeTeamId: target.homeTeamId,
          awayTeamId: target.awayTeamId,
          homeGoals: target.homeGoals,
          awayGoals: target.awayGoals,
          halfTimeHomeGoals: target.halfTimeHomeGoals,
          halfTimeAwayGoals: target.halfTimeAwayGoals,
          homeXg: target.homeXg,
          awayXg: target.awayXg,
          homeShots: target.homeShots,
          awayShots: target.awayShots,
          homeShotsOnTarget: target.homeShotsOnTarget,
          awayShotsOnTarget: target.awayShotsOnTarget,
          homeCorners: target.homeCorners,
          awayCorners: target.awayCorners,
          homeYellowCards: target.homeYellowCards,
          awayYellowCards: target.awayYellowCards,
          source: target.source,
        },
        ...context.home.seasonMatches,
      ],
    },
  };

  const findings = auditContextLeakage(leaked, matches);
  assert.ok(findings.length > 0, "l'audit n'a pas détecté une fuite volontaire");
  assert.equal(findings[0]!.kind, "match-du-jour");
});
