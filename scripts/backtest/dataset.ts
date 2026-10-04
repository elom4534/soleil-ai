/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Couche dataset du backtest
 * ============================================================================
 * §21 — Le dataset doit vivre sur disque, versionné, et ne pas dépendre
 * uniquement de PostgreSQL local.
 *
 *   data/raw/         → fichiers sources intacts (CSV football-data.co.uk)
 *   data/normalized/  → matchs au format canonique SOLEIL
 *   data/features/    → enrichissements payants (xG LiveFootballApi)
 *   data/backtests/   → résultats de chaque exécution
 *
 * Source gratuite : football-data.co.uk (aucun crédit, aucune clé).
 * Elle ne publie AUCUN xG — vérifié le 29/09/2026 : 132 colonnes, zéro
 * colonne « xG »/« expected ». Le xG ne peut donc venir que de LiveFootballApi.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseCsv } from "../../src/server/data/providers/csv";

export const DATA_ROOT = "data";

/** Saison « 2025/2026 » → code fichier « 2526 ». */
export function toSeasonCode(season: string): string {
  return season.split("/").map((part) => part.slice(-2)).join("");
}

/** Compétitions et libellés. L'ordre suit la priorité de la phase 11 (§7). */
export const COMPETITIONS: Record<string, { name: string; country: string }> = {
  E0: { name: "Premier League", country: "England" },
  SP1: { name: "LaLiga", country: "Spain" },
};

/**
 * Un match du backtest : la forme consommée par le moteur, plus de quoi
 * mesurer (cotes de clôture) et tracer (saison, noms).
 */
export interface BacktestMatch {
  id: string;
  season: string;
  date: Date;
  competition: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  homeGoals: number;
  awayGoals: number;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  /** xG — `null` tant que la rencontre n'a pas été enrichie (jamais inventé). */
  homeXg: number | null;
  awayXg: number | null;
  /** Statistiques avancées GRATUITES (football-data.co.uk) — servent de contrôle. */
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  /**
   * Cotes de clôture dé-marginalisées (1X2). Servent de RÉFÉRENCE de marché,
   * jamais d'entrée du modèle : le but est de mesurer SOLEIL, pas de copier
   * un bookmaker.
   */
  closingOdds: { home: number; draw: number; away: number } | null;
  source: string;
}

// ---------------------------------------------------------------------------
// Lecture des fichiers bruts
// ---------------------------------------------------------------------------

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** « 15/08/2025 » ou « 15/08/25 » → Date UTC à midi (évite les bascules de fuseau). */
export function parseDate(raw: string): Date | null {
  const m = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/** Identifiant d'équipe stable et lisible, dérivé du nom. */
export function teamId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `fdcouk:team:${slug}`;
}

/** Préfixes de cotes de clôture, par ordre de préférence. */
const ODDS_PREFIXES = ["AvgC", "B365C", "PSC", "MaxC", "Avg"];

function closingOdds(row: Record<string, string>): { home: number; draw: number; away: number } | null {
  for (const prefix of ODDS_PREFIXES) {
    const h = num(row[`${prefix}H`]);
    const d = num(row[`${prefix}D`]);
    const a = num(row[`${prefix}A`]);
    if (h && d && a && h > 1 && d > 1 && a > 1) {
      // Dé-marginalisation proportionnelle : la marge du bookmaker est
      // retirée pour que la référence soit comparable à une probabilité.
      const raw = { home: 1 / h, draw: 1 / d, away: 1 / a };
      const total = raw.home + raw.draw + raw.away;
      return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
    }
  }
  return null;
}

/** Transforme un CSV football-data.co.uk en matchs du backtest. */
export function parseSeason(csv: string, competition: string, season: string): BacktestMatch[] {
  const rows = parseCsv(csv);
  const matches: BacktestMatch[] = [];

  for (const row of rows) {
    const home = row.HomeTeam;
    const away = row.AwayTeam;
    const date = parseDate(row.Date ?? "");
    if (!home || !away || !date) continue;

    const homeGoals = num(row.FTHG);
    const awayGoals = num(row.FTAG);
    // Sans score final, la rencontre n'est pas évaluable : on l'écarte plutôt
    // que de la considérer comme 0-0.
    if (homeGoals === null || awayGoals === null) continue;

    matches.push({
      id: `fdcouk:${competition}:${season}:${date.toISOString().slice(0, 10)}:${teamId(home)}-${teamId(away)}`,
      season,
      date,
      competition,
      homeTeamId: teamId(home),
      homeTeamName: home,
      awayTeamId: teamId(away),
      awayTeamName: away,
      homeGoals,
      awayGoals,
      halfTimeHomeGoals: num(row.HTHG),
      halfTimeAwayGoals: num(row.HTAG),
      homeXg: null,
      awayXg: null,
      homeShots: num(row.HS),
      awayShots: num(row.AS),
      homeShotsOnTarget: num(row.HST),
      awayShotsOnTarget: num(row.AST),
      homeCorners: num(row.HC),
      awayCorners: num(row.AC),
      homeYellowCards: num(row.HY),
      awayYellowCards: num(row.AY),
      closingOdds: closingOdds(row),
      source: "football-data.co.uk",
    });
  }

  // Deux matchs le même jour entre les mêmes équipes = doublon de fichier.
  const seen = new Set<string>();
  const unique = matches.filter((m) => {
    const key = `${m.competition}:${m.date.toISOString().slice(0, 10)}:${m.homeTeamId}:${m.awayTeamId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Télécharge (si absent) et met en cache le CSV brut. Aucun crédit engagé. */
export async function fetchRawSeason(competition: string, season: string): Promise<string> {
  const dir = join(DATA_ROOT, "raw", "fdcouk", toSeasonCode(season));
  ensureDir(dir);
  const path = join(dir, `${competition}.csv`);
  if (existsSync(path)) return readFileSync(path, "utf8");

  const url = `https://www.football-data.co.uk/mmz4281/${toSeasonCode(season)}/${competition}.csv`;
  const response = await fetch(url, {
    headers: { "User-Agent": "SOLEIL/1.0 (plateforme d'analyse statistique)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`);
  const csv = await response.text();
  writeFileSync(path, csv);
  return csv;
}

/**
 * Charge une saison : disque si présent, téléchargement gratuit sinon.
 * Le mode `refresh` force la relecture de la source.
 */
export async function loadSeason(
  competition: string,
  season: string,
  options: { refresh?: boolean } = {},
): Promise<BacktestMatch[]> {
  const dir = join(DATA_ROOT, "normalized", "fdcouk", competition);
  ensureDir(dir);
  const path = join(dir, `${season.replace("/", "-")}.json`);

  if (!options.refresh && existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { matches: (Omit<BacktestMatch, "date"> & { date: string })[] };
    return stored.matches.map((m) => ({ ...m, date: new Date(m.date) }));
  }

  const csv = await fetchRawSeason(competition, season);
  const matches = parseSeason(csv, competition, season);
  if (matches.length === 0) {
    // Saison annoncée mais vide : on l'écrit telle quelle, sans invention.
    writeFileSync(path, JSON.stringify({ competition, season, matches: [] }, null, 2));
    return [];
  }
  writeFileSync(path, JSON.stringify({ competition, season, matches }, null, 2));
  return matches;
}

/** Charge plusieurs saisons d'une compétition, fusionnées et triées par date. */
export async function loadCompetition(
  competition: string,
  seasons: string[],
  options: { refresh?: boolean } = {},
): Promise<BacktestMatch[]> {
  const all: BacktestMatch[] = [];
  for (const season of seasons) {
    all.push(...(await loadSeason(competition, season, options)));
  }
  return all.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Enrichissement payant (xG LiveFootballApi) — chargé depuis `data/features/`.
 * Aucune donnée inventée : une rencontre absente du fichier garde `null`.
 */
export interface XgRecord {
  matchId: string;
  homeXg: number | null;
  awayXg: number | null;
  source: string;
  fetchedAt: string;
}

export function featuresPath(competition: string, season: string): string {
  return join(DATA_ROOT, "features", "live-football-api", competition, `${season.replace("/", "-")}.json`);
}

/** Applique les xG connus à un jeu de matchs. Renvoie le nombre de matchs couverts. */
export function applyXg(matches: BacktestMatch[], records: Map<string, XgRecord>): number {
  let covered = 0;
  for (const match of matches) {
    const record = records.get(match.id);
    if (!record) continue;
    match.homeXg = record.homeXg;
    match.awayXg = record.awayXg;
    if (record.homeXg !== null && record.awayXg !== null) covered += 1;
  }
  return covered;
}

/** Saisons dont la date de fin est antérieure à `season`. */
export function seasonsBefore(season: string, all: string[]): string[] {
  const start = Number(season.split("/")[0]);
  return all.filter((s) => Number(s.split("/")[0]) < start);
}
