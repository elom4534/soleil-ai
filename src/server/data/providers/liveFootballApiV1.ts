/**
 * ============================================================================
 * SOLEIL — Client Live Football API (premium, v1)
 * ============================================================================
 * Source PRIORITAIRE pour les données récentes et actuelles (mission 21).
 * Les sources gratuites ne servent plus que de secours / vérification.
 *
 * Endpoints (1 crédit par appel) :
 *   /matches            — matchs d'une date (ids, logos, scores, mi-temps)
 *   /league_fixtures    — saison complète d'une ligue (résultats + à venir)
 *   /live_match_details — stats détaillées d'un match (tirs, corners, possession)
 *   /h2h                — forme des deux équipes + confrontations directes
 *   /injuries           — blessures / suspensions avant le match
 *   /lineups            — compositions, formations, entraîneurs
 *   /league_standings   — classements (global, dom, ext, live) + forme
 *   /team_squad         — effectif + statistiques des joueurs
 *   /team_matches       — calendrier / résultats d'une équipe
 *
 * 🔒 Les clés (`LFA_API_KEYS`, séparées par des virgules) ne quittent jamais
 *    le serveur : jamais dans git, les logs ou les réponses.
 *
 * Économie : chaque appel est compté ; la rotation passe à la clé suivante
 * quand une clé est épuisée (403) ; un cache mémoire évite les appels en
 * double pendant la même exécution.
 */

const BASE = "https://live-football-api.com/api/v1";
const TIMEOUT_MS = 20_000;

export interface LfaMatchTeam {
  id: string;
  name: string;
  logo: string | null;
  score?: number | string | null;
}

export interface LfaMatch {
  id: string;
  league: { id: string; name: string; country?: string };
  week?: string | null;
  kickoff?: string | null;
  date?: string | null;
  timestamp?: number | null;
  status: { status?: string; display?: string; is_live?: boolean; state?: string } | string;
  home: LfaMatchTeam;
  away: LfaMatchTeam;
  halftime?: { home: number | null; away: number | null } | null;
  penalty?: { home: number | null; away: number | null } | null;
}

export interface LfaStatLine {
  label: string;
  home: string | number | null;
  away: string | number | null;
}

let keyIndex = 0;
let creditsSpent = 0;
const callCache = new Map<string, unknown>();

export function lfaKeys(): string[] {
  return (process.env.LFA_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 20);
}

export function lfaCreditsSpent(): number {
  return creditsSpent;
}

export async function lfaGet<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  const keys = lfaKeys();
  if (keys.length === 0) return null;
  const cacheKey = endpoint + ":" + JSON.stringify(params);
  if (callCache.has(cacheKey)) return callCache.get(cacheKey) as T;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(keyIndex + attempt) % keys.length];
    const url = new URL(BASE + endpoint);
    url.searchParams.set("api_key", key);
    url.searchParams.set("lang", "en");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 429) {
        // Clé épuisée / débit dépassé : on tente la suivante.
        continue;
      }
      const body = (await res.json()) as { success?: boolean; data?: T; message?: string };
      if (!res.ok || body.success === false) return null;
      creditsSpent += 1;
      keyIndex = (keyIndex + attempt) % keys.length;
      callCache.set(cacheKey, body.data ?? null);
      return (body.data ?? null) as T;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adaptateurs vers le format interne (`NormalizedFixture`)
// ---------------------------------------------------------------------------

export function lfaStatusToInternal(s: LfaMatch["status"]): "scheduled" | "finished" | "postponed" | "cancelled" | "live" {
  const raw = typeof s === "string" ? s : (s.status ?? s.state ?? "");
  const v = raw.toLowerCase();
  if (v.includes("postpon")) return "postponed";
  if (v.includes("cancel")) return "cancelled";
  if (v.includes("live") || v === "inplay" || v === "in play" || v === "paused") return "live";
  if (v.includes("finish") || v === "ft" || v === "postgame" || v === "aet" || v === "pen") return "finished";
  return "scheduled";
}

export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  if (typeof v === "string" && String(v).replace(/[^0-9.-]/g, "").length === 0) return null;
  return Number.isFinite(n) ? n : null;
}

export async function lfaLeagueFixtures(leagueId: string, season?: string): Promise<LfaMatch[]> {
  const data = await lfaGet<{ weeks?: { matches?: LfaMatch[] }[]; matches?: LfaMatch[] }>("/league_fixtures", {
    league_id: leagueId,
    ...(season ? { season } : {}),
  });
  if (!data) return [];
  if (Array.isArray(data.matches)) return data.matches;
  return (data.weeks ?? []).flatMap((w) => w.matches ?? []);
}

export async function lfaDayMatches(date: string): Promise<LfaMatch[]> {
  const data = await lfaGet<{ matches?: LfaMatch[] }>("/matches", { date });
  return data?.matches ?? [];
}

export async function lfaMatchStats(matchId: string): Promise<{ stats: LfaStatLine[]; venue: string | null; referee: string | null } | null> {
  const data = await lfaGet<{ stats?: LfaStatLine[]; venue?: { name?: string } | null; referee?: string | null }>("/live_match_details", { match_id: matchId });
  if (!data) return null;
  return {
    stats: data.stats ?? [],
    venue: data.venue?.name ?? null,
    referee: typeof data.referee === "string" ? data.referee : null,
  };
}

export async function lfaH2h(matchId: string): Promise<{ homeForm: LfaMatch[]; awayForm: LfaMatch[]; h2h: LfaMatch[]; summary: { home_wins: number; away_wins: number; draws: number } | null } | null> {
  return lfaGet("/h2h", { match_id: matchId });
}

export async function lfaInjuries(matchId: string): Promise<{ injuries: { home: unknown[]; away: unknown[] } } | null> {
  return lfaGet("/injuries", { match_id: matchId });
}

export async function lfaLineups(matchId: string): Promise<unknown> {
  return lfaGet("/lineups", { match_id: matchId });
}

export async function lfaStandings(leagueId: string, season?: string): Promise<unknown> {
  return lfaGet("/league_standings", { league_id: leagueId, ...(season ? { season } : {}) });
}

export async function lfaTeamSquad(teamId: string): Promise<unknown> {
  return lfaGet("/team_squad", { team_id: teamId });
}

export async function lfaTeamSearch(q: string): Promise<{ teams: { id: string; name: string; logo: string | null; country: string | null }[] } | null> {
  return lfaGet("/team_search", { q });
}
