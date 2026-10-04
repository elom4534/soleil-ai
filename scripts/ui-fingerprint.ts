/**
 * ============================================================================
 * SOLEIL — Empreinte du moteur (non-régression Phase 14)
 * ============================================================================
 * Phase 14 est une phase d'interface : les probabilités affichées doivent
 * rester exactement celles du moteur. Ce script produit la preuve.
 *
 * Il construit des `MatchContext` réels à partir des **fichiers locaux**
 * (aucun accès réseau, aucun crédit), exécute le moteur de production
 * `generatePrediction`, sérialise canoniquement chaque sortie et en calcule
 * une empreinte SHA-256.
 *
 * Deux exécutions — avant et après les modifications d'interface — doivent
 * produire exactement la même empreinte. Le script ne dépend d'aucune base
 * de données : il survit donc à un redéploiement du bac à sable.
 *
 * Usage :
 *   npx tsx scripts/ui-fingerprint.ts                 → calcule et affiche
 *   npx tsx scripts/ui-fingerprint.ts --check         → compare à la référence
 *   npx tsx scripts/ui-fingerprint.ts --label "avant" → enregistre une référence
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generatePrediction } from "../src/server/engine";
import { computeLeagueBaseline } from "../src/server/engine/ratings";
import type {
  LeagueBaseline,
  MatchContext,
  MatchRecord,
  TeamSnapshot,
} from "../src/server/engine/types";

const DATA_ROOT = "data";
const BASELINE_DIR = join(DATA_ROOT, "ui-baseline");
const FINGERPRINT_PATH = join(BASELINE_DIR, "engine-fingerprint.json");

/** Nombre de rencontres échantillonnées — assez pour couvrir tous les cas. */
const SAMPLE_SIZE = 40;

// ---------------------------------------------------------------------------
// Chargement des données locales
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

/** Charge les xG réellement collectés en Phase 11 (aucun crédit supplémentaire). */
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

function loadCompetition(competition: string): LocalMatch[] {
  const dir = join(DATA_ROOT, "normalized", "fdcouk", competition);
  const files = ["2022-2023", "2023-2024", "2024-2025", "2025-2026"];
  const matches: LocalMatch[] = [];
  for (const file of files) {
    const path = join(dir, `${file}.json`);
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as { matches: LocalMatch[] };
    matches.push(...payload.matches);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Construction du contexte — miroir fidèle de `buildMatchContext`
// ---------------------------------------------------------------------------

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

function sourceScoreFor(source: string): number {
  switch (source) {
    case "football-data-co-uk":
      return 0.9;
    case "football-data-org":
      return 0.85;
    case "thesportsdb":
      return 0.6;
    default:
      return 0.5;
  }
}

function buildContext(target: LocalMatch, pool: LocalMatch[]): MatchContext | null {
  const reference = new Date(target.date);
  const isFinished = (m: LocalMatch) =>
    m.homeGoals !== null && m.awayGoals !== null && new Date(m.date).getTime() < reference.getTime();

  const homeMatches = pool
    .filter((m) => isFinished(m) && (m.homeTeamId === target.homeTeamId || m.awayTeamId === target.homeTeamId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 60);

  const awayMatches = pool
    .filter((m) => isFinished(m) && (m.homeTeamId === target.awayTeamId || m.awayTeamId === target.awayTeamId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 60);

  const h2h = pool
    .filter(
      (m) =>
        isFinished(m) &&
        ((m.homeTeamId === target.homeTeamId && m.awayTeamId === target.awayTeamId) ||
          (m.homeTeamId === target.awayTeamId && m.awayTeamId === target.homeTeamId)),
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 12);

  let leagueRecords = pool
    .filter((m) => isFinished(m) && m.competition === target.competition && m.season === target.season)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 600)
    .map(toRecord);

  if (leagueRecords.length < 40) {
    leagueRecords = pool
      .filter((m) => isFinished(m) && m.competition === target.competition)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 600)
      .map(toRecord);
  }

  const baseline: LeagueBaseline | null = computeLeagueBaseline(leagueRecords);
  if (!baseline) return null;

  const homeRecords = homeMatches.map(toRecord);
  const awayRecords = awayMatches.map(toRecord);
  const h2hRecords = h2h.map(toRecord);

  const sourceScores: Record<string, number> = {};
  for (const m of [...homeRecords, ...awayRecords]) {
    sourceScores[m.source] = sourceScoreFor(m.source);
  }

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
// Sérialisation canonique
// ---------------------------------------------------------------------------

/**
 * Réduit la sortie du moteur à ce qui doit rester invariant : toutes les
 * probabilités et tous les marchés. Les horodatages sont exclus — ils
 * changent légitimement d'une exécution à l'autre.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === "generatedAt" || key === "generated_at") continue;
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

// ---------------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const labelIndex = argv.indexOf("--label");
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : null;
  const check = argv.includes("--check");
  const dumpIndex = argv.indexOf("--dump");
  const dumpPath = dumpIndex >= 0 ? argv[dumpIndex + 1] : null;

  const xg = loadXg();
  const pool = [...loadCompetition("E0"), ...loadCompetition("SP1")].map((m) => {
    const record = xg.get(m.id);
    return record ? { ...m, homeXg: record.homeXg, awayXg: record.awayXg } : m;
  });

  // Échantillon déterministe : tri par identifiant, puis sélection régulière.
  const finished = pool
    .filter((m) => m.homeGoals !== null && m.awayGoals !== null)
    .filter((m) => m.season === "2024/2025" || m.season === "2025/2026")
    .sort((a, b) => a.id.localeCompare(b.id));

  const withXg = finished.filter((m) => m.homeXg !== null);
  const withoutXg = finished.filter((m) => m.homeXg === null);

  // 3/4 de rencontres avec xG, 1/4 sans : les deux chemins du moteur sont couverts.
  const pickEvenly = <T,>(list: T[], count: number): T[] =>
    count <= 0 || list.length === 0
      ? []
      : Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]!);

  const xgCount = Math.round(SAMPLE_SIZE * 0.75);
  const sample = [...pickEvenly(withXg, xgCount), ...pickEvenly(withoutXg, SAMPLE_SIZE - xgCount)];

  const results: { matchId: string; competition: string; hasXg: boolean; digest: string }[] = [];
  // Vidage auditable : permet de comparer deux états du moteur champ par champ,
  // au lieu de constater une simple différence d'empreinte.
  const dump: { matchId: string; prediction: unknown }[] = [];
  let skipped = 0;

  for (const target of sample) {
    const context = buildContext(target, pool);
    if (!context) {
      skipped += 1;
      continue;
    }
    const prediction = generatePrediction(context);
    if (dumpPath) dump.push({ matchId: target.id, prediction });
    results.push({
      matchId: target.id,
      competition: target.competition,
      hasXg: target.homeXg !== null,
      digest: digest(prediction),
    });
  }

  const globalDigest = createHash("sha256")
    .update(results.map((r) => `${r.matchId}:${r.digest}`).join("\n"))
    .digest("hex");

  console.log("═".repeat(78));
  console.log("SOLEIL — EMPREINTE DU MOTEUR (non-régression Phase 14)");
  console.log("═".repeat(78));
  console.log(`Rencontres échantillonnées : ${results.length} (ignorées : ${skipped})`);
  console.log(`  dont avec xG réel : ${results.filter((r) => r.hasXg).length}`);
  console.log(`  dont sans xG      : ${results.filter((r) => !r.hasXg).length}`);
  console.log(`Compétitions : ${[...new Set(results.map((r) => r.competition))].join(", ")}`);
  console.log("");
  if (dumpPath) {
    writeFileSync(dumpPath, JSON.stringify(dump, null, 1), "utf8");
    console.log(`Vidage auditable : ${dumpPath}`);
  }
  console.log(`EMPREINTE GLOBALE : ${globalDigest}`);
  console.log("");

  if (label) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(
      FINGERPRINT_PATH,
      `${JSON.stringify(
        {
          label,
          recordedAt: new Date().toISOString(),
          sampleSize: results.length,
          digest: globalDigest,
          matches: results,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`✅ Référence enregistrée : ${FINGERPRINT_PATH}`);
    console.log(`   libellé : « ${label} »`);
    return;
  }

  if (check) {
    if (!existsSync(FINGERPRINT_PATH)) {
      console.error("❌ Aucune référence enregistrée. Lancez d'abord avec --label.");
      process.exitCode = 1;
      return;
    }
    const reference = JSON.parse(readFileSync(FINGERPRINT_PATH, "utf8")) as {
      label: string;
      digest: string;
      matches: { matchId: string; digest: string }[];
    };
    const refById = new Map(reference.matches.map((m) => [m.matchId, m.digest]));
    const differences = results.filter((r) => refById.get(r.matchId) !== r.digest);
    const missing = reference.matches.filter((m) => !results.some((r) => r.matchId === m.matchId));

    console.log(`Référence « ${reference.label} » : ${reference.digest}`);
    console.log(`Empreinte actuelle            : ${globalDigest}`);
    console.log("");
    if (globalDigest === reference.digest) {
      console.log(`✅ IDENTIQUE — ${results.length} rencontres, aucune probabilité n'a changé.`);
    } else {
      console.error("❌ DIVERGENCE DÉTECTÉE");
      console.error(`   rencontres divergentes : ${differences.length}`);
      for (const d of differences.slice(0, 10)) console.error(`     · ${d.matchId}`);
      console.error(`   rencontres manquantes  : ${missing.length}`);
      process.exitCode = 1;
    }
    return;
  }

  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.matchId}`);
    console.log(`     ${r.digest}`);
  }
}

main().catch((error) => {
  console.error("❌ Échec :", error);
  process.exitCode = 1;
});
