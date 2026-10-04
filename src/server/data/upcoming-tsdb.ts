/**
 * ============================================================================
 * SOLEIL — Alimentation automatique des matchs à venir (source gratuite)
 * ============================================================================
 * Rôle : rendre la récupération des rencontres **à venir** automatique et
 * indépendante du fournisseur payant. La source est TheSportsDB (déjà présente
 * dans le projet, niveau libre) : 0 crédit, aucune clé payante.
 *
 * Chaîne : collecte (réseau ou cache) → sélection honnête (E0/SP1, à venir,
 * convertibles) → `runUpcomingPipeline` (dédup §10, identités §17, logos de la
 * source §15/§16, prédictions obligatoires §19, journal §26).
 *
 * Aucune donnée n'est fabriquée (§13) ; le moteur n'est pas modifié (§1).
 * Utilisé par `scripts/ingest-upcoming-tsdb.ts` et par la tâche planifiée
 * `alimentation-matchs-a-venir`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runUpcomingPipeline, type PipelineReport } from "./upcoming-pipeline";
import {
  TSDB_LEAGUE_CODES,
  tsdbEventToFixture,
  tsdbFetchDayFromEvents,
  type TsdbEvent,
} from "./providers/theSportsDbFixtures";

const BASE_URL = "https://www.thesportsdb.com/api/v1/json";

/** Compétitions visées : identifiant TheSportsDB → code interne. */
export const TSDB_UPCOMING_LEAGUES = [
  { tsdbId: "4328", code: "E0", label: "Premier League (Angleterre)" },
  { tsdbId: "4335", code: "SP1", label: "LaLiga (Espagne)" },
];

/** Même convention que `theSportsDb.ts` : clé dans `THESPORTSDB_KEY`, défaut 3. */
function tsdbKey(): string {
  return process.env.THESPORTSDB_KEY || "3";
}

export interface TsdbUpcomingReport {
  collected: number;
  kept: number;
  dates: string[];
  creditsSpent: number;
  inserted: number;
  updated: number;
  predictionsGenerated: number;
  predictionsPublished: number;
  predictionsWithheld: number;
  errors: string[];
  notes: string[];
  pipeline: PipelineReport | null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  return response.json();
}

function eventsOf(json: unknown): TsdbEvent[] {
  if (!json || typeof json !== "object") return [];
  const events = (json as { events?: unknown }).events;
  return Array.isArray(events) ? (events as TsdbEvent[]) : [];
}

/**
 * Collecte les événements à venir des compétitions visées.
 * `cacheOnly` : relit `data/cache-tsdb/` (0 requête) ; sinon réseau + copie
 * des réponses brutes dans ce dossier (audit, §26).
 */
export async function collectTsdbUpcoming(options: {
  cacheOnly?: boolean;
  cacheDir?: string;
  season?: string;
  log?: (line: string) => void;
}): Promise<Map<string, TsdbEvent>> {
  const log = options.log ?? (() => undefined);
  const cacheDir = options.cacheDir ?? path.join(process.cwd(), "data", "cache-tsdb");
  const season = options.season ?? "2026-2027";
  const collected = new Map<string, TsdbEvent>();
  mkdirSync(cacheDir, { recursive: true });

  const ingestRows = (rows: TsdbEvent[], origin: string): void => {
    for (const event of rows) {
      const id = (event.idEvent ?? "").trim();
      if (id) collected.set(id, event);
    }
    log(`${origin} : ${rows.length} événement(s)`);
  };

  if (options.cacheOnly) {
    for (const file of readdirSync(cacheDir).sort()) {
      if (!file.endsWith(".json")) continue;
      ingestRows(eventsOf(safeParse(path.join(cacheDir, file))), file);
    }
    return collected;
  }

  const key = tsdbKey();
  for (const league of TSDB_UPCOMING_LEAGUES) {
    const nextUrl = `${BASE_URL}/${key}/eventsnextleague.php?id=${league.tsdbId}`;
    const nextJson = await fetchJson(nextUrl);
    const nextEvents = eventsOf(nextJson);
    ingestRows(nextEvents, `eventsnextleague ${league.code}`);
    writeFileSync(path.join(cacheDir, `next-${league.code.toLowerCase()}.json`), JSON.stringify(nextJson ?? {}, null, 2));

    // Journée publiée + suivante, plafonnée à 4 requêtes par compétition (§32).
    const rounds = [...new Set(nextEvents.map((e) => Number(e.intRound)).filter((r) => Number.isFinite(r) && r > 0))].sort(
      (a, b) => a - b,
    );
    const wanted = [...new Set(rounds.flatMap((r) => [r, r + 1]))].slice(0, 4);
    for (const round of wanted) {
      const roundUrl = `${BASE_URL}/${key}/eventsround.php?id=${league.tsdbId}&r=${round}&s=${season}`;
      const roundJson = await fetchJson(roundUrl);
      ingestRows(eventsOf(roundJson), `eventsround ${league.code} · journée ${round}`);
      writeFileSync(path.join(cacheDir, `round-${league.code.toLowerCase()}-${round}.json`), JSON.stringify(roundJson ?? {}, null, 2));
    }
    if (rounds.length === 0) log(`${league.code} : aucune journée publiée — journées ignorées`);
  }
  return collected;
}

function safeParse(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Alimente les rencontres à venir (E0, SP1) et leurs prédictions.
 * Idempotent (§11) : rejouer ne crée aucun doublon.
 */
export async function ingestTsdbUpcoming(options: {
  cacheOnly?: boolean;
  cacheDir?: string;
  season?: string;
  now?: Date;
  log?: (line: string) => void;
}): Promise<TsdbUpcomingReport> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();

  const collected = await collectTsdbUpcoming({
    cacheOnly: options.cacheOnly,
    cacheDir: options.cacheDir,
    season: options.season,
    log,
  });

  const rows = [...collected.values()]
    .map((event) => ({ event, fixture: tsdbEventToFixture(event) }))
    .filter((row): row is { event: TsdbEvent; fixture: NonNullable<ReturnType<typeof tsdbEventToFixture>> } => row.fixture !== null)
    .filter((row) => TSDB_LEAGUE_CODES[(row.event.idLeague ?? "").trim()] !== undefined)
    .filter((row) => row.fixture.utcDate.getTime() > now.getTime())
    .filter((row) => row.fixture.status === "scheduled")
    .sort((a, b) => a.fixture.utcDate.getTime() - b.fixture.utcDate.getTime());

  log(`${rows.length} rencontre(s) à venir retenue(s) sur ${collected.size} événement(s) collecté(s)`);

  const report: TsdbUpcomingReport = {
    collected: collected.size,
    kept: rows.length,
    dates: [],
    creditsSpent: 0,
    inserted: 0,
    updated: 0,
    predictionsGenerated: 0,
    predictionsPublished: 0,
    predictionsWithheld: 0,
    errors: [],
    notes: [],
    pipeline: null,
  };

  if (rows.length === 0) {
    report.notes.push("Aucune rencontre à venir : rien à ingérer, rien à prédire (§19).");
    return report;
  }

  const dates = [...new Set(rows.map((row) => row.fixture.utcDate.toISOString().slice(0, 10)))].sort();
  report.dates = dates;

  const pipeline = await runUpcomingPipeline({
    dates,
    competitionCodes: ["E0", "SP1"],
    allowNetwork: false,
    predict: true,
    fetchDay: tsdbFetchDayFromEvents(rows.map((row) => row.event)),
    log,
  });

  report.pipeline = pipeline;
  report.creditsSpent = pipeline.totals.creditsSpent;
  report.inserted = pipeline.totals.inserted;
  report.updated = pipeline.totals.updated;
  report.predictionsGenerated = pipeline.totals.predictionsGenerated;
  report.predictionsPublished = pipeline.totals.predictionsPublished;
  report.predictionsWithheld = pipeline.totals.predictionsWithheld;
  for (const day of pipeline.days) {
    report.errors.push(...day.errors);
    report.notes.push(...day.notes);
  }
  return report;
}
