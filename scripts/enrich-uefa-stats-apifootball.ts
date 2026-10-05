/**
 * enrich-uefa-stats-apifootball.ts — Enrichissement des statistiques des
 * matchs UEFA (UCL / UEL / UNL) déjà présents en base, via APIfootball
 * (apifootball.com, APIv3), à partir de la clé déjà disponible.
 *
 * Avantage de rendement : `get_events` renvoie les statistiques de TOUS les
 * matchs d'une plage de dates pour une ligue en UN SEUL appel (quota horaire,
 * pas de crédit à l'unité).
 *
 * Principes (contraintes de mission) :
 *   · ADDITIF : n'écrit que des champs NULL — jamais d'écrasement ;
 *   · IDEMPOTENT : les réponses API sont cachées sur disque ; une seconde
 *     exécution ne consomme aucun appel et ne réécrit rien d'utile ;
 *   · NON DESTRUCTIF : aucune suppression, aucun DELETE/TRUNCATE/RESET,
 *     aucune écriture sur les Match ni sur les prédictions ;
 *   · aucun secret dans le code (clé lue dans .env) ; aucune prédiction
 *     créée ; moteur inchangé.
 *
 * Champs alimentés : tirs, tirs cadrés, corners, cartons jaunes, cartons
 * rouges (depuis les événements), possession. L'xG n'est pas fourni par ce
 * fournisseur (il reste l'apport de LiveFootballApi).
 *
 * Usage :
 *   node_modules/.bin/tsx scripts/enrich-uefa-stats-apifootball.ts --check   # plan seul, 0 appel
 *   node_modules/.bin/tsx scripts/enrich-uefa-stats-apifootball.ts           # exécution (cache disque)
 */

import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "../src/lib/prisma";

const BASE_URL = "https://apiv3.apifootball.com/";
const CACHE_FILE = path.join(process.cwd(), "stats-cache", "uefa-stats.ndjson");
const REQUEST_DELAY_MS = 1200;

/** Mode sans réseau : uniquement le cache déjà payé, aucun appel API. */
let OFFLINE = false;

// ---------------------------------------------------------------------------
// Cache NDJSON unique et compact (~1-2 Mo) : chaque ligne = une réponse API
// réduite à son utile. Ce format survit aux recyclages d'environnement,
// contrairement à des centaines de fichiers dispersés.
// ---------------------------------------------------------------------------
const cache = new Map<string, unknown>();

function loadCache() {
  if (!existsSync(CACHE_FILE)) return;
  for (const line of readFileSync(CACHE_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { k: string; v: unknown };
      cache.set(row.k, row.v);
    } catch {
      /* ligne corrompue ignorée */
    }
  }
}

function writeCache(key: string, value: unknown) {
  cache.set(key, value);
  mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  appendFileSync(CACHE_FILE, JSON.stringify({ k: key, v: value }) + "\n");
}

/** Événement réduit à l'utile pour le mapping. */
interface ApiEvent {
  match_id: string;
  match_date: string;
  match_status: string;
  match_hometeam_name: string;
  match_awayteam_name: string;
  match_hometeam_score: string;
  match_awayteam_score: string;
  statistics?: Array<{ type: string; home: string; away: string }>;
  cards?: Array<{ home_fault?: string; away_fault?: string; card?: string }>;
}

function reduceEvent(ev: ApiEvent): ApiEvent {
  return {
    match_id: ev.match_id,
    match_date: ev.match_date,
    match_status: ev.match_status,
    match_hometeam_name: ev.match_hometeam_name,
    match_awayteam_name: ev.match_awayteam_name,
    match_hometeam_score: ev.match_hometeam_score,
    match_awayteam_score: ev.match_awayteam_score,
    statistics: ev.statistics,
    cards: ev.cards,
  };
}

/** Ligues UEFA côté APIfootball. */
const LEAGUE_PLAN = [
  { code: "code:UCL", apiLeagueId: "3" },
  { code: "code:UEL", apiLeagueId: "4" },
  { code: "code:UNL", apiLeagueId: "633" },
];

/** Plages trimestrielles couvrant tout l'historique UEFA en base. */
const RANGES: Array<[string, string]> = [
  ["2022-06-01", "2022-08-31"],
  ["2022-09-01", "2022-11-30"],
  ["2022-12-01", "2023-02-28"],
  ["2023-03-01", "2023-05-31"],
  ["2023-06-01", "2023-08-31"],
  ["2023-09-01", "2023-11-30"],
  ["2023-12-01", "2024-02-29"],
  ["2024-03-01", "2024-05-31"],
  ["2024-06-01", "2024-08-31"],
  ["2024-09-01", "2024-11-30"],
  ["2024-12-01", "2025-02-28"],
  ["2025-03-01", "2025-05-31"],
  ["2025-06-01", "2025-08-31"],
  ["2025-09-01", "2025-11-30"],
  ["2025-12-01", "2026-01-31"],
];

const TARGET_FIELDS = [
  "homeShots",
  "awayShots",
  "homeShotsOnTarget",
  "awayShotsOnTarget",
  "homeCorners",
  "awayCorners",
  "homeYellowCards",
  "awayYellowCards",
  "homeRedCards",
  "awayRedCards",
  "homePossession",
  "awayPossession",
] as const;

function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeName(name: string): string[] {
  const stop = new Set([
    "fc", "cf", "ac", "sc", "the", "de", "afc", "sk", "rb", "sv", "ss",
    "us", "as", "nk", "if", "fk", "bk", "cd", "sd", "rc", "rcd", "ud",
  ]);
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w));
}

function namesSimilar(a: string, b: string): boolean {
  const wa = normalizeName(a);
  const wb = normalizeName(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const significant = wa.filter((w) => w.length >= 4);
  if (significant.some((w) => wb.includes(w))) return true;
  const sa = wa.join(" ");
  const sb = wb.join(" ");
  if (Math.abs(sa.length - sb.length) <= 2) {
    let diff = 0;
    const len = Math.max(sa.length, sb.length);
    for (let i = 0; i < len; i++) if (sa[i] !== sb[i]) diff++;
    if (diff <= 2) return true;
  }
  return false;
}

function statOf(stats: Array<{ type: string; home: string; away: string }>, re: RegExp) {
  return stats.find((s) => re.test(s.type.trim()));
}

/** Mappe les statistiques APIfootball vers les colonnes stockées. */
function mapStats(ev: ApiEvent): Record<string, number> {
  const out: Record<string, number> = {};
  const stats = ev.statistics ?? [];
  const set = (
    key: string,
    entry: { home: string; away: string } | undefined,
  ) => {
    if (!entry) return;
    const h = parseNumber(entry.home);
    const a = parseNumber(entry.away);
    if (h !== null) out[`home${key}`] = h;
    if (a !== null) out[`away${key}`] = a;
  };
  set("Shots", statOf(stats, /^shots total$/i) ?? statOf(stats, /^total shots$/i) ?? statOf(stats, /^shots$/i));
  set("ShotsOnTarget", statOf(stats, /^shots on goal$/i) ?? statOf(stats, /^on target$/i) ?? statOf(stats, /^shots on target$/i));
  set("Corners", statOf(stats, /^corners$/i));
  set("YellowCards", statOf(stats, /^yellow cards$/i));
  set("Possession", statOf(stats, /^ball possession$/i) ?? statOf(stats, /^possession$/i));
  const redDirect = statOf(stats, /^red cards?$/i);
  if (redDirect) {
    set("RedCards", redDirect);
  } else if (ev.cards && ev.cards.length > 0) {
    let hr = 0;
    let ar = 0;
    for (const c of ev.cards) {
      if (!/red/i.test(c.card ?? "")) continue;
      if ((c.home_fault ?? "").length > 0) hr++;
      if ((c.away_fault ?? "").length > 0) ar++;
    }
    out.homeRedCards = hr;
    out.awayRedCards = ar;
  }
  return out;
}

interface TargetMatch {
  id: string;
  utcDate: Date;
  homeScore: number | null;
  awayScore: number | null;
  homeName: string;
  awayName: string;
  leagueExt: string;
}

async function loadTargets(): Promise<TargetMatch[]> {
  const leagues = await prisma.league.findMany({
    where: { externalId: { in: ["code:UCL", "code:UEL", "code:UNL"] } },
    select: { id: true, externalId: true },
  });
  const extOf = Object.fromEntries(leagues.map((l) => [l.id, l.externalId]));
  const matches = await prisma.match.findMany({
    where: {
      leagueId: { in: leagues.map((l) => l.id) },
      status: "FINISHED",
      externalId: { startsWith: "api-football:fixture:" },
    },
    select: {
      id: true,
      utcDate: true,
      leagueId: true,
      homeScore: true,
      awayScore: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      liveData: { select: Object.fromEntries(TARGET_FIELDS.map((f) => [f, true])) },
    },
  });
  const out: TargetMatch[] = [];
  for (const m of matches) {
    const ld = (m.liveData ?? null) as Record<string, number | null> | null;
    const missing = TARGET_FIELDS.filter((f) => !ld || ld[f] === null).length;
    if (missing === 0) continue;
    out.push({
      id: m.id,
      utcDate: m.utcDate,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      homeName: m.homeTeam?.name ?? "",
      awayName: m.awayTeam?.name ?? "",
      leagueExt: extOf[m.leagueId] ?? "?",
    });
  }
  return out;
}

function pairEventToTarget(ev: ApiEvent, targets: TargetMatch[]): TargetMatch | null {
  if ((ev.match_status ?? "").toLowerCase() !== "finished") return null;
  const hs = parseNumber(ev.match_hometeam_score);
  const as = parseNumber(ev.match_awayteam_score);
  if (hs === null || as === null) return null;
  const day = ev.match_date.slice(0, 10);
  const candidates = targets.filter(
    (t) => t.homeScore === hs && t.awayScore === as && t.utcDate.toISOString().slice(0, 10) === day,
  );
  if (candidates.length === 0) return null;
  const scored = candidates.map((t) => {
    const homeOk = namesSimilar(t.homeName, ev.match_hometeam_name ?? "");
    const awayOk = namesSimilar(t.awayName, ev.match_awayteam_name ?? "");
    return { t, score: (homeOk ? 1 : 0) + (awayOk ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0) return null;
  if (scored.length > 1 && scored[1].score === best.score) return null;
  return best.t;
}

async function fetchEvents(apiKey: string, leagueId: string, from: string, to: string): Promise<ApiEvent[] | null> {
  const cacheKey = `apifb:${leagueId}_${from}_${to}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as ApiEvent[];
  if (OFFLINE) return null; // mode sans réseau : jamais d'appel
  const qs = new URLSearchParams({
    action: "get_events",
    from,
    to,
    league_id: leagueId,
    APIkey: apiKey,
  }).toString();
  const res = await fetch(`${BASE_URL}?${qs}`);
  const body = (await res.json().catch(() => null)) as ApiEvent[] | { error?: string; message?: string } | null;
  if (!res.ok || !Array.isArray(body)) {
    console.log(`   ⚠ réponse ${res.status} — ${JSON.stringify(body ?? "").slice(0, 80)}`);
    return null;
  }
  writeCache(cacheKey, body.map(reduceEvent));
  await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  return body;
}

async function main() {
  const check = process.argv.includes("--check");
  OFFLINE = process.argv.includes("--offline");
  const apiKey = (process.env.APIFOOTBALL_KEY ?? "").trim();
  if (!apiKey && !OFFLINE) {
    console.error("APIFOOTBALL_KEY absente de .env.");
    process.exit(1);
  }
  loadCache();
  console.log(`Cache disque : ${cache.size} entrée(s) déjà acquises (stats-cache/uefa-stats.ndjson)`);
  const targets = await loadTargets();
  console.log(`Matchs UEFA encore à enrichir : ${targets.length}`);
  if (check) {
    for (const l of LEAGUE_PLAN) {
      const n = targets.filter((t) => t.leagueExt === l.code).length;
      console.log(`  ${l.code} (${l.apiLeagueId}) : ${n} match(s) · ${RANGES.length} plages à interroger (cache disque)`);
    }
    console.log("(--check : aucun appel effectué)");
    await prisma.$disconnect();
    return;
  }

  let enriched = 0;
  let paired = 0;
  let calls = 0;
  for (const l of LEAGUE_PLAN) {
    const leagueTargets = targets.filter((t) => t.leagueExt === l.code);
    if (leagueTargets.length === 0) continue;
    const pending = new Map<string, TargetMatch>(leagueTargets.map((t) => [t.id, t]));
    for (const [from, to] of RANGES) {
      if (pending.size === 0) break;
      const events = await fetchEvents(apiKey, l.apiLeagueId, from, to);
      calls++;
      if (!events) continue;
      for (const ev of events) {
        const target = pairEventToTarget(ev, [...pending.values()]);
        if (!target) continue;
        paired++;
        const mapped = mapStats(ev);
        const fields = Object.entries(mapped).filter(([, v]) => v !== null && v !== undefined) as Array<[string, number]>;
        if (fields.length === 0) continue;
        const existing = await prisma.matchLiveData.findUnique({ where: { matchId: target.id } });
        if (!existing) {
          await prisma.matchLiveData.create({ data: { matchId: target.id, ...Object.fromEntries(fields) } });
          enriched++;
        } else {
          const updates: Record<string, number> = {};
          for (const [k, v] of fields) {
            if ((existing as unknown as Record<string, number | null>)[k] === null) updates[k] = v;
          }
          if (Object.keys(updates).length > 0) {
            await prisma.matchLiveData.update({ where: { matchId: target.id }, data: updates });
            enriched++;
          }
        }
        pending.delete(target.id);
      }
      console.log(`  ${l.code} ${from}→${to} · events ${events.length} · restants ${pending.size} · appels ${calls}`);
    }
    console.log(`${l.code} terminé · appariés ${paired} · enrichis ${enriched}`);
  }
  console.log("\n── résumé ──");
  console.log(`appels API : ${calls} (réponses réduites dans stats-cache/uefa-stats.ndjson)`);
  console.log(`matchs appariés : ${paired} · enrichis : ${enriched}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERREUR:", e?.message ?? e);
  process.exit(1);
});
