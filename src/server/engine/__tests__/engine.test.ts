import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePrediction } from "../index";
import { computeLeagueBaseline } from "../ratings";
import { FORBIDDEN_PHRASES } from "@/lib/constants";
import type { MatchContext, MatchRecord, TeamSnapshot } from "../types";

/** Fabrique un historique réaliste et déterministe pour les tests. */
function makeMatches(options: {
  teamId: string;
  count: number;
  goalsFor: number;
  goalsAgainst: number;
  seed?: number;
}): MatchRecord[] {
  const { teamId, count, goalsFor, goalsAgainst, seed = 1 } = options;
  const start = Date.UTC(2026, 7, 1);
  return Array.from({ length: count }, (_, i) => {
    const isHome = (i + seed) % 2 === 0;
    // Variation déterministe pour créer de la variance sans aléatoire.
    const wiggle = ((i * 7 + seed * 13) % 3) - 1;
    const gf = Math.max(0, goalsFor + wiggle);
    const ga = Math.max(0, goalsAgainst - wiggle);
    return {
      id: `${teamId}-${i}`,
      date: new Date(start - i * 7 * 86_400_000),
      competition: "Ligue de test",
      homeTeamId: isHome ? teamId : "adversaire",
      awayTeamId: isHome ? "adversaire" : teamId,
      homeGoals: isHome ? gf : ga,
      awayGoals: isHome ? ga : gf,
      halfTimeHomeGoals: Math.floor((isHome ? gf : ga) / 2),
      halfTimeAwayGoals: Math.floor((isHome ? ga : gf) / 2),
      homeXg: null,
      awayXg: null,
      homeShots: 12,
      awayShots: 10,
      homeShotsOnTarget: 5,
      awayShotsOnTarget: 4,
      homeCorners: 6,
      awayCorners: 4,
      homeYellowCards: 2,
      awayYellowCards: 2,
      source: "test",
    } satisfies MatchRecord;
  });
}

function leagueMatches(): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (let i = 0; i < 120; i++) {
    const hg = [0, 1, 1, 2, 2, 3][i % 6];
    const ag = [0, 0, 1, 1, 2, 2][(i * 3) % 6];
    out.push({
      ...makeMatches({ teamId: `t${i}`, count: 1, goalsFor: hg, goalsAgainst: ag })[0],
      id: `league-${i}`,
      homeGoals: hg,
      awayGoals: ag,
    });
  }
  return out;
}

function makeSnapshot(id: string, name: string, opts: { goalsFor: number; goalsAgainst: number; count?: number }): TeamSnapshot {
  const seasonMatches = makeMatches({
    teamId: id,
    count: opts.count ?? 18,
    goalsFor: opts.goalsFor,
    goalsAgainst: opts.goalsAgainst,
  });
  return {
    identity: { id, name, shortName: name, tla: name.slice(0, 3).toUpperCase(), crest: null, leagueId: "L1", leagueName: "Ligue de test" },
    seasonMatches,
    headToHead: [],
    hasXg: false,
    sourceScores: { test: 0.8 },
  };
}

function makeContext(overrides: Partial<{ strong: boolean; weakSample: boolean }> = {}): MatchContext {
  const baseline = computeLeagueBaseline(leagueMatches());
  assert.ok(baseline, "la référence de compétition doit être calculable");

  return {
    matchId: "match-1",
    date: new Date(Date.UTC(2026, 8, 20)),
    competition: "Ligue de test",
    leagueId: "L1",
    home: makeSnapshot("H", "Domicile FC", {
      goalsFor: overrides.strong === false ? 0.9 : 2.1,
      goalsAgainst: overrides.strong === false ? 1.8 : 0.8,
      count: overrides.weakSample ? 2 : 18,
    }),
    away: makeSnapshot("A", "Extérieur FC", {
      goalsFor: overrides.strong === false ? 2.0 : 0.9,
      goalsAgainst: overrides.strong === false ? 0.8 : 1.7,
      count: overrides.weakSample ? 2 : 18,
    }),
    leagueBaseline: baseline,
  };
}

describe("Générateur de prédiction", () => {
  it("produit une prédiction complète et cohérente", () => {
    const result = generatePrediction(makeContext());

    assert.equal(result.publishable, true);

    // 1X2
    const sum = result.outcomes.home + result.outcomes.draw + result.outcomes.away;
    assert.ok(Math.abs(sum - 1) < 1e-9, `somme 1X2 = ${sum}`);
    for (const p of Object.values(result.outcomes)) assert.ok(p >= 0 && p <= 1);

    // Le consensus doit correspondre à l'issue la plus probable.
    const max = Math.max(result.outcomes.home, result.outcomes.draw, result.outcomes.away);
    const expected =
      max === result.outcomes.home ? "HOME_WIN" : max === result.outcomes.away ? "AWAY_WIN" : "DRAW";
    assert.equal(result.consensusPick, expected);

    // Buts attendus
    assert.ok(result.expectedGoals.total > 0);
    assert.ok(
      Math.abs(result.expectedGoals.total - (result.expectedGoals.home + result.expectedGoals.away)) < 1e-9,
    );
  });

  it("respecte les bornes de probabilité sur tous les marchés", () => {
    const result = generatePrediction(makeContext());

    for (const line of result.markets.totalGoals) {
      assert.ok(line.over >= 0 && line.over <= 1, `Over ${line.line}`);
      assert.ok(Math.abs(line.over + line.under - 1) < 1e-9, `ligne ${line.line} non complémentaire`);
      assert.ok(line.confidence >= 0 && line.confidence <= 100);
    }

    const btts = result.markets.bothTeamsToScore;
    assert.ok(Math.abs(btts.yes + btts.no - 1) < 1e-9);

    for (const tg of [result.markets.teamGoals.home, result.markets.teamGoals.away]) {
      const total = tg.distribution.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, "distribution de buts non normalisée");
      for (const l of tg.overUnder) assert.ok(Math.abs(l.over + l.under - 1) < 1e-9);
    }

    // Monotonie : Over 0.5 ≥ Over 1.5 ≥ Over 2.5 ≥ Over 3.5 ≥ Over 4.5
    const lines = [...result.markets.totalGoals].sort((a, b) => a.line - b.line);
    for (let i = 1; i < lines.length; i++) {
      assert.ok(
        lines[i].over <= lines[i - 1].over + 1e-12,
        `Over ${lines[i].line} (${lines[i].over}) > Over ${lines[i - 1].line} (${lines[i - 1].over})`,
      );
    }
  });

  it("le score exact est cohérent et explicitement non certain", () => {
    const result = generatePrediction(makeContext());
    const { mostLikely, top, disclaimer } = result.markets.exactScore;

    assert.ok(top.length > 0);
    assert.equal(mostLikely.score, top[0].score);
    assert.ok(mostLikely.probability < 0.5, "aucun score exact ne peut être majoritaire");
    assert.ok(top.every((s) => s.probability > 0));

    // Les scores sont triés par probabilité décroissante.
    for (let i = 1; i < top.length; i++) {
      assert.ok(top[i].probability <= top[i - 1].probability);
    }
    assert.ok(disclaimer.length > 0, "un avertissement doit accompagner le score exact");
  });

  it("identifie correctement le favori", () => {
    const strongHome = generatePrediction(makeContext({ strong: true }));
    assert.equal(strongHome.consensusPick, "HOME_WIN");
    assert.ok(strongHome.outcomes.home > strongHome.outcomes.away);

    const strongAway = generatePrediction(makeContext({ strong: false }));
    assert.ok(
      strongAway.outcomes.away > strongAway.outcomes.home,
      "l'équipe extérieure supérieure doit être favorite",
    );
  });

  it("refuse de publier quand l'historique est insuffisant (§15)", () => {
    const result = generatePrediction(makeContext({ weakSample: true }));
    assert.equal(result.publishable, false);
    assert.ok(result.blockingReason && result.blockingReason.length > 0);
    assert.ok(
      result.blockingReason!.toLowerCase().includes("insuffisantes"),
      `motif explicite attendu, reçu : ${result.blockingReason}`,
    );
  });

  it("exclut le modèle xG au lieu de l'inventer, et pèse 0 %", () => {
    const result = generatePrediction(makeContext());
    const xg = result.consensus.models.find((m) => m.name === "xg");
    assert.ok(xg);
    assert.equal(xg.applicable, false);
    assert.equal(xg.weight, 0);
    assert.ok(xg.unavailableReason);

    const ml = result.consensus.models.find((m) => m.name === "ml");
    assert.ok(ml);
    assert.equal(ml.applicable, false, "le modèle ML doit être déclaré non entraîné, pas simulé");
    assert.equal(ml.weight, 0);
  });

  it("aucun modèle ne dépasse 45 % du poids total (§14)", () => {
    const result = generatePrediction(makeContext());
    const total = result.consensus.models.reduce((a, m) => a + m.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `somme des poids = ${total}`);
    for (const m of result.consensus.models) {
      assert.ok(m.weight <= 0.4501, `${m.name} pèse ${m.weight} > 45 %`);
    }
  });

  it("le score de confiance est borné et décomposé", () => {
    const result = generatePrediction(makeContext());
    assert.ok(result.confidence.score >= 0 && result.confidence.score <= 100);
    assert.ok(result.confidence.label.length > 0);
    for (const v of Object.values(result.confidence.components)) {
      assert.ok(v >= 0 && v <= 100);
    }
  });

  it("la qualité des données est renseignée champ par champ (§4)", () => {
    const result = generatePrediction(makeContext());
    assert.ok(result.dataQuality.score >= 0 && result.dataQuality.score <= 100);
    assert.ok(result.dataQuality.usedFields.includes("tirs"));
    assert.ok(
      result.dataQuality.missingFields.includes("xG"),
      "les xG absents doivent être déclarés manquants",
    );
  });

  it("détecte l'absence de xG comme anomalie explicite", () => {
    const result = generatePrediction(makeContext());
    assert.ok(result.anomalies.some((a) => a.code === "NO_XG"));
  });

  it("est déterministe : deux appels identiques donnent le même résultat", () => {
    const ctx = makeContext();
    const a = generatePrediction(ctx);
    const b = generatePrediction(ctx);
    assert.deepEqual(a.outcomes, b.outcomes);
    assert.deepEqual(a.expectedGoals, b.expectedGoals);
    assert.equal(a.consensusPick, b.consensusPick);
  });

  it("les marchés mi-temps sont cohérents et somment à la journée complète", () => {
    const result = generatePrediction(makeContext());
    const { firstHalf, secondHalf } = result.markets.halfTime;
    assert.ok(firstHalf.expectedGoals > 0 && secondHalf.expectedGoals > 0);
    assert.ok(
      Math.abs(
        firstHalf.expectedGoals + secondHalf.expectedGoals - result.expectedGoals.total,
      ) < 1e-9,
      "les buts attendus par mi-temps doivent totaliser les buts attendus du match",
    );
    assert.ok(firstHalf.probAtLeastOneGoal >= 0 && firstHalf.probAtLeastOneGoal <= 1);
  });

  it("n'emploie aucune formulation interdite (§20, §32)", () => {
    const result = generatePrediction(makeContext());
    const texts = [
      result.explanation.summary,
      ...result.markets.totalGoals.map((l) => l.explanation),
      ...result.anomalies.map((a) => a.message),
      result.blockingReason ?? "",
    ].join(" ").toLowerCase();

    for (const phrase of FORBIDDEN_PHRASES) {
      // « 100 % » est toléré uniquement dans une négation explicite.
      if (phrase === "100 %" || phrase === "100%") {
        assert.ok(!texts.includes(phrase), `formulation interdite détectée : « ${phrase} »`);
        continue;
      }
      assert.ok(!texts.includes(phrase), `formulation interdite détectée : « ${phrase} »`);
    }
  });
});

describe("Référence de compétition", () => {
  it("refuse de produire une référence sur un échantillon insuffisant", () => {
    assert.equal(computeLeagueBaseline([]), null);
    assert.equal(computeLeagueBaseline(leagueMatches().slice(0, 5)), null);
  });

  it("calcule des moyennes cohérentes", () => {
    const baseline = computeLeagueBaseline(leagueMatches());
    assert.ok(baseline);
    assert.ok(baseline.sampleSize >= 10);
    assert.ok(baseline.homeGoalsPerMatch > 0);
    assert.ok(baseline.awayGoalsPerMatch > 0);
    assert.ok(
      Math.abs(
        baseline.totalGoalsPerMatch - (baseline.homeGoalsPerMatch + baseline.awayGoalsPerMatch),
      ) < 1e-12,
    );
    assert.ok(baseline.bttsRate >= 0 && baseline.bttsRate <= 1);
  });
});
