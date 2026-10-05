/**
 * enrich-uefa-stats.ts — Enrichissement des statistiques des matchs UEFA
 * (UCL / UEL / UNL) déjà présents en base, via LiveFootballApi
 * (live-football-api.com), à partir des crédits déjà disponibles.
 *
 * Principes (contraintes de mission) :
 *   · ADDITIF : n'écrit que des champs NULL — jamais d'écrasement d'une
 *     donnée existante ;
 *   · IDEMPOTENT : une seconde exécution ignore les dates déjà complètes ;
 *   · NON DESTRUCTIF : aucune suppression, aucun DELETE/TRUNCATE/RESET,
 *     aucune écriture sur les Match ni sur les prédictions ;
 *   · BUDGÉTÉ : s'arrête automatiquement avant de dépasser --budget
 *     (crédits d'API), et suit le `credits_remaining` réel de chaque clé ;
 *   · MULTI-CLÉS : rotation sur `API_FOOTBALL_LIVE_KEYS` (solde épuisé →
 *     clé suivante) ;
 *   · aucune prédiction créée, aucun moteur modifié.
 *
 * Coûts LiveFootballApi : 1 crédit par appel (GET /matches par date,
 * GET /live_match_details par match). Les statistiques renvoyées couvrent
 * tirs, tirs cadrés, corners, cartons, possession et xG.
 *
 * Usage :
 *   node_modules/.bin/tsx scripts/enrich-uefa-stats.ts --check            # plan seul, 0 appel
 *   node_modules/.bin/tsx scripts/enrich-uefa-stats.ts --budget=200       # plafond de crédits
 *   node_modules/.bin/tsx scripts/enrich-uefa-stats.ts                    # budget par défaut
 */

import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "../src/lib/prisma";

const BASE_URL = "https://live-football-api.com/api/v1";
const REQUEST_DELAY_MS = 450;
const CACHE_FILE = path.join(process.cwd(), "stats-cache", "uefa-stats.ndjson");

// ---------------------------------------------------------------------------
// Cache NDJSON unique et compact, partagé avec enrich-uefa-stats-apifootball :
// chaque réponse API déjà payée est conservée sous forme réduite et n'est
// jamais re-demandée, même après un recyclage de l'environnement.
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

/** Champs de MatchLiveData alimentés par les statistiques LiveFootballApi. */
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
  "homeXg",
  "awayXg",
] as const;

interface Args {
  check: boolean;
  budget: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    check: argv.includes("--check"),
    budget: (() => {
      const m = argv.find((a) => a.startsWith("--budget="));
      return m ? Number(m.split("=")[1]) : null;
    })(),
  };
}

function loadKeys(): string[] {
  const raw = process.env.API_FOOTBALL_LIVE_KEYS ?? "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const common = significant.filter((w) => wb.includes(w));
  if (common.length > 0) return true;
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

function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Mappe le tableau `stats` de live_match_details vers les colonnes stockées. */
function mapStats(stats: Array<{ label: string; home: string; away: string }>) {
  const out: Record<string, number | null> = {};
  const find = (re: RegExp) => stats.find((s) => re.test(s.label.trim()));
  const shots = find(/^total shots$/i) ?? find(/^shots$/i);
  if (shots) {
    out.homeShots = parseNumber(shots.home);
    out.awayShots = parseNumber(shots.away);
  }
  const sot = find(/^shots on (goal|target)$/i);
  if (sot) {
    out.homeShotsOnTarget = parseNumber(sot.home);
    out.awayShotsOnTarget = parseNumber(sot.away);
  }
  const corners = find(/^corners$/i);
  if (corners) {
    out.homeCorners = parseNumber(corners.home);
    out.awayCorners = parseNumber(corners.away);
  }
  const yellow = find(/^yellow cards$/i);
  if (yellow) {
    out.homeYellowCards = parseNumber(yellow.home);
    out.awayYellowCards = parseNumber(yellow.away);
  }
  const red = find(/^red cards$/i);
  if (red) {
    out.homeRedCards = parseNumber(red.home);
    out.awayRedCards = parseNumber(red.away);
  } else {
    const direct = find(/^direct red card$/i);
    const second = find(/^second yellow card$/i);
    if (direct || second) {
      out.homeRedCards = (parseNumber(direct?.home) ?? 0) + (parseNumber(second?.home) ?? 0);
      out.awayRedCards = (parseNumber(direct?.away) ?? 0) + (parseNumber(second?.away) ?? 0);
    }
  }
  const poss = find(/^possession$/i);
  if (poss) {
    out.homePossession = parseNumber(poss.home);
    out.awayPossession = parseNumber(poss.away);
  }
  const xg = find(/expected goals/i);
  if (xg) {
    out.homeXg = parseNumber(xg.home);
    out.awayXg = parseNumber(xg.away);
  }
  return out;
}

interface KeyState {
  key: string;
  remaining: number | null;
}

class KeyPool {
  private states: KeyState[];
  private index = 0;

  constructor(keys: string[]) {
    this.states = keys.map((key) => ({ key, remaining: null }));
  }

  /** Clé utilisable (solde inconnu ou ≥ min). */
  current(): KeyState | null {
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[(this.index + i) % this.states.length];
      if (s.remaining === null || s.remaining >= 1) {
        this.index = (this.index + i) % this.states.length;
        return s;
      }
    }
    return null;
  }

  noteBalance(creditsRemaining: unknown) {
    const n = parseNumber(creditsRemaining);
    if (n !== null) this.states[this.index].remaining = n;
  }

  spend(count = 1) {
    const s = this.states[this.index];
    if (s.remaining !== null) s.remaining = Math.max(0, s.remaining - count);
  }

  /** Marque la clé courante comme épuisée (bascule automatique ensuite). */
  exhaustCurrent() {
    this.states[this.index].remaining = 0;
  }

  totals() {
    return this.states.map((s) => s.remaining).map((v) => (v === null ? "?" : String(v))).join(" · ");
  }

  /** Solde total estimé (∞ tant qu'une clé n'a pas annoncé son solde). */
  estimatedTotal(): number {
    return this.states.reduce((a, s) => a + (s.remaining ?? Number.POSITIVE_INFINITY), 0);
  }

  /** Une combinaison de clés peut-elle payer `cost` crédits ? */
  canAfford(cost: number): boolean {
    return this.estimatedTotal() >= cost;
  }
}

async function apiGet<T>(
  pool: KeyPool,
  endpoint: string,
  params: Record<string, string>,
  cacheKey?: string,
  reduce?: (body: T) => unknown,
): Promise<T | null> {
  // Cache disque : les réponses déjà payées ne sont jamais re-demandées.
  if (cacheKey && cache.has(cacheKey)) {
    return cache.get(cacheKey) as T;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = pool.current();
    if (!state) throw new Error("Aucune clé avec solde disponible.");
    const qs = new URLSearchParams({ api_key: state.key, lang: "en", ...params }).toString();
    const res = await fetch(`${BASE_URL}${endpoint}?${qs}`);
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") ?? 5);
      console.log(`   ⏳ 429 rate-limit — pause ${wait}s`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    const body = (await res.json().catch(() => null)) as (T & { success?: boolean; message?: string; credits_remaining?: number }) | null;
    pool.noteBalance(body?.credits_remaining);
    if (!res.ok || !body || body.success === false) {
      const msg = String(body?.message ?? "");
      if (res.status === 403 || /insufficient|access denied/i.test(msg)) {
        pool.exhaustCurrent();
        console.log(`   ⚠ clé épuisée (${res.status}) — bascule sur la clé suivante`);
        continue;
      }
      console.log(`   ⚠ réponse ${res.status} — ${msg.slice(0, 80)}`);
      return null;
    }
    pool.spend(1);
    if (cacheKey) writeCache(cacheKey, reduce ? reduce(body) : body);
    await sleep(REQUEST_DELAY_MS);
    return body;
  }
  return null;
}

interface LfaMatch {
  id: string;
  league?: { name?: string };
  status?: { state?: string };
  home?: { name?: string; score?: string };
  away?: { name?: string; score?: string };
}

interface TargetMatch {
  id: string;
  utcDate: Date;
  homeScore: number | null;
  awayScore: number | null;
  homeName: string;
  awayName: string;
  missing: number;
  leagueExt: string;
  seasonYear: string;
}

const LEAGUE_PRIORITY: Record<string, number> = { "code:UCL": 0, "code:UEL": 1, "code:UNL": 2 };

async function loadTargets(): Promise<{ byDate: Map<string, TargetMatch[]>; order: string[] }> {
  const leagues = await prisma.league.findMany({
    where: { externalId: { in: ["code:UCL", "code:UEL", "code:UNL"] } },
    select: { id: true, externalId: true },
  });
  const extOf = Object.fromEntries(leagues.map((l) => [l.id, l.externalId]));
  const leagueIds = leagues.map((l) => l.id);
  const matches = await prisma.match.findMany({
    where: {
      leagueId: { in: leagueIds },
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
      season: { select: { year: true } },
      liveData: { select: Object.fromEntries(TARGET_FIELDS.map((f) => [f, true])) },
    },
  });
  const byDate = new Map<string, TargetMatch[]>();
  const all: TargetMatch[] = [];
  for (const m of matches) {
    const ld = (m.liveData ?? null) as Record<string, number | null> | null;
    const missing = TARGET_FIELDS.filter((f) => !ld || ld[f] === null).length;
    if (missing === 0) continue; // déjà complet → idempotence
    const day = m.utcDate.toISOString().slice(0, 10);
    const item: TargetMatch = {
      id: m.id,
      utcDate: m.utcDate,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      homeName: m.homeTeam?.name ?? "",
      awayName: m.awayTeam?.name ?? "",
      missing,
      leagueExt: extOf[m.leagueId] ?? "?",
      seasonYear: m.season?.year ?? "?",
    };
    const list = byDate.get(day) ?? [];
    list.push(item);
    byDate.set(day, list);
    all.push(item);
  }
  // Priorité moteur : saison la plus récente d'abord, puis UCL → UEL → UNL,
  // puis dates décroissantes (les matchs récents peuplent la fenêtre glissante).
  all.sort((a, b) => {
    const sy = b.seasonYear.localeCompare(a.seasonYear);
    if (sy !== 0) return sy;
    const lp = (LEAGUE_PRIORITY[a.leagueExt] ?? 9) - (LEAGUE_PRIORITY[b.leagueExt] ?? 9);
    if (lp !== 0) return lp;
    return b.utcDate.getTime() - a.utcDate.getTime();
  });
  const order: string[] = [];
  const seen = new Set<string>();
  for (const t of all) {
    const day = t.utcDate.toISOString().slice(0, 10);
    if (!seen.has(day)) {
      seen.add(day);
      order.push(day);
    }
  }
  return { byDate, order };
}

function pairLfaToTarget(lfa: LfaMatch, targets: TargetMatch[]): TargetMatch | null {
  const hs = parseNumber(lfa.home?.score);
  const as = parseNumber(lfa.away?.score);
  if (hs === null || as === null) return null;
  const candidates = targets.filter((t) => t.homeScore === hs && t.awayScore === as);
  if (candidates.length === 0) return null;
  const scored = candidates.map((t) => {
    const homeOk = namesSimilar(t.homeName, lfa.home?.name ?? "");
    const awayOk = namesSimilar(t.awayName, lfa.away?.name ?? "");
    return { t, score: (homeOk ? 1 : 0) + (awayOk ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0) return null;
  if (scored.length > 1 && scored[1].score === best.score) return null; // ambigu → skip
  return best.t;
}

async function main() {
  const args = parseArgs();
  const keys = loadKeys();
  if (keys.length === 0) {
    console.error("Aucune clé dans API_FOOTBALL_LIVE_KEYS (.env).");
    process.exit(1);
  }
  const pool = new KeyPool(keys);
  loadCache();
  console.log(`Clés disponibles : ${keys.length} · budget : ${args.budget ?? "défaut (solde réel des clés)"} · cache : ${cache.size} entrée(s)`);
  if (args.budget) console.log(`Plafond de la session : ${args.budget} crédits`);

  const { byDate: targetsByDate, order } = await loadTargets();
  const days = order;
  console.log(`Dates avec matchs UEFA à enrichir : ${days.length} · matchs : ${[...targetsByDate.values()].flat().length}`);

  if (args.check) {
    let prevSegment = "";
    for (const day of days) {
      const list = targetsByDate.get(day)!;
      const segment = `${list[0].seasonYear} · ${list.map((t) => t.leagueExt.replace("code:", "")).join("+")}`;
      if (segment !== prevSegment) {
        console.log(`── ${segment}`);
        prevSegment = segment;
      }
      console.log(`  ${day} · ${list.length} match(s) · coût estimé ${1 + list.length} crédits`);
    }
    console.log("(--check : aucun appel effectué)");
    await prisma.$disconnect();
    return;
  }

  let spentThisSession = 0;
  const budget = args.budget ?? Number.POSITIVE_INFINITY;
  const sessionStartBalances = new Map<string, number | null>();
  for (const day of days) {
    const list = targetsByDate.get(day)!;
    const cost = 1 + list.length;
    if (spentThisSession + cost > budget) {
      console.log(`⏹ budget de session atteint (${spentThisSession}/${budget}) — arrêt propre.`);
      break;
    }
    const state = pool.current();
    if (!state) {
      console.log("⏹ solde des clés insuffisant — arrêt propre.");
      break;
    }
    if (!pool.canAfford(cost)) {
      console.log(`⏹ solde total des clés < coût de la date (${cost}) — arrêt propre.`);
      break;
    }

    const listRes = await apiGet<{ data?: { matches?: LfaMatch[] } }>(
      pool,
      "/matches",
      { date: day },
      `list:${day}`,
      (b) => ({
        data: {
          matches: (b.data?.matches ?? []).map((m) => ({
            id: m.id,
            status: m.status,
            home: m.home,
            away: m.away,
          })),
        },
      }),
    );
    spentThisSession += 1;
    if (!listRes) {
      console.log(`  ${day} · liste illisible — date ignorée`);
      continue;
    }
    const lfaMatches = (listRes.data?.matches ?? []).filter((m) => m.status?.state === "postGame");
    const pending = new Map<string, TargetMatch>(list.map((t) => [t.id, t]));
    let enriched = 0;
    let noStats = 0;
    for (const lfa of lfaMatches) {
      if (pending.size === 0) break;
      const target = pairLfaToTarget(lfa, [...pending.values()]);
      if (!target) continue;
      const det = await apiGet<{ data?: { stats?: Array<{ label: string; home: string; away: string }> } }>(
        pool,
        "/live_match_details",
        { match_id: lfa.id },
        `lfa:${lfa.id}`,
        (b) => ({ data: { stats: b.data?.stats ?? [] } }),
      );
      spentThisSession += 1;
      if (!det) continue;
      const stats = det.data?.stats ?? [];
      if (stats.length === 0) {
        noStats++;
        continue;
      }
      const mapped = mapStats(stats);
      const fields = Object.entries(mapped).filter(([, v]) => v !== null && v !== undefined) as Array<[string, number]>;
      if (fields.length === 0) {
        noStats++;
        continue;
      }
      // Additif strict : uniquement les champs encore NULL.
      const existing = await prisma.matchLiveData.findUnique({ where: { matchId: target.id } });
      if (!existing) {
        await prisma.matchLiveData.create({ data: { matchId: target.id, ...Object.fromEntries(fields) } });
      } else {
        const updates: Record<string, number> = {};
        for (const [k, v] of fields) {
          if ((existing as unknown as Record<string, number | null>)[k] === null) updates[k] = v;
        }
        if (Object.keys(updates).length > 0) {
          await prisma.matchLiveData.update({ where: { matchId: target.id }, data: updates });
        }
      }
      pending.delete(target.id);
      enriched++;
    }
    console.log(`  ${day} · appariés ${enriched}/${list.length} · sans stats ${noStats} · crédits session ${spentThisSession} · soldes ${pool.totals()}`);
    if (spentThisSession >= budget) {
      console.log(`⏹ budget de session atteint (${spentThisSession}/${budget}).`);
      break;
    }
  }

  console.log("\n── résumé ──");
  console.log(`crédits consommés (session) : ${spentThisSession}`);
  console.log(`soldes finaux (estimation) : ${pool.totals()}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERREUR:", e?.message ?? e);
  process.exit(1);
});
