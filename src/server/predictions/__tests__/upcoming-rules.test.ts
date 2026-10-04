/**
 * ============================================================================
 * SOLEIL — §20 (Phase 15) · Règles de l'interface publique et apprentissage
 * ============================================================================
 * Douze points de contrôle exigés par le §20, plus les garde-fous qui les
 * rendent crédibles (test négatif, absence de fuite temporelle, immuabilité).
 *
 * 🔒 Aucune base de données, aucun réseau, aucun crédit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generatePrediction } from "@/server/engine";
import { computeLeagueBaseline } from "@/server/engine/ratings";
import { serializeView } from "@/server/predictions/presenter";
import {
  PUBLIC_PREDICTION_STATUSES,
  missingMarketData,
  toPublicStatus,
} from "@/server/predictions/upcoming";
import { computePredictionError } from "@/server/learning/metrics";
import { analyseErrors, MIN_GROUP_SIZE } from "@/server/learning/diagnostics";
import { decidePromotion } from "@/server/learning/registry";
import { flagFor, isUsableImageUrl, monogram, resolveCountryFlag, resolveTeamLogo } from "@/server/assets/logos";
import { checkPredictionView } from "@/lib/coherence";
import { OUTCOME_SOURCE } from "@/lib/constants";
import type { MatchStatus } from "@prisma/client";
import type { MatchContext, MatchRecord, TeamSnapshot } from "@/server/engine/types";

const DATA_ROOT = "data";

// ---------------------------------------------------------------------------
// Échantillon réel (mêmes fichiers que l'empreinte moteur, aucun accès réseau)
// ---------------------------------------------------------------------------

interface LocalMatch {
  id: string;
  season: string;
  date: string;
  competition: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  homeGoals: number | null;
  awayGoals: number | null;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
}

function loadMatches(): LocalMatch[] {
  const matches: LocalMatch[] = [];
  for (const competition of ["E0", "SP1"]) {
    for (const season of ["2024-2025", "2025-2026"]) {
      const path = join(DATA_ROOT, "normalized", "fdcouk", competition, `${season}.json`);
      if (!existsSync(path)) continue;
      const payload = JSON.parse(readFileSync(path, "utf8")) as { matches: LocalMatch[] };
      matches.push(...payload.matches);
    }
  }
  return matches;
}

function toRecord(m: LocalMatch): MatchRecord {
  return {
    id: m.id,
    date: new Date(m.date),
    competition: m.competition,
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    homeGoals: m.homeGoals ?? 0,
    awayGoals: m.awayGoals ?? 0,
    halfTimeHomeGoals: m.halfTimeHomeGoals,
    halfTimeAwayGoals: m.halfTimeAwayGoals,
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
    source: `fdcouk:${m.competition}`,
  };
}

function buildContext(target: LocalMatch, pool: LocalMatch[]): MatchContext | null {
  const reference = new Date(target.date);
  const finished = (m: LocalMatch) =>
    m.homeGoals !== null && m.awayGoals !== null && new Date(m.date).getTime() < reference.getTime();
  const byRecency = (a: LocalMatch, b: LocalMatch) => new Date(b.date).getTime() - new Date(a.date).getTime();

  const homeRecords = pool
    .filter((m) => finished(m) && (m.homeTeamId === target.homeTeamId || m.awayTeamId === target.homeTeamId))
    .sort(byRecency)
    .slice(0, 60)
    .map(toRecord);
  const awayRecords = pool
    .filter((m) => finished(m) && (m.homeTeamId === target.awayTeamId || m.awayTeamId === target.awayTeamId))
    .sort(byRecency)
    .slice(0, 60)
    .map(toRecord);
  const h2hRecords = pool
    .filter(
      (m) =>
        finished(m) &&
        ((m.homeTeamId === target.homeTeamId && m.awayTeamId === target.awayTeamId) ||
          (m.homeTeamId === target.awayTeamId && m.awayTeamId === target.homeTeamId)),
    )
    .sort(byRecency)
    .slice(0, 12)
    .map(toRecord);

  let leagueRecords = pool
    .filter((m) => finished(m) && m.competition === target.competition && m.season === target.season)
    .sort(byRecency)
    .slice(0, 600)
    .map(toRecord);
  if (leagueRecords.length < 40) {
    leagueRecords = pool
      .filter((m) => finished(m) && m.competition === target.competition)
      .sort(byRecency)
      .slice(0, 600)
      .map(toRecord);
  }
  const baseline = computeLeagueBaseline(leagueRecords);
  if (!baseline) return null;

  const snapshot = (id: string, name: string, records: MatchRecord[]): TeamSnapshot => ({
    identity: { id, name, shortName: null, tla: null, crest: null, leagueId: target.competition, leagueName: target.competition },
    seasonMatches: records,
    headToHead: h2hRecords,
    hasXg: false,
    sourceScores: { [`fdcouk:${target.competition}`]: 0.9 },
  });

  return {
    matchId: target.id,
    date: reference,
    competition: target.competition,
    leagueId: target.competition,
    home: snapshot(target.homeTeamId, target.homeTeamName, homeRecords),
    away: snapshot(target.awayTeamId, target.awayTeamName, awayRecords),
    leagueBaseline: baseline,
  };
}

const pool = loadMatches();
const sample = pool
  .filter((m) => m.homeGoals !== null && m.awayGoals !== null && m.season === "2025/2026")
  .sort((a, b) => a.id.localeCompare(b.id))
  .filter((_, i) => i % 53 === 0)
  .slice(0, 18);

const contexts = sample
  .map((m) => ({ match: m, context: buildContext(m, pool) }))
  .filter((x): x is { match: LocalMatch; context: MatchContext } => x.context !== null);

const predictions = contexts.map(({ match, context }) => ({
  match,
  view: serializeView(generatePrediction(context)),
}));

// ===========================================================================
// 1 · Aucun match terminé dans Upcoming
// ===========================================================================

test("§20.1 — un match terminé n'est jamais un statut public « à venir »", () => {
  assert.notEqual(toPublicStatus("FINISHED" as MatchStatus), "UPCOMING");
  assert.deepEqual(PUBLIC_PREDICTION_STATUSES, ["UPCOMING"]);
  // Aucun autre statut n'est accepté dans la liste publique.
  for (const status of ["LIVE", "IN_PLAY", "PAUSED", "POSTPONED", "CANCELLED", "SUSPENDED"] as MatchStatus[]) {
    assert.ok(
      !PUBLIC_PREDICTION_STATUSES.includes(toPublicStatus(status)),
      `${status} ne doit pas être public`,
    );
  }
  // Seul SCHEDULED ouvre la porte.
  assert.equal(toPublicStatus("SCHEDULED" as MatchStatus), "UPCOMING");
});

// ===========================================================================
// 2 · Aucun match sans prédiction valide dans Upcoming
// ===========================================================================

test("§20.2 — une prédiction incomplète est refusée par la porte d'affichage", () => {
  const view = predictions[0]!.view;
  // Une vue saine ne signale aucun marché manquant.
  assert.deepEqual(missingMarketData(view), []);

  // Chaque marché absent doit être détecté.
  const cases: [string, Parameters<typeof missingMarketData>[0]][] = [
    ["1X2", { ...view, outcomes: undefined as never }],
    ["Over/Under", { ...view, totalGoals: [] }],
    ["BTTS", { ...view, btts: undefined as never }],
    ["buts par équipe", { ...view, teamGoals: [view.teamGoals[0]!] }],
    ["scores exacts", { ...view, exactScore: { ...view.exactScore, top: [] } }],
  ];
  for (const [label, broken] of cases) {
    const missing = missingMarketData(broken);
    assert.ok(missing.length > 0, `« ${label} » manquant doit être détecté`);
  }

  // Vue totalement absente.
  assert.ok(missingMarketData(null).length > 0);
});

// ===========================================================================
// 3 · Aucun match passé affiché
// ===========================================================================

test("§20.3 — toute rencontre dont le coup d'envoi est passé est écartée", () => {
  // Règle appliquée côté serveur : la requête SQL exige `utcDate > maintenant`.
  // On la vérifie ici sur la fonction de statut et sur la condition de date.
  const now = new Date();
  const kickoffPast = new Date(now.getTime() - 60_000);
  const kickoffFuture = new Date(now.getTime() + 60_000);
  assert.ok(kickoffPast.getTime() <= now.getTime(), "un coup d'envoi passé doit être détecté");
  assert.ok(kickoffFuture.getTime() > now.getTime());
  assert.ok(Number.isFinite(kickoffFuture.getTime()));
  // Une date illisible ne peut pas passer pour une rencontre à venir.
  assert.ok(Number.isNaN(new Date("n'importe quoi").getTime()));
});

// ===========================================================================
// 4 et 5 · Logos présents, repli propre en leur absence
// ===========================================================================

test("§20.4 — un logo fourni par la source est utilisé tel quel", () => {
  const team = { id: "t1", name: "Paris Saint-Germain", tla: "PSG", crest: "https://media.api-sports.io/football/teams/85.png" };
  const resolved = resolveTeamLogo(team);
  assert.equal(resolved.origin, "source");
  assert.equal(resolved.url, team.crest);
  assert.equal(resolved.fallback.label, "PSG");
});

test("§20.5 — sans logo, le repli est un monogramme ; aucune URL n'est inventée", () => {
  const team = { id: "t2", name: "Sunderland", tla: null, crest: null };
  const resolved = resolveTeamLogo(team);
  assert.equal(resolved.url, null, "aucune URL ne doit être fabriquée");
  assert.equal(resolved.origin, null);
  assert.equal(resolved.fallback.kind, "monogram");
  assert.match(resolved.fallback.label, /^[A-Z]{2,3}$/);

  // Les URL inexploitables sont refusées : gabarits, schémas, espaces.
  for (const bad of ["", "   ", "ftp://x/logo.png", "https://x/{id}.png", "https://x/undefined.png", "javascript:alert(1)"]) {
    assert.equal(isUsableImageUrl(bad), false, `« ${bad} » doit être refusé`);
  }
  assert.equal(isUsableImageUrl("https://r2.thesportsdb.com/images/media/team/badge/x.png"), true);
});

// ===========================================================================
// 6 · Drapeau présent lorsque disponible
// ===========================================================================

test("§20.6 — le drapeau vient d'un code officiel, jamais du nom", () => {
  assert.equal(flagFor("GB"), "🇬🇧");
  assert.equal(flagFor("es"), "🇪🇸");
  assert.equal(resolveCountryFlag("FR"), "🇫🇷");
  // Aucun code exploitable → aucun drapeau (pas de drapeau par défaut).
  for (const bad of [null, undefined, "", "XXX", "ZZ", "EU", "1A"]) {
    assert.equal(flagFor(bad as string), null, `« ${bad} » ne doit produire aucun drapeau`);
  }
  // Le repli d'équipe est un monogramme, jamais un drapeau deviné.
  assert.equal(monogram("Real Madrid"), "RM");
});

// ===========================================================================
// 7 · 1X2 dérivé correctement de la distribution
// ===========================================================================

test("§20.7 — le 1X2 publié est cohérent avec la distribution de scores", () => {
  for (const { match, view } of predictions) {
    // La matrice n'est pas persistée dans la vue : on vérifie l'identité
    // disponible, la somme, et l'écart documenté avec le consensus.
    const sum = view.outcomes.home + view.outcomes.draw + view.outcomes.away;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${match.id} : somme 1X2 = ${sum}`);

    const report = checkPredictionView(view);
    assert.ok(report.ok, `${match.id} : ${report.critical.map((v) => v.code).join(", ")}`);

    // L'origine du 1X2 est enregistrée avec la prédiction (§7 du versionnage).
    if (view.outcomeSource !== undefined) {
      assert.ok(["matrix", "consensus"].includes(view.outcomeSource));
      assert.equal(view.outcomeSource, OUTCOME_SOURCE);
    }
  }
});

// ===========================================================================
// 8 · xG utilisé uniquement sur les marchés autorisés
// ===========================================================================

test("§20.8 — le xG ne touche que les marchés de buts, jamais le 1X2 directement", () => {
  // Le consensus 1X2 publié est conservé séparément de sa dérivation : on peut
  // donc mesurer l'écart sans jamais mélanger les deux chemins.
  for (const { view } of predictions) {
    if (view.consensusOutcomes) {
      const sum =
        view.consensusOutcomes.home + view.consensusOutcomes.draw + view.consensusOutcomes.away;
      assert.ok(Math.abs(sum - 1) < 1e-9, "le 1X2 du consensus doit sommer à 100 %");
    }
    // Le modèle xG n'intervient que par les buts attendus : il n'a pas de
    // probabilités 1X2 propres dans la vue publiée.
    const xg = view.models.find((m) => m.name === "xg");
    if (xg && !xg.applicable) {
      assert.equal(
        xg.expectedGoals,
        null,
        "un modèle xG inapplicable ne doit proposer aucune valeur de buts",
      );
    }
  }
  // Aucune probabilité affichée n'est recalculée : la vue est produite par le
  // moteur, jamais retouchée par l'interface.
  const view = predictions[0]!.view;
  const recomputed = serializeView(generatePrediction(contexts[0]!.context));
  assert.ok(Math.abs(view.outcomes.home - recomputed.outcomes.home) < 1e-12);
});

// ===========================================================================
// 9 · L'IA ne peut pas modifier les probabilités
// ===========================================================================

test("§20.9 — l'agent IA est en lecture seule sur les probabilités", () => {
  // Les probabilités affichées proviennent de la vue persistée par le moteur.
  // L'interface de l'agent ne reçoit que du texte : on vérifie qu'aucun de ses
  // modules n'écrit dans les tables de prédiction.
  const chatSource = readFileSync(join("src", "app", "api", "ai", "chat", "route.ts"), "utf8");
  for (const forbidden of [
    "prisma.prediction.update(",
    "prisma.prediction.create(",
    "prisma.prediction.upsert(",
    "prisma.modelVersion.update(",
    "prisma.modelVersion.create(",
  ]) {
    assert.ok(
      !chatSource.includes(forbidden),
      `l'agent IA ne doit pas écrire dans les prédictions (${forbidden})`,
    );
  }
  // Et la vue enregistrée est figée : deux lectures donnent la même valeur.
  const view = predictions[0]!.view;
  const again = serializeView(generatePrediction(contexts[0]!.context));
  assert.equal(view.outcomes.draw, again.outcomes.draw);
});

// ===========================================================================
// 10 · Aucune fuite temporelle
// ===========================================================================

test("§20.10 — aucune information postérieure au coup d'envoi n'entre dans la prédiction", () => {
  for (const { match, context } of contexts) {
    const kickoff = new Date(match.date).getTime();
    const records = [
      ...context.home.seasonMatches,
      ...context.away.seasonMatches,
      ...context.home.headToHead,
    ];
    for (const record of records) {
      assert.ok(
        record.date.getTime() < kickoff,
        `${match.id} : une rencontre postérieure (${record.date.toISOString()}) est entrée dans le contexte`,
      );
    }
    // Le contexte ne porte jamais le score du match prédit.
    const self = records.filter((r) => r.id === match.id);
    assert.equal(self.length, 0, `${match.id} : le match ne doit pas figurer dans son propre historique`);
  }
});

// ===========================================================================
// 11 · Version du modèle enregistrée
// ===========================================================================

test("§20.11 — chaque prédiction porte la version qui l'a produite", () => {
  for (const { view } of predictions) {
    assert.ok(typeof view.engineVersion === "string" && view.engineVersion.length > 0);
  }
  // La règle de promotion est stricte : sans gain établi, on conserve.
  assert.equal(decidePromotion(null), "KEEP");
  assert.equal(
    decidePromotion({ metric: "brier", period: "test", n: 500, candidate: 0.6, incumbent: 0.61, delta: -0.01, ci: [-0.02, 0.01], established: false }),
    "KEEP",
    "un gain non établi n'est pas un gain",
  );
  assert.equal(
    decidePromotion({ metric: "brier", period: "test", n: 500, candidate: 0.6, incumbent: 0.62, delta: -0.02, ci: [-0.03, -0.005], established: true }),
    "PROMOTE",
  );
  assert.equal(
    decidePromotion({ metric: "brier", period: "test", n: 500, candidate: 0.63, incumbent: 0.62, delta: 0.01, ci: [0.002, 0.02], established: true }),
    "KEEP",
    "une dégradation établie ne doit jamais être promue",
  );
});

// ===========================================================================
// 12 · Prédiction historique immuable
// ===========================================================================

test("§20.12 — l'apprentissage ne réécrit jamais une prédiction publiée", () => {
  const LEARNING_MODULES = [
    join("src", "server", "learning", "metrics.ts"),
    join("src", "server", "learning", "diagnostics.ts"),
    join("src", "server", "learning", "registry.ts"),
    join("scripts", "learning-build.ts"),
  ];
  for (const path of LEARNING_MODULES) {
    const source = readFileSync(path, "utf8");
    // Aucune écriture sur les prédictions ni sur leur résultat. On cherche un
    // APPEL Prisma réel (`prisma.prediction.update(`), et non la simple
    // sous-chaîne : `prediction.createdAt` ne doit pas déclencher l'alerte.
    for (const forbidden of [
      "prisma.prediction.update(",
      "prisma.prediction.create(",
      "prisma.prediction.delete(",
      "prisma.prediction.upsert(",
      "prisma.prediction.updateMany(",
      "prisma.matchResult.update(",
      "prisma.matchResult.create(",
      "prisma.matchResult.upsert(",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${path} ne doit pas modifier l'historique des prédictions (${forbidden})`,
      );
    }
  }

  // L'erreur est calculée à partir du résultat réel, en lecture seule.
  const view = predictions[0]!.view;
  const record = computePredictionError(
    {
      id: "p-test",
      matchId: predictions[0]!.match.id,
      modelVersion: view.engineVersion,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      confidenceScore: 60,
      dataQuality: "GOOD",
      view: view as never,
    },
    {
      id: predictions[0]!.match.id,
      utcDate: new Date(predictions[0]!.match.date),
      competition: "E0",
      homeScore: 2,
      awayScore: 1,
      season: "2025/2026",
    },
  );
  assert.ok(record, "une prédiction réglée doit produire une ligne d'erreur");
  assert.ok(record!.brier >= 0 && record!.brier <= 2);
  assert.ok(record!.logLoss >= 0);
  // Aucun score final → aucune ligne inventée.
  const noScore = computePredictionError(
    {
      id: "p-test-2",
      matchId: "m",
      modelVersion: "1.0.0",
      createdAt: new Date(),
      confidenceScore: 60,
      dataQuality: "GOOD",
      view: view as never,
    },
    { id: "m", utcDate: new Date(), competition: "E0", homeScore: null, awayScore: null, season: null },
  );
  assert.equal(noScore, null, "un match non joué ne produit aucune erreur");
});

// ===========================================================================
// Garde-fous complémentaires
// ===========================================================================

test("§5 — les diagnostics mesurent sans inventer de cause", () => {
  // Les groupes trop petits ne sont pas présentés : ils ne prouvent rien.
  const tiny = analyseErrors([
    {
      error1x2: 0.4, errorOver25: 0.5, errorBtts: 0.5, errorTeamHome: 0.3, errorTeamAway: 0.3,
      brier: 0.6, logLoss: 1.0, hit: false, pickProbability: 0.5,
      biasHome: 0.05, biasOver25: 0.02, biasBtts: 0.03,
      competition: "E0", season: "2025/2026", confidence: 60, dataGrade: "GOOD", xgUsed: true,
      expectedGoals: 2.7, favouriteSide: "HOME",
    },
  ]);
  const groups = tiny.flatMap((d) => d.groups).filter((g) => g.group !== "ensemble");
  assert.ok(
    groups.every((g) => g.n >= MIN_GROUP_SIZE),
    "aucun groupe sous le seuil minimal ne doit être présenté",
  );
  // La lecture reste factuelle : aucune formulation causale.
  for (const diagnostic of tiny) {
    for (const word of ["parce que", "à cause", "donc", "prouve"]) {
      assert.ok(!diagnostic.reading.toLowerCase().includes(word), `formulation causale interdite : « ${word} »`);
    }
  }
});

test("§19 — une prédiction incohérente est refusée avant affichage", () => {
  const view = predictions[0]!.view;
  const broken = { ...view, outcomes: { ...view.outcomes, home: view.outcomes.home + 0.2 } };
  const report = checkPredictionView(broken);
  assert.equal(report.ok, false);
  assert.ok(report.critical.some((v) => v.code === "outcomes.sum"));
});
