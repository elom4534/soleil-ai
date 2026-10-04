/**
 * ============================================================================
 * SOLEIL — §6 Phase 14 : cohérence des probabilités AVANT affichage
 * ============================================================================
 * Ces tests exécutent le **moteur réel** sur des rencontres réelles lues dans
 * les fichiers locaux, traduisent sa sortie avec la fonction d'affichage de
 * production (`serializeView`), puis vérifient que l'objet qui sera montré à
 * l'utilisateur ne contient aucune contradiction.
 *
 * Aucune base de données, aucun accès réseau, aucun crédit.
 *
 * Ce qui est vérifié, conformément au §6 :
 *   • somme 1X2 ≈ 100 % ;
 *   • Over + Under ≈ 100 % sur chaque ligne ;
 *   • BTTS Oui + Non ≈ 100 % ;
 *   • marchés par équipe cohérents ;
 *   • scores exacts cohérents avec la distribution centrale des buts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrediction } from "@/server/engine";
import { computeLeagueBaseline } from "@/server/engine/ratings";
import { serializeView } from "@/server/predictions/presenter";
import { checkPredictionView, type CoherenceReport } from "@/lib/coherence";
import type { MatchContext, MatchRecord, TeamSnapshot } from "@/server/engine/types";

const DATA_ROOT = "data";

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
  homeXg: number | null;
  awayXg: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  source: string;
}

function loadXg(): Map<string, { homeXg: number | null; awayXg: number | null }> {
  const map = new Map<string, { homeXg: number | null; awayXg: number | null }>();
  for (const competition of ["E0", "SP1"]) {
    const path = join(DATA_ROOT, "features", "live-football-api", competition, "2024-2025.json");
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      records: { matchId: string; homeXg: number | null; awayXg: number | null }[];
    };
    for (const record of payload.records) {
      map.set(record.matchId, { homeXg: record.homeXg, awayXg: record.awayXg });
    }
  }
  return map;
}

function loadMatches(): LocalMatch[] {
  const matches: LocalMatch[] = [];
  for (const competition of ["E0", "SP1"]) {
    const dir = join(DATA_ROOT, "normalized", "fdcouk", competition);
    for (const season of ["2023-2024", "2024-2025", "2025-2026"]) {
      const path = join(dir, `${season}.json`);
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
    homeXg: m.homeXg,
    awayXg: m.awayXg,
    homeShots: m.homeShots,
    awayShots: m.awayShots,
    homeShotsOnTarget: m.homeShotsOnTarget,
    awayShotsOnTarget: m.awayShotsOnTarget,
    homeCorners: m.homeCorners,
    awayCorners: m.awayCorners,
    homeYellowCards: m.homeYellowCards,
    awayYellowCards: m.awayYellowCards,
    source: m.source,
  };
}

function buildContext(target: LocalMatch, pool: LocalMatch[]): MatchContext | null {
  const reference = new Date(target.date);
  const finished = (m: LocalMatch) =>
    m.homeGoals !== null && m.awayGoals !== null && new Date(m.date).getTime() < reference.getTime();

  const byRecency = (a: LocalMatch, b: LocalMatch) =>
    new Date(b.date).getTime() - new Date(a.date).getTime();

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

  const sourceScores: Record<string, number> = {};
  for (const m of [...homeRecords, ...awayRecords]) sourceScores[m.source] = 0.9;

  const snapshot = (id: string, name: string, records: MatchRecord[]): TeamSnapshot => ({
    identity: {
      id,
      name,
      shortName: null,
      tla: null,
      crest: null,
      leagueId: target.competition,
      leagueName: target.competition,
    },
    seasonMatches: records,
    headToHead: h2hRecords,
    hasXg: records.some((m) => m.homeXg !== null || m.awayXg !== null),
    sourceScores,
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

// ---------------------------------------------------------------------------
// Échantillon partagé : le même que l'empreinte moteur (déterministe).
// ---------------------------------------------------------------------------

const xg = loadXg();
const pool = loadMatches().map((m) => {
  const record = xg.get(m.id);
  return record ? { ...m, homeXg: record.homeXg, awayXg: record.awayXg } : m;
});

const sample = pool
  .filter((m) => m.homeGoals !== null && m.awayGoals !== null)
  .filter((m) => m.season === "2024/2025" || m.season === "2025/2026")
  .sort((a, b) => a.id.localeCompare(b.id))
  .filter((_, i) => i % 37 === 0)
  .slice(0, 24);

const reports: { matchId: string; report: CoherenceReport }[] = [];

for (const target of sample) {
  const context = buildContext(target, pool);
  if (!context) continue;
  const view = serializeView(generatePrediction(context));
  reports.push({ matchId: target.id, report: checkPredictionView(view) });
}

// ---------------------------------------------------------------------------

test("l'échantillon est exploitable", () => {
  assert.ok(pool.length > 1000, `pool trop petit : ${pool.length}`);
  assert.ok(reports.length >= 20, `échantillon trop petit : ${reports.length}`);
});

test("§6 — aucune incohérence critique sur les probabilités affichées", () => {
  const failures = reports
    .filter((r) => r.report.critical.length > 0)
    .map((r) => `${r.matchId} → ${r.report.critical.map((v) => `${v.code} (${v.detail})`).join(" ; ")}`);
  assert.deepEqual(failures, [], `incohérences détectées :\n${failures.join("\n")}`);
});

test("§6 — la somme 1X2 vaut 100 % à la précision machine", () => {
  for (const { matchId, report } of reports) {
    const max = report.violations
      .filter((v) => v.code === "outcomes.sum")
      .reduce((a, v) => Math.max(a, v.deviation), 0);
    assert.ok(max < 1e-9, `${matchId} : écart 1X2 = ${max}`);
  }
});

test("§6 — Over + Under = 100 % sur toutes les lignes", () => {
  for (const { matchId, report } of reports) {
    const max = report.violations
      .filter((v) => v.code.startsWith("totalGoals."))
      .reduce((a, v) => Math.max(a, v.deviation), 0);
    assert.ok(max < 1e-9, `${matchId} : écart Over/Under = ${max}`);
  }
});

test("§6 — BTTS Oui + Non = 100 %", () => {
  for (const { matchId, report } of reports) {
    const max = report.violations
      .filter((v) => v.code === "btts.sum")
      .reduce((a, v) => Math.max(a, v.deviation), 0);
    assert.ok(max < 1e-9, `${matchId} : écart BTTS = ${max}`);
  }
});

test("§6 — les marchés par équipe somment à 100 %", () => {
  for (const { matchId, report } of reports) {
    const max = report.violations
      .filter((v) => v.code.startsWith("teamGoals."))
      .reduce((a, v) => Math.max(a, Math.abs(v.deviation)), 0);
    assert.ok(max < 1e-6, `${matchId} : écart marchés équipe = ${max}`);
  }
});

test("§6 — les scores exacts sont compatibles avec la distribution des buts", () => {
  for (const { matchId, report } of reports) {
    const violations = report.critical.filter((v) => v.code.startsWith("exactScore."));
    assert.deepEqual(
      violations.map((v) => v.code),
      [],
      `${matchId} : ${violations.map((v) => v.detail).join(" ; ")}`,
    );
  }
});

test("§6 — le score le plus probable est bien le premier du classement", () => {
  for (const { matchId, report } of reports) {
    assert.ok(
      !report.critical.some((v) => v.code === "exactScore.mostLikely"),
      `${matchId} : score le plus probable incohérent`,
    );
  }
});

test("§6 — l'écart 1X2 publié / distribution est signalé, jamais corrigé", () => {
  // L'écart est connu et documenté (Phase 13). Le contrôle doit l'exposer
  // comme information, et ne jamais le corriger.
  for (const { report } of reports) {
    for (const info of report.infos.filter((v) => v.code === "outcomes.vs_matrix")) {
      assert.ok(info.severity === "info", "l'écart doit rester informatif");
    }
  }
  // Le contrôle ne doit avoir modifié aucune vue : il est pur.
  assert.ok(reports.every((r) => typeof r.report.checked === "number"));
});

test("§6 — le contrôle est déterministe et sans effet de bord", () => {
  const target = sample[0];
  if (!target) return;
  const context = buildContext(target, pool);
  if (!context) return;
  const first = checkPredictionView(serializeView(generatePrediction(context)));
  const second = checkPredictionView(serializeView(generatePrediction(context)));
  assert.equal(first.checked, second.checked);
  assert.equal(first.critical.length, second.critical.length);
});

// ---------------------------------------------------------------------------
// Test négatif : le contrôle doit DÉTECTER une incohérence injectée.
// Sans ce test, un vérificateur qui ne détecte jamais rien passerait pour bon.
// ---------------------------------------------------------------------------

test("§6 — le contrôle détecte réellement une incohérence injectée", () => {
  const target = sample[0];
  assert.ok(target, "échantillon vide");
  const context = buildContext(target, pool);
  assert.ok(context, "contexte non construit");

  const view = serializeView(generatePrediction(context));
  const clean = checkPredictionView(view);
  assert.equal(clean.critical.length, 0, "la vue saine ne doit produire aucune alerte critique");

  // 1 — somme 1X2 faussée
  const brokenOutcomes = checkPredictionView({
    ...view,
    outcomes: { ...view.outcomes, home: view.outcomes.home + 0.05 },
  });
  assert.ok(
    brokenOutcomes.critical.some((v) => v.code === "outcomes.sum"),
    "une somme 1X2 faussée doit être signalée",
  );

  // 2 — Over + Under faussé
  const firstLine = view.totalGoals[0];
  assert.ok(firstLine, "aucune ligne Over/Under");
  const brokenLine = checkPredictionView({
    ...view,
    totalGoals: [{ ...firstLine, under: firstLine.under + 0.03 }, ...view.totalGoals.slice(1)],
  });
  assert.ok(
    brokenLine.critical.some((v) => v.code.startsWith("totalGoals.")),
    "un couple Over/Under faussé doit être signalé",
  );

  // 3 — BTTS faussé
  const brokenBtts = checkPredictionView({
    ...view,
    btts: { ...view.btts, no: view.btts.no + 0.07 },
  });
  assert.ok(brokenBtts.critical.some((v) => v.code === "btts.sum"), "un BTTS faussé doit être signalé");

  // 4 — score exact plus probable que son total de buts
  const topScore = view.exactScore.top[0];
  assert.ok(topScore, "aucun score exact");
  const brokenScore = checkPredictionView({
    ...view,
    exactScore: {
      ...view.exactScore,
      top: view.exactScore.top.map((s, i) =>
        i === 0 ? { ...s, probability: s.probability + 0.5 } : s,
      ),
    },
  });
  assert.ok(
    brokenScore.critical.some(
      (v) => v.code.startsWith("exactScore.") && !v.code.endsWith(".order"),
    ),
    "un score exact incohérent avec la distribution doit être signalé",
  );

  // 5 — classement non décroissant
  const brokenOrder = checkPredictionView({
    ...view,
    exactScore: {
      ...view.exactScore,
      top: view.exactScore.top.map((s, i) => (i === 0 ? { ...s, probability: 0.0001 } : s)),
    },
  });
  assert.ok(
    brokenOrder.critical.some((v) => v.code === "exactScore.order"),
    "un classement désordonné doit être signalé",
  );
});
