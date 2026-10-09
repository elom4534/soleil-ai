/**
 * ============================================================================
 * SOLEIL — Orchestration des données premium (Live Football API)
 * ============================================================================
 * Mission 21 : données complètes, fraîches et sourcées pour le moteur.
 *
 *   · `syncLfaLeague`        — saison complète d'une ligue (résultats + à venir)
 *   · `enrichRecentStats`    — stats détaillées des matchs récents (MatchLiveData)
 *   · `syncTeamLogos`        — logos officiels + identifiants fournisseurs
 *   · `refreshUpcomingContext` — H2H, blessures, compositions des matchs à venir
 *
 * TOUT passe par `ingestFixtures` (upsert, anti-doublons) — aucune écriture
 * directe de matchs. Le moteur de prédiction n'est jamais modifié : il reçoit
 * simplement plus de données récentes via `buildMatchContext`.
 *
 * Fraîcheur : `MatchLiveData.updatedAt` + le cache de contexte horodaté
 * (`stats-cache/lfa-context.ndjson`) permettent de mesurer l'âge de chaque
 * donnée ; `dataSources` de chaque match conserve la trace du fournisseur.
 */

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { ingestFixtures } from "./ingest";
import { resolveTeamId } from "./teams";
import type { NormalizedFixture } from "./providers/types";
import {
  lfaLeagueFixtures,
  lfaDayMatches,
  lfaMatchStats,
  lfaH2h,
  lfaInjuries,
  lfaLineups,
  lfaCreditsSpent,
  lfaBudgetExhausted,
  lfaStatusToInternal,
  num,
  type LfaMatch,
  type LfaStatLine,
} from "./providers/liveFootballApiV1";

// ---------------------------------------------------------------------------
// Cartographie : code de compétition SOLEIL → identifiant ligue LFA
// (identifiants réellement découverts via GET /leagues — jamais supposés).
// ---------------------------------------------------------------------------
export const LFA_LEAGUES: Record<string, string> = {
  UNL: "595nsvo7ykvoe690b1e4u5n56", // UEFA Nations League
  CCNL: "cu0rmpyff5692eo06ltddjo8a", // CONCACAF Nations League
  E0: "2kwbbcootiqqgmrzs6o5inle5", // Premier League
  SP1: "34pl8szyvrbwcmfkuocjm3r6t", // LaLiga
  I1: "1r097lpxe0xn03ihb7wi98kao", // Serie A
  D1: "6by3h89i2eykc341oz7lv1ddd", // Bundesliga
  F1: "dm5ka0os1e3dxcp3vh05kmp33", // Ligue 1
  UCL: "4oogyu6o156iphvdvphwpck10", // UEFA Champions League
  UEL: "4c1nfi2j1m731hcay25fcgndq", // UEFA Europa League
  ECL: "c7b8o53flg36wbuevfzy3lb10", // UEFA Conference League
  // Ajoutées le 2026-10-09 — identifiants lus dans le catalogue /leagues et
  // confirmés par les équipes des rencontres du jour (voir rapport).
  N1: "akmkihra9ruad09ljapsm84b3", // Eredivisie (Pays-Bas) — PSV–Heerenveen
  P1: "8yi6ejjd1zudcqtbn07haahg6", // Primeira Liga (Portugal) — Braga–Sporting, Moreirense–Gil Vicente
  BRA1: "scf9p4y91yjvqvg5jndxzhxj", // Série A (Brésil) — Flamengo, Palmeiras, Santos
  RU1: "3ab1uwtoyjopdj1y1fynyy9jg", // Premier League (Russie) — Rostov–Akron
};

/**
 * Code interne d'une compétition LFA, ou `null` si elle n'est pas cartographiée.
 * `null` doit faire ignorer la rencontre : jamais de compétition créée à partir
 * d'un identifiant brut.
 */
export function lfaInternalCode(lfaLeagueId: string): string | null {
  const entry = Object.entries(LFA_LEAGUES).find(([, v]) => v === lfaLeagueId);
  return entry ? entry[0] : null;
}

const CONTEXT_CACHE = path.join(process.cwd(), "stats-cache", "lfa-context.ndjson");

export interface SyncSummary {
  league: string;
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

function lfaLeagueToInternalCode(lfaLeagueId: string, fallback: string): string {
  const entry = Object.entries(LFA_LEAGUES).find(([, v]) => v === lfaLeagueId);
  return entry ? entry[0] : fallback;
}

function toNormalized(m: LfaMatch, providerId: string): NormalizedFixture | null {
  const status = lfaStatusToInternal(m.status);
  const dateRaw = m.date ?? (m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null);
  if (!dateRaw) return null;
  let utcDate = new Date(dateRaw);
  if (Number.isNaN(utcDate.getTime())) return null;
  // `kickoff` (HH:MM) complète les dates fournies sans heure.
  if (m.kickoff && !String(dateRaw).includes(":")) {
    const [h, mi] = m.kickoff.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(mi)) {
      utcDate = new Date(utcDate);
      utcDate.setUTCHours(h, mi, 0, 0);
    }
  }
  return {
    externalId: m.id,
    sourceRef: `${providerId}:${m.id}`,
    competition: {
      code: lfaLeagueToInternalCode(m.league.id, m.league.id),
      name: m.league.name,
      country: m.league.country ?? "",
    },
    utcDate,
    status,
    homeTeamName: m.home.name,
    awayTeamName: m.away.name,
    homeScore: status === "finished" ? num(m.home.score) : null,
    awayScore: status === "finished" ? num(m.away.score) : null,
    halfTimeHomeScore: num(m.halftime?.home),
    halfTimeAwayScore: num(m.halftime?.away),
    // Les stats détaillées ne sont PAS dans /league_fixtures : elles arrivent
    // par `enrichRecentStats` (live_match_details). Jamais d'estimation.
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
    homeRedCards: null,
    awayRedCards: null,
    venue: null,
    referee: null,
  };
}

/** Saison LFA attendue (format 2026/2027) pour la date du jour. */
export function lfaSeasonLabel(now = new Date()): string {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

/** Synchronise toute la saison d'une ligue premium (résultats récents + à venir). */
export async function syncLfaLeague(competitionCode: string, now = new Date()): Promise<SyncSummary> {
  const lfaId = LFA_LEAGUES[competitionCode];
  const summary: SyncSummary = { league: competitionCode, received: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  if (!lfaId) {
    summary.errors.push(`Compétition ${competitionCode} sans identifiant LFA connu.`);
    return summary;
  }
  const season = lfaSeasonLabel(now);
  const matches = await lfaLeagueFixtures(lfaId, season);
  summary.received = matches.length;
  const fixtures: NormalizedFixture[] = [];
  for (const m of matches) {
    const n = toNormalized(m, "lfa");
    if (n) fixtures.push(n);
  }
  if (fixtures.length === 0) return summary;
  const stats = await ingestFixtures({ provider: "lfa", competitionCode, season, fixtures });
  summary.inserted = stats.inserted;
  summary.updated = stats.updated;
  summary.skipped = stats.skipped;
  summary.errors = stats.errors;
  return summary;
}

// ---------------------------------------------------------------------------
// Stats détaillées (xG, tirs, corners, possession…) des matchs récents
// ---------------------------------------------------------------------------

/**
 * Retrouve une paire domicile/extérieur dans les lignes de statistiques.
 *
 * Appariement **exact d'abord**, sous-chaîne ensuite : sans cette priorité,
 * « shots » capturait aussi « Shots on Target » et « Blocked Shots », et
 * « red card » capturait « Direct Red Card » — au gré de l'ordre renvoyé par le
 * fournisseur. `exclude` écarte les libellés voisins qui contiennent le motif
 * sans le désigner (ex. « xG from Set Pieces » ne doit jamais être pris pour
 * le xG total du match) : à défaut de donnée sûre, on renvoie `null`.
 */
export function parsePair(
  stats: LfaStatLine[],
  labels: string[],
  exclude: string[] = [],
): [number | null, number | null] {
  const wanted = labels.map((l) => l.toLowerCase().trim());
  const rejected = exclude.map((l) => l.toLowerCase().trim());
  const usable = stats.filter((s) => {
    const l = s.label.toLowerCase().trim();
    return !rejected.some((bad) => l.includes(bad));
  });
  for (const s of usable) {
    if (wanted.includes(s.label.toLowerCase().trim())) return [num(s.home), num(s.away)];
  }
  for (const s of usable) {
    const l = s.label.toLowerCase().trim();
    if (wanted.some((want) => l.includes(want))) return [num(s.home), num(s.away)];
  }
  return [null, null];
}

export interface EnrichSummary {
  candidates: number;
  enriched: number;
  /** Matchs pour lesquels le fournisseur a publié un xG exploitable. */
  withXg: number;
  /** Matchs dont l'arbitre ou le lieu a été complété (champ vide au départ). */
  withIdentity: number;
  errors: string[];
  creditsSpent: number;
}

/**
 * Marqueur d'idempotence : ce match a déjà été interrogé via
 * `/live_match_details`. Sans lui, un match dont le fournisseur ne publie pas
 * de xG serait racheté chaque jour, indéfiniment.
 */
const XG_CHECKED = "lfa:xg-checked";

/**
 * Enrichit les matchs TERMINÉS récents : statistiques détaillées, **xG**,
 * cartons rouges, arbitre et lieu.
 *
 * Sont éligibles les matchs sans `MatchLiveData` **et** ceux dont les
 * statistiques existent mais sans xG : cette seconde population a déjà été
 * achetée une fois, à l'époque où le xG renvoyé par le fournisseur était jeté
 * (272 matchs concernés en production au 2026-10-09).
 *
 * Le marqueur `lfa:xg-checked` rend l'opération idempotente — un match sans xG
 * publié n'est jamais racheté. Aucune valeur `null` n'écrase une donnée déjà en
 * base, et arbitre/lieu ne sont posés que si le champ est vide : jamais
 * d'écrasement d'une autre source, jamais d'invention.
 */
export async function enrichRecentStats(days = 45, limit = 120): Promise<EnrichSummary> {
  const since = new Date(Date.now() - days * 86_400_000);
  const candidates = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { gte: since },
      dataSources: { has: "lfa" },
      NOT: { dataSources: { has: XG_CHECKED } },
      OR: [{ liveData: null }, { liveData: { is: { homeXg: null } } }],
      // `toNormalized` pose `externalId = m.id` SANS préfixe : un identifiant
      // contenant « : » vient d'un autre fournisseur (apifootball:event:…,
      // the-sports-db:…) et n'a aucune signification pour /live_match_details.
      // 84 matchs des 90 derniers jours sont dans ce cas — ils portent la source
      // `lfa` parce qu'une ingestion ultérieure l'a ajoutée à `dataSources`
      // (union, `ingest.ts:270`) sans pouvoir changer l'`externalId` unique.
      // `Match` n'a pas de `providerRefs` : les résoudre exigerait une migration.
      externalId: { not: { contains: ":" } },
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    select: { id: true, externalId: true, homeTeamId: true, awayTeamId: true },
  });
  const summary: EnrichSummary = {
    candidates: candidates.length,
    enriched: 0,
    withXg: 0,
    withIdentity: 0,
    errors: [],
    creditsSpent: 0,
  };
  for (const m of candidates) {
    // `externalId` du match = identifiant LFA (posé à l'ingestion, sans préfixe).
    if (m.externalId.includes(":")) continue;
    const details = await lfaMatchStats(m.externalId);
    if (!details) {
      summary.errors.push(`${m.externalId} : aucun détail renvoyé`);
      // Plafond quotidien atteint : inutile de parcourir les candidats restants,
      // chaque appel serait refusé. On reprendra demain.
      if (lfaBudgetExhausted()) break;
      continue;
    }
    const [homeShots, awayShots] = parsePair(
      details.stats,
      ["total shots", "shots"],
      ["on target", "off target", "blocked", "woodwork"],
    );
    const [homeSot, awaySot] = parsePair(details.stats, ["shots on target"]);
    const [homeCorners, awayCorners] = parsePair(details.stats, ["corners"]);
    const [homeYellow, awayYellow] = parsePair(details.stats, ["yellow cards", "yellow"], ["second"]);
    const [homePoss, awayPoss] = parsePair(details.stats, ["possession"]);
    const [homeRed, awayRed] = parsePair(details.stats, ["red cards", "red card"], ["second yellow", "direct"]);
    // xG total du match. « xG from Set Pieces » et toute variante partielle sont
    // explicitement écartées : mieux vaut `null` qu'une fraction prise pour le tout.
    const [homeXg, awayXg] = parsePair(details.stats, ["expected goals (xg)", "expected goals"], [
      "set piece",
      "half",
      "penalt",
    ]);

    const livePatch = {
      ...(homeShots !== null ? { homeShots } : {}),
      ...(awayShots !== null ? { awayShots } : {}),
      ...(homeSot !== null ? { homeShotsOnTarget: homeSot } : {}),
      ...(awaySot !== null ? { awayShotsOnTarget: awaySot } : {}),
      ...(homeCorners !== null ? { homeCorners } : {}),
      ...(awayCorners !== null ? { awayCorners } : {}),
      ...(homeYellow !== null ? { homeYellowCards: homeYellow } : {}),
      ...(awayYellow !== null ? { awayYellowCards: awayYellow } : {}),
      ...(homeRed !== null ? { homeRedCards: homeRed } : {}),
      ...(awayRed !== null ? { awayRedCards: awayRed } : {}),
      ...(homePoss !== null ? { homePossession: homePoss } : {}),
      ...(awayPoss !== null ? { awayPossession: awayPoss } : {}),
      ...(homeXg !== null ? { homeXg } : {}),
      ...(awayXg !== null ? { awayXg } : {}),
    };
    if (Object.keys(livePatch).length > 0) {
      await prisma.matchLiveData.upsert({
        where: { matchId: m.id },
        create: { matchId: m.id, ...livePatch },
        update: livePatch,
      });
      summary.enriched += 1;
      if (homeXg !== null && awayXg !== null) summary.withXg += 1;
    }

    // Arbitre + lieu : remplissage des champs VIDES uniquement, puis marquage.
    const row = await prisma.match.findUnique({
      where: { id: m.id },
      select: { dataSources: true, referee: true, venue: true },
    });
    const sources: string[] = Array.isArray(row?.dataSources) ? (row!.dataSources as string[]) : [];
    const matchPatch: { referee?: string; venue?: string; dataSources?: string[] } = {};
    if (details.referee && !row?.referee) matchPatch.referee = details.referee;
    if (details.venue && !row?.venue) matchPatch.venue = details.venue;
    if (matchPatch.referee || matchPatch.venue) summary.withIdentity += 1;
    const nextSources = new Set(sources);
    if (details.referee || details.venue) nextSources.add("lfa:details");
    nextSources.add(XG_CHECKED);
    if (nextSources.size !== sources.length) matchPatch.dataSources = [...nextSources];
    if (Object.keys(matchPatch).length > 0) {
      await prisma.match.update({ where: { id: m.id }, data: matchPatch });
    }

    // Pause légère : respect du débit du fournisseur.
    await new Promise((r) => setTimeout(r, 120));
  }
  summary.creditsSpent = lfaCreditsSpent();
  return summary;
}

// ---------------------------------------------------------------------------
// Logos + identité fournisseur
// ---------------------------------------------------------------------------

export interface LogoSummary {
  scanned: number;
  updated: number;
  missing: number;
}

/**
 * Associe à chaque équipe son logo officiel et son identifiant LFA
 * (`providerRefs.lfa`) — jamais de logo fictif, jamais de création d'équipe
 * en double : la résolution passe par `resolveTeamId` (alias + similarité).
 */
export async function syncTeamLogos(limit = 200): Promise<LogoSummary> {
  const teams = await prisma.team.findMany({
    where: { crest: null },
    take: limit,
    select: { id: true, name: true },
  });
  const summary: LogoSummary = { scanned: teams.length, updated: 0, missing: 0 };
  for (const t of teams) {
    const hit = await (await import("./providers/liveFootballApiV1")).lfaTeamSearch(t.name);
    const exact = (hit?.teams ?? []).find((x) => x.name.toLowerCase() === t.name.toLowerCase())
      ?? (hit?.teams ?? [])[0];
    if (exact?.logo) {
      await prisma.team.update({
        where: { id: t.id },
        data: {
          crest: exact.logo,
          providerRefs: { lfa: exact.id },
          lastDataUpdate: new Date(),
        },
      });
      summary.updated += 1;
    } else {
      summary.missing += 1;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Contexte des matchs à venir (H2H, blessures, compositions)
// ---------------------------------------------------------------------------

export interface UpcomingContextSummary {
  matches: number;
  withH2h: number;
  withInjuries: number;
  creditsSpent: number;
}

function appendContextCache(line: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(CONTEXT_CACHE), { recursive: true });
    fs.appendFileSync(CONTEXT_CACHE, JSON.stringify(line) + "\n");
  } catch {
    // Cache best-effort : jamais bloquant pour l'import.
  }
}

/**
 * Récupère le contexte actuel des prochains matchs importants et le dépose
 * dans le cache horodaté (`stats-cache/lfa-context.ndjson`) consommé par
 * l'agent IA. Le moteur, lui, n'utilise que les matchs joués — son contexte
 * est enrichi indirectement par les matchs récents importés ci-dessus.
 */
export async function refreshUpcomingContext(days = 5, limit = 24): Promise<UpcomingContextSummary> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);
  const matches = await prisma.match.findMany({
    where: {
      status: "SCHEDULED",
      utcDate: { gte: now, lte: until },
      dataSources: { has: "lfa" },
      // Même garde qu'`enrichRecentStats` : un `externalId` préfixé vient d'un
      // autre fournisseur et ferait échouer les 3 appels payants par match.
      externalId: { not: { contains: ":" } },
    },
    orderBy: { utcDate: "asc" },
    take: limit,
    select: {
      id: true,
      externalId: true,
      utcDate: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true, externalId: true } },
    },
  });
  const summary: UpcomingContextSummary = { matches: matches.length, withH2h: 0, withInjuries: 0, creditsSpent: 0 };
  for (const m of matches) {
    const lfaId = m.externalId;
    const [h2h, injuries, lineups] = await Promise.all([lfaH2h(lfaId), lfaInjuries(lfaId), lfaLineups(lfaId)]);
    if (h2h) summary.withH2h += 1;
    if (injuries) summary.withInjuries += 1;
    appendContextCache({
      matchId: m.id,
      lfaId,
      at: new Date().toISOString(),
      match: `${String((m.homeTeam as { name?: string })?.name ?? "")} – ${String((m.awayTeam as { name?: string })?.name ?? "")}`,
      league: String((m.league as { name?: string })?.name ?? ""),
      kickoff: m.utcDate.toISOString(),
      h2h,
      injuries,
      lineups,
    });
    await new Promise((r) => setTimeout(r, 150));
  }
  summary.creditsSpent = lfaCreditsSpent();
  return summary;
}

/** Découverte des matchs des jours à venir (fraîcheur du calendrier). */
export async function discoverUpcoming(days = 7): Promise<SyncSummary[]> {
  const out: SyncSummary[] = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    const matches = await lfaDayMatches(d);
    const byLeague = new Map<string, LfaMatch[]>();
    for (const m of matches) {
      const arr = byLeague.get(m.league.id) ?? [];
      arr.push(m);
      byLeague.set(m.league.id, arr);
    }
    for (const [lfaLeagueId, list] of byLeague) {
      // Garde-fou : seules les compétitions cartographiées entrent en base.
      // Sans ce filtre, toutes les ligues du monde seraient créées avec leur
      // identifiant brut comme code (163 ligues et 412 matchs le 2026-10-09).
      const code = lfaInternalCode(lfaLeagueId);
      if (!code) continue;
      const fixtures = list.map((m) => toNormalized(m, "lfa")).filter((x): x is NormalizedFixture => x !== null);
      if (fixtures.length === 0) continue;
      const stats = await ingestFixtures({ provider: "lfa", competitionCode: code, season: lfaSeasonLabel(), fixtures });
      out.push({ league: code, received: fixtures.length, inserted: stats.inserted, updated: stats.updated, skipped: stats.skipped, errors: stats.errors });
    }
  }
  return out;
}

export { resolveTeamId };
