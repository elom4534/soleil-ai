/**
 * ============================================================================
 * SOLEIL — Phase 16 · §11, §12, §15, §17 · Alimentation des matchs futurs
 * ============================================================================
 * Pipeline complet, dans l'ordre exigé :
 *
 *   journée(s) à venir → appel fournisseur (ou cache) → normalisation
 *   → déduplication → persistance → identités et logos → prédiction → mesure
 *
 * Trois garanties, tenues par construction :
 *
 *  • **Idempotent** (§11) : rejouer la même journée ne crée aucun doublon. La
 *    clé est l'identifiant fournisseur, conservé tel quel ; à défaut, une clé de
 *    secours bornée à ±1 jour. Deux exécutions produisent le même état.
 *  • **Rien n'est inventé** (§13) : une donnée absente reste `null`. Aucune
 *    statistique n'est estimée, aucune URL de logo n'est construite.
 *  • **Le moteur n'est jamais touché** (§1) : ce module appelle
 *    `generateAndPersist`, il ne modifie ni le moteur, ni les poids, ni les
 *    backtests.
 *
 * 🔒 Aucun crédit n'est engagé sans que le coût ait été affiché par l'appelant.
 */

import { prisma } from "@/lib/prisma";
import { CONFIDENCE_THRESHOLDS, ENGINE_VERSION, OUTCOME_SOURCE } from "@/lib/constants";
import { generateAndPersist } from "@/server/predictions/service";
import { utcDayKey, utcDayBounds } from "@/server/schedule/window";
import { teamSlug, resolveTeamId } from "./teams";
import { decideMatch, fallbackMatchKeys, isTestFixture, relaxedTeamKey } from "./identity";
import { LFA_PROVIDER_NAME, fetchFixturesForDate, type SideloadTeam } from "./providers/liveFootballApi";
import type { NormalizedFixture } from "./providers/types";

/** Clé utilisée dans `Team.providerRefs` / `League.providerRefs`. */
const LFA_PROVIDER_KEY = LFA_PROVIDER_NAME;

/* -------------------------------------------------------------------------- */
/* Rapport                                                                     */
/* -------------------------------------------------------------------------- */

export interface DayReport {
  date: string;
  received: number;
  kept: number;
  inserted: number;
  updated: number;
  skipped: number;
  teamsCreated: number;
  teamsEnriched: number;
  teamsMatched: number;
  logosCached: number;
  predictionsGenerated: number;
  predictionsPublished: number;
  predictionsWithheld: number;
  predictionsSkipped: number;
  /** Prédiction publiée déjà à jour : régénérer n'apporterait rien (§11). */
  predictionsAlreadyCurrent: number;
  creditsSpent: number;
  creditsRemaining: number | null;
  fromCache: boolean;
  errors: string[];
  /** Observations non bloquantes : rapprochements approximatifs, équipes inconnues. */
  notes: string[];
}

export interface PipelineReport {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  days: DayReport[];
  totals: Omit<DayReport, "date" | "errors" | "notes"> & { errors: number; notes: number };
  skipReasons: Record<string, number>;
}

export interface PipelineOptions {
  /** Journées à traiter, au format `YYYY-MM-DD` (UTC). */
  dates: string[];
  /** Codes internes (`E0`, `SP1`) à retenir. */
  competitionCodes: string[];
  /**
   * Autorise l'appel réseau. `false` = réutilisation du cache uniquement.
   * C'est l'interrupteur qui garantit « 0 crédit » quand il est à `false`.
   */
  allowNetwork: boolean;
  /** Générer les prédictions après ingestion. */
  predict?: boolean;
  /** Nombre maximal de rencontres prédites par journée. */
  maxPredictionsPerDay?: number;
  /** Instant de référence — injectable pour rendre les tests déterministes. */
  now?: Date;
  log?: (line: string) => void;
  /**
   * Source des journées, branchable : défaut `fetchFixturesForDate`
   * (LiveFootballApi). Une source de secours (ex. TheSportsDB) peut fournir la
   * même structure sans réseau ni crédit — voir `theSportsDbFixtures.ts`.
   */
  fetchDay?: typeof fetchFixturesForDate;
}

/* -------------------------------------------------------------------------- */
/* Enrichissement : compétitions, identités, logos                             */
/* -------------------------------------------------------------------------- */

/**
 * Charge (ou crée) la compétition correspondant à un code interne.
 *
 * La clé interne reste `code:E0` — celle de tout l'historique. L'identifiant
 * fournisseur (`lfa:…`) est conservé **à côté**, dans `providerRefs` : il sert
 * d'identité primaire pour les appels suivants (§17) sans déconnecter les
 * 8 360 rencontres déjà en base.
 *
 * Le logo est repris de la source telle quelle. Aucune URL n'est construite
 * (§15) : si la source n'en publie pas, `logo` reste nul et l'affichage
 * utilisera le repli visuel.
 */
async function ensureCompetition(input: {
  code: string;
  name: string;
  country: string;
  countryCode: string | null;
  providerId: string | null;
  logo: string | null;
  providerKey?: string;
}) {
  const countryCode = input.countryCode ?? null;
  const externalId = `code:${input.code}`;
  const existing = await prisma.league.findUnique({ where: { externalId } });

  const refs = input.providerId ? { [input.providerKey ?? LFA_PROVIDER_KEY]: input.providerId } : {};

  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.country && input.country) patch.country = input.country;
    if (!existing.countryCode && countryCode) patch.countryCode = countryCode;
    if (!existing.logo && input.logo) patch.logo = input.logo;
    if (input.providerId) {
      patch.providerRefs = { ...((existing.providerRefs as Record<string, string> | null) ?? {}), ...refs };
    }
    if (Object.keys(patch).length > 0) {
      return prisma.league.update({ where: { id: existing.id }, data: patch });
    }
    return existing;
  }

  return prisma.league.create({
    data: {
      externalId,
      name: input.name || input.code,
      country: input.country || "International",
      countryCode,
      logo: input.logo,
      providerRefs: refs,
      isActive: true,
    },
  });
}

/** Charge (ou crée) la saison d'une compétition. */
async function ensureSeason(leagueId: string, year: string, isCurrent: boolean) {
  return prisma.season.upsert({
    where: { leagueId_year: { leagueId, year } },
    create: { leagueId, year, isCurrent },
    update: isCurrent ? { isCurrent: true } : {},
  });
}

export interface IdentityStats {
  teamsCreated: number;
  teamsEnriched: number;
  /** Équipes reconnues dans l'historique existant (aucune ligne créée). */
  teamsMatched: number;
  /** Noms fournisseur n'ayant pu être rapprochés : signalés, jamais fusionnés de force. */
  unmatchedNames: string[];
  /** `providerRef` fournisseur → identifiant interne de l'équipe. */
  teamIdByRef: Map<string, string>;
}

/**
 * Enregistre les identités d'équipes portées par le calendrier.
 *
 * Point crucial : **une équipe fournisseur doit rejoindre l'équipe canonique
 * déjà connue**, sinon elle arriverait sans aucun historique et aucune
 * prédiction ne serait possible (§12). L'ordre suivi est donc :
 *
 *   1. l'identifiant fournisseur déjà conservé (`Team.providerRefs`) ;
 *   2. le slug canonique (`slug:arsenal`), construit par la même fonction que
 *      l'ingestion historique — c'est ce qui garantit la jonction ;
 *   3. un rapprochement par similarité dans la même compétition, au seuil
 *      habituel (0,72), avec la même table d'alias que le reste de la base ;
 *   4. en dernier recours seulement, la création d'une équipe.
 *
 * Le rapprochement par nom n'est jamais présenté comme une certitude : les cas
 * non résolus sont listés dans le rapport (`unmatchedNames`), car ils coûtent
 * une prédiction et doivent rester visibles.
 */
async function applyTeamIdentities(
  teams: SideloadTeam[],
  leagueId: string,
  leagueCountry: string | null,
  providerKey: string,
): Promise<IdentityStats> {
  const stats: IdentityStats = {
    teamsCreated: 0,
    teamsEnriched: 0,
    teamsMatched: 0,
    unmatchedNames: [],
    teamIdByRef: new Map(),
  };

  if (teams.length === 0) return stats;

  // Une seule lecture par lot : les équipes de la compétition servent à la
  // fois au rapprochement par slug et au rapprochement par similarité.
  const known = await prisma.team.findMany({
    where: { OR: [{ leagueId }, { leagueId: null }] },
    select: { id: true, externalId: true, name: true, shortName: true, tla: true, crest: true, country: true, providerRefs: true },
  });

  const bySlug = new Map(known.map((team) => [team.externalId, team]));
  // Index « relâché » : absorbe les différences d'apostrophe entre sources
  // (« Nott'm Forest » historique / « Nottingham Forest » au calendrier).
  const byRelaxedKey = new Map(known.map((team) => [`slug:${relaxedTeamKey(team.name)}`, team]));

  for (const team of teams) {
    const providerRef = team.providerRef;
    if (!providerRef) continue;

    // 1 — identifiant fournisseur déjà enregistré ?
    const byProviderRef = known.find(
      (candidate) => (candidate.providerRefs as Record<string, string> | null)?.[providerKey] === team.providerId,
    );

    // 2 — slug canonique, puis 3 — similarité contrôlée.
    const slug = `slug:${teamSlug(team.providerName)}`;
    const byCanonicalSlug = bySlug.get(slug) ?? byRelaxedKey.get(`slug:${relaxedTeamKey(team.providerName)}`) ?? null;
    const matched = byProviderRef ?? byCanonicalSlug;
    const resolvedId = matched
      ? matched.id
      : resolveTeamId(team.providerName, known, 0.72) ?? null;

    const target = resolvedId ? known.find((candidate) => candidate.id === resolvedId) ?? null : null;

    if (target) {
      const patch: Record<string, unknown> = {};
      if (team.logo && !target.crest) patch.crest = team.logo;
      if (leagueCountry && !target.country) patch.country = leagueCountry;
      patch.providerRefs = {
        ...((target.providerRefs as Record<string, string> | null) ?? {}),
        [providerKey]: team.providerId,
      };
      patch.lastDataUpdate = new Date();

      await prisma.team.update({ where: { id: target.id }, data: patch });
      // Le patch est répercuté localement : le prochain passage le retrouvera
      // sans nouvelle requête, et deux équipes de la même journée ne peuvent
      // pas être rapprochées deux fois du même enregistrement.
      (target as { providerRefs: unknown }).providerRefs = patch.providerRefs;
      if (team.logo && !target.crest) (target as { crest: string | null }).crest = team.logo;

      stats.teamsEnriched += 1;
      if (byProviderRef || byCanonicalSlug) stats.teamsMatched += 1;
      if (!byCanonicalSlug && !byProviderRef) {
        stats.unmatchedNames.push(`${team.providerName} → rapproché par similarité`);
      }
      stats.teamIdByRef.set(providerRef, target.id);
      continue;
    }

    // 4 — création : elle est signalée, car une équipe sans historique ne
    // pourra pas être prédite tant que des rencontres ne l'alimentent pas.
    const created = await prisma.team.create({
      data: {
        externalId: slug,
        name: team.providerName,
        shortName: team.providerName.length > 22 ? team.providerName.slice(0, 22) : team.providerName,
        // Pays et drapeau jamais déduits d'un nom d'équipe (§15).
        country: leagueCountry || null,
        crest: team.logo,
        providerRefs: { [providerKey]: team.providerId },
        leagueId,
        dataQuality: team.logo ? "GOOD" : "MEDIUM",
        lastDataUpdate: new Date(),
      },
    });

    known.push({
      id: created.id,
      externalId: created.externalId,
      name: created.name,
      shortName: created.shortName,
      tla: created.tla,
      crest: created.crest,
      country: created.country,
      providerRefs: created.providerRefs,
    });
    bySlug.set(created.externalId, known[known.length - 1]!);
    byRelaxedKey.set(`slug:${relaxedTeamKey(created.name)}`, known[known.length - 1]!);

    stats.teamsCreated += 1;
    stats.unmatchedNames.push(`${team.providerName} → aucune correspondance connue`);
    stats.teamIdByRef.set(providerRef, created.id);
  }

  return stats;
}

/* -------------------------------------------------------------------------- */
/* Persistance d'une rencontre                                                 */
/* -------------------------------------------------------------------------- */

interface MatchIndex {
  byExternalId: Map<string, string>;
  byFallbackKey: Map<string, string[]>;
}

async function loadMatchIndex(dayKeys: string[]): Promise<MatchIndex> {
  // Fenêtre de lecture : les journées visées, élargies d'un jour pour absorber
  // les décalages de fuseau de la source.
  const bounds = dayKeys.flatMap((key) => [utcDayBounds(key)]);
  const min = Math.min(...bounds.map((b) => b.startMs)) - 86_400_000;
  const max = Math.max(...bounds.map((b) => b.endMs)) + 86_400_000;

  const matches = await prisma.match.findMany({
    where: { utcDate: { gte: new Date(min), lte: new Date(max) } },
    select: { id: true, externalId: true, leagueId: true, homeTeamId: true, awayTeamId: true, utcDate: true },
  });

  const byExternalId = new Map<string, string>();
  const byFallbackKey = new Map<string, string[]>();
  for (const m of matches) {
    byExternalId.set(m.externalId, m.id);
    for (const key of fallbackMatchKeys({
      competition: m.leagueId,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      dayKey: utcDayKey(m.utcDate),
    })) {
      const list = byFallbackKey.get(key) ?? [];
      list.push(m.id);
      byFallbackKey.set(key, list);
    }
  }

  return { byExternalId, byFallbackKey };
}

const STATUS_MAP = {
  scheduled: "SCHEDULED",
  live: "LIVE",
  finished: "FINISHED",
  postponed: "POSTPONED",
  cancelled: "CANCELLED",
} as const;

/**
 * Écrit une rencontre : mise à jour si elle est reconnue, création sinon.
 * Renvoie l'identifiant interne et la décision prise — cette dernière est
 * journalisée, car une fusion par clé de secours n'est pas une certitude.
 */
async function persistFixture(input: {
  fixture: NormalizedFixture;
  leagueId: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  index: MatchIndex;
}): Promise<{ matchId: string; created: boolean; approximate: boolean }> {
  const { fixture, leagueId, seasonId, homeTeamId, awayTeamId, index } = input;

  const decision = decideMatch({
    providerKey: fixture.externalId || null,
    existingByProviderKey: index.byExternalId.has(fixture.externalId),
    fallbackKeys: fallbackMatchKeys({
      competition: leagueId,
      homeTeamId,
      awayTeamId,
      dayKey: utcDayKey(fixture.utcDate),
    }),
    existingFallbackKeys: new Set(index.byFallbackKey.keys()),
  });

  const status = STATUS_MAP[fixture.status as keyof typeof STATUS_MAP] ?? null;
  if (!status) {
    // Statut non reconnu : on n'invente rien, la rencontre n'est pas écrite.
    throw new Error(`Statut non reconnu pour ${fixture.externalId} : ${fixture.status}`);
  }

  if (decision.action === "update") {
    const matchId = index.byExternalId.get(decision.matchedKey) ?? index.byFallbackKey.get(decision.matchedKey)?.[0];
    if (matchId) {
      const existing = await prisma.match.findUnique({
        where: { id: matchId },
        select: { dataSources: true, externalId: true },
      });
      const sources = new Set([...(existing?.dataSources ?? []), LFA_PROVIDER_NAME]);
      await prisma.match.update({
        where: { id: matchId },
        data: {
          utcDate: fixture.utcDate,
          status,
          homeScore: fixture.homeScore,
          awayScore: fixture.awayScore,
          halfTimeHomeScore: fixture.halfTimeHomeScore,
          halfTimeAwayScore: fixture.halfTimeAwayScore,
          winner:
            fixture.homeScore !== null && fixture.awayScore !== null
              ? fixture.homeScore > fixture.awayScore
                ? "HOME_TEAM"
                : fixture.homeScore < fixture.awayScore
                  ? "AWAY_TEAM"
                  : "DRAW"
              : null,
          dataSources: [...sources],
          lastDataUpdate: new Date(),
        },
      });
      return { matchId, created: false, approximate: decision.approximate };
    }
  }

  const created = await prisma.match.create({
    data: {
      externalId: fixture.externalId,
      seasonId,
      leagueId,
      homeTeamId,
      awayTeamId,
      utcDate: fixture.utcDate,
      status,
      homeScore: fixture.homeScore,
      awayScore: fixture.awayScore,
      halfTimeHomeScore: fixture.halfTimeHomeScore,
      halfTimeAwayScore: fixture.halfTimeAwayScore,
      winner:
        fixture.homeScore !== null && fixture.awayScore !== null
          ? fixture.homeScore > fixture.awayScore
            ? "HOME_TEAM"
            : fixture.homeScore < fixture.awayScore
              ? "AWAY_TEAM"
              : "DRAW"
          : null,
      dataQuality: "MEDIUM",
      dataSources: [LFA_PROVIDER_NAME],
      lastDataUpdate: new Date(),
    },
  });

  index.byExternalId.set(fixture.externalId, created.id);
  for (const key of fallbackMatchKeys({
    competition: leagueId,
    homeTeamId,
    awayTeamId,
    dayKey: utcDayKey(fixture.utcDate),
  })) {
    const list = index.byFallbackKey.get(key) ?? [];
    list.push(created.id);
    index.byFallbackKey.set(key, list);
  }

  return { matchId: created.id, created: true, approximate: false };
}

/* -------------------------------------------------------------------------- */
/* Logos (§15, §16)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Met en cache les logos **fournis par la source**, avec leur provenance.
 * Aucune URL n'est construite : si la source n'en publie pas, rien n'est écrit
 * et l'affichage basculera sur le monogramme.
 */
async function cacheLogos(teams: SideloadTeam[], teamIds: Map<string, string>): Promise<number> {
  let cached = 0;
  for (const team of teams) {
    if (!team.logo) continue;
    const teamId = teamIds.get(team.providerRef);
    if (!teamId) continue;
    await prisma.assetCache.upsert({
      where: {
        entityType_entityId_source: {
          entityType: "team",
          entityId: teamId,
          source: LFA_PROVIDER_NAME,
        },
      },
      create: {
        entityType: "team",
        entityId: teamId,
        entityName: team.providerName,
        logoUrl: team.logo,
        source: LFA_PROVIDER_NAME,
        lastVerified: new Date(),
      },
      update: {
        logoUrl: team.logo,
        entityName: team.providerName,
        lastVerified: new Date(),
      },
    });
    cached += 1;
  }
  return cached;
}

/* -------------------------------------------------------------------------- */
/* Règles pures — vérifiables sans base ni réseau (§28)                        */
/* -------------------------------------------------------------------------- */

/**
 * Saison d'une journée. Les championnats européens basculent en juillet : une
 * rencontre d'octobre appartient à la saison `2026-2027`, une rencontre de mai
 * à la saison `2025-2026`.
 */
export function seasonYearFor(dayKey: string): string {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/**
 * Une rencontre mérite-t-elle une prédiction ?
 *
 * Deux conditions, jamais une de plus : la rencontre doit être **programmée**
 * (ni en cours, ni reportée, ni annulée) et son coup d'envoi doit être
 * **strictement futur**. C'est exactement le §3 : ce qui est commencé sort du
 * flux, donc on ne prédit pas pour rien.
 */
export function isPredictable(
  fixture: { status: NormalizedFixture["status"]; utcDate: Date },
  now: Date,
): boolean {
  if (fixture.status !== "scheduled") return false;
  return fixture.utcDate.getTime() > now.getTime();
}

/* -------------------------------------------------------------------------- */
/* Journée                                                                     */
/* -------------------------------------------------------------------------- */

async function processDay(
  date: string,
  options: PipelineOptions,
  index: MatchIndex,
): Promise<DayReport> {
  const report: DayReport = {
    date,
    received: 0,
    kept: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    teamsCreated: 0,
    teamsEnriched: 0,
    teamsMatched: 0,
    logosCached: 0,
    predictionsGenerated: 0,
    predictionsPublished: 0,
    predictionsWithheld: 0,
    predictionsSkipped: 0,
    predictionsAlreadyCurrent: 0,
    creditsSpent: 0,
    creditsRemaining: null,
    fromCache: false,
    errors: [],
    notes: [],
  };

  const fetched = await (options.fetchDay ?? fetchFixturesForDate)({
    date,
    competitionCodes: options.competitionCodes,
    allowNetwork: options.allowNetwork,
  });

  report.received = fetched.received;
  report.kept = fetched.fixtures.length;
  report.creditsSpent = fetched.creditsSpent;
  report.creditsRemaining = fetched.creditsRemaining;
  report.fromCache = fetched.fromCache;

  const seasonYear = seasonYearFor(date);
  const matchIdsForPredictions: string[] = [];

  // Regroupement par compétition : les identités et les logos d'une même
  // compétition sont résolus **une seule fois**, puis réutilisés pour toutes
  // ses rencontres du jour.
  const byCompetition = new Map<string, NormalizedFixture[]>();
  for (const fixture of fetched.fixtures) {
    // §31 — une rencontre de test ne sort jamais du banc d'essai.
    if (isTestFixture(fixture.externalId)) {
      report.skipped += 1;
      continue;
    }
    if (!fixture.externalId) {
      // Sans identifiant fournisseur, pas d'écriture : mieux vaut ignorer que
      // créer une rencontre impossible à dédupliquer ensuite (§10).
      report.skipped += 1;
      report.notes.push(`Sans identifiant fournisseur : ${fixture.homeTeamName} – ${fixture.awayTeamName}`);
      continue;
    }
    const list = byCompetition.get(fixture.competition.code) ?? [];
    list.push(fixture);
    byCompetition.set(fixture.competition.code, list);
  }

  for (const [code, fixtures] of byCompetition) {
    const sample = fixtures[0]!;
    const competitionRef = fetched.sideload.competitionByMatch[sample.externalId]?.providerRef ?? "";
    const leagueSideload = fetched.sideload.leagues.find((l) => l.providerRef === competitionRef);

    // §17 — l'espace de noms du fournisseur est déduit des références reçues
    // (`lfa:…`, `the-sports-db:…`), jamais supposé.
    const providerKey =
      competitionRef.split(":")[0] ||
      fetched.sideload.teams[0]?.providerRef.split(":")[0] ||
      LFA_PROVIDER_KEY;

    let league;
    let identity: IdentityStats;
    try {
      league = await ensureCompetition({
        code,
        name: sample.competition.name,
        country: sample.competition.country,
        countryCode: countryCodeFor(sample.competition.country, code),
        providerId: leagueSideload?.providerId ?? null,
        providerKey,
        logo: null, // rempli ci-dessous si la source publie un logo de compétition
      });

      // Compétitions listées par la source : le logo, quand il existe, vient du
      // catalogue `/leagues`. Il n'est jamais fabriqué (§15).
      const season = await ensureSeason(league.id, seasonYear, true);

      // Équipes de la journée **appartenant à cette compétition**.
      const teamRefs = new Set<string>();
      for (const fixture of fixtures) {
        const refs = fetched.sideload.teamRefsByMatch[fixture.externalId];
        if (refs) {
          teamRefs.add(refs.homeRef);
          teamRefs.add(refs.awayRef);
        }
      }
      const dayTeams = fetched.sideload.teams.filter((t) => teamRefs.has(t.providerRef));

      identity = await applyTeamIdentities(dayTeams, league.id, sample.competition.country || null, providerKey);
      report.teamsCreated += identity.teamsCreated;
      report.teamsEnriched += identity.teamsEnriched;
      report.teamsMatched += identity.teamsMatched;
      report.logosCached += await cacheLogos(dayTeams, identity.teamIdByRef);
      for (const note of identity.unmatchedNames) report.notes.push(`${code} · ${note}`);

      for (const fixture of fixtures) {
        const refs = fetched.sideload.teamRefsByMatch[fixture.externalId];
        if (!refs) {
          report.skipped += 1;
          report.notes.push(`Références d'équipes absentes pour ${fixture.externalId}`);
          continue;
        }

        const homeTeamId = identity.teamIdByRef.get(refs.homeRef);
        const awayTeamId = identity.teamIdByRef.get(refs.awayRef);
        if (!homeTeamId || !awayTeamId) {
          report.skipped += 1;
          report.notes.push(`Équipes introuvables pour ${fixture.externalId}`);
          continue;
        }

        try {
          const persisted = await persistFixture({
            fixture,
            leagueId: league.id,
            seasonId: season.id,
            homeTeamId,
            awayTeamId,
            index,
          });

          if (persisted.created) report.inserted += 1;
          else report.updated += 1;
          if (persisted.approximate) {
            report.notes.push(`Rapprochement par clé de secours : ${fixture.externalId} (§10)`);
          }

          // Seules les rencontres réellement à venir et non commencées sont
          // candidates à une prédiction (§12).
          if (isPredictable(fixture, options.now ?? new Date())) {
            matchIdsForPredictions.push(persisted.matchId);
          }
        } catch (error) {
          report.skipped += 1;
          report.errors.push(`${fixture.externalId} : ${(error as Error).message}`);
        }
      }
    } catch (error) {
      // Une compétition en échec ne fait pas tomber la journée.
      report.skipped += fixtures.length;
      report.errors.push(`${code} : ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Prédictions (§12) : uniquement si des conditions minimales sont réunies.
  // ---------------------------------------------------------------------
  if (options.predict !== false && matchIdsForPredictions.length > 0) {
    const limit = options.maxPredictionsPerDay ?? 40;
    for (const matchId of matchIdsForPredictions.slice(0, limit)) {
      try {
        // §11 (idempotence) et §22 (une prédiction publiée n'est pas réécrite
        // sans raison) : si une prédiction publiée existe déjà pour la version
        // de moteur courante, on ne régénère pas — rejouer la synchronisation
        // doit produire exactement le même état, pas de nouvelles lignes.
        const current = await prisma.prediction.findFirst({
          where: { matchId, status: "PUBLISHED", modelVersion: currentModelVersion() },
          select: { id: true },
        });
        if (current) {
          report.predictionsAlreadyCurrent += 1;
          continue;
        }

        const outcome = await generateAndPersist(matchId, { asOf: new Date() });
        if (outcome.status === "skipped") {
          report.predictionsSkipped += 1;
          continue;
        }
        report.predictionsGenerated += 1;
        if (outcome.status === "published" && (outcome.confidence ?? 0) >= CONFIDENCE_THRESHOLDS.MIN_PUBLISHABLE) {
          report.predictionsPublished += 1;
        } else {
          report.predictionsWithheld += 1;
        }
      } catch (error) {
        report.predictionsSkipped += 1;
        report.errors.push(`prédiction ${matchId} : ${(error as Error).message}`);
      }
    }
  }

  return report;
}

/** Code pays ISO déduit du libellé **fourni par la source** (§15). */
function countryCodeFor(country: string, competitionCode: string): string | null {
  // Table explicite : aucun pays n'est deviné à partir d'un nom d'équipe.
  const known: Record<string, string> = {
    England: "GB",
    Spain: "ES",
    Germany: "DE",
    Italy: "IT",
    France: "FR",
    Netherlands: "NL",
    Portugal: "PT",
    Belgium: "BE",
    Turkey: "TR",
    Greece: "GR",
    Scotland: "GB",
    Togo: "TG",
  };
  return known[competitionCode] ?? known[country] ?? null;
}


/* -------------------------------------------------------------------------- */
/* Journalisation (§26)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Chaque passage de journée laisse une trace exploitable : source, volume,
 * statut, durée, erreurs. Le journal vit dans `DataSyncLog`, la même table que
 * l'ancien synchroniseur — une seule histoire à consulter, quelle que soit
 * l'origine de la donnée.
 */
async function ensureDataSource() {
  return prisma.dataSource.upsert({
    where: { name: LFA_PROVIDER_NAME },
    create: {
      name: LFA_PROVIDER_NAME,
      displayName: "LiveFootballApi",
      apiBaseUrl: "https://live-football-api.com/api/v1",
      apiKeyName: "API_FOOTBALL_LIVE_KEYS",
      rateLimit: 2,
      priority: 1,
      isActive: true,
    },
    update: { isActive: true },
  });
}

async function logSync(dataSourceId: string, report: DayReport, startedAt: Date, completedAt: Date): Promise<void> {
  const failed = report.errors.length > 0 && report.inserted + report.updated === 0;
  await prisma.dataSyncLog.create({
    data: {
      dataSourceId,
      entityType: "matches",
      entityCount: report.inserted + report.updated,
      status: failed ? "FAILED" : "SUCCESS",
      errorMessage: report.errors.length > 0 ? report.errors.slice(0, 5).join(" | ").slice(0, 900) : null,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      startedAt,
      completedAt,
    },
  });
}

/** Version de moteur attendue dans `Prediction.modelVersion`. */
function currentModelVersion(): string {
  return `${ENGINE_VERSION}-${OUTCOME_SOURCE}-ensemble`;
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Alimente la base en rencontres futures pour les journées demandées.
 *
 * ⚠️ `allowNetwork: true` engendre **1 appel par journée**. L'appelant doit
 * avoir affiché le coût et obtenu l'autorisation (§5, §34).
 */
export async function runUpcomingPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const log = options.log ?? (() => {});
  const startedAt = new Date();

  const days: DayReport[] = [];
  const index = await loadMatchIndex(options.dates);

  const dataSource = await ensureDataSource();

  for (const date of options.dates) {
    log(`── Journée ${date}`);
    const dayStartedAt = new Date();
    try {
      const report = await processDay(date, options, index);
      days.push(report);
      await logSync(dataSource.id, report, dayStartedAt, new Date());
      log(
        `   reçues ${report.received} · retenues ${report.kept} · créées ${report.inserted} · mises à jour ${report.updated}` +
          ` · logos ${report.logosCached} · prédictions ${report.predictionsGenerated}` +
          ` (publiées ${report.predictionsPublished}) · crédits ${report.creditsSpent}` +
          (report.creditsRemaining !== null ? ` · solde ${report.creditsRemaining}` : ""),
      );
      for (const error of report.errors.slice(0, 5)) log(`   ⚠ ${error}`);
    } catch (error) {
      const failed: DayReport = {
        date,
        received: 0,
        kept: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        teamsCreated: 0,
        teamsEnriched: 0,
        teamsMatched: 0,
        logosCached: 0,
        predictionsGenerated: 0,
        predictionsPublished: 0,
        predictionsWithheld: 0,
        predictionsSkipped: 0,
        predictionsAlreadyCurrent: 0,
        creditsSpent: 0,
        creditsRemaining: null,
        fromCache: false,
        errors: [(error as Error).message],
        notes: [],
      };
      days.push(failed);
      log(`   ✖ échec : ${(error as Error).message}`);
    }
  }

  const completedAt = new Date();
  const sum = (pick: (d: DayReport) => number) => days.reduce((acc, d) => acc + pick(d), 0);
  const allErrors = days.flatMap((d) => d.errors);

  return {
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    days,
    totals: {
      received: sum((d) => d.received),
      kept: sum((d) => d.kept),
      inserted: sum((d) => d.inserted),
      updated: sum((d) => d.updated),
      skipped: sum((d) => d.skipped),
      teamsCreated: sum((d) => d.teamsCreated),
      teamsEnriched: sum((d) => d.teamsEnriched),
      teamsMatched: sum((d) => d.teamsMatched),
      logosCached: sum((d) => d.logosCached),
      predictionsGenerated: sum((d) => d.predictionsGenerated),
      predictionsPublished: sum((d) => d.predictionsPublished),
      predictionsWithheld: sum((d) => d.predictionsWithheld),
      predictionsSkipped: sum((d) => d.predictionsSkipped),
      predictionsAlreadyCurrent: sum((d) => d.predictionsAlreadyCurrent),
      creditsSpent: sum((d) => d.creditsSpent),
      creditsRemaining: days.find((d) => d.creditsRemaining !== null)?.creditsRemaining ?? null,
      fromCache: days.every((d) => d.fromCache),
      errors: allErrors.length,
      notes: days.flatMap((d) => d.notes).length,
    },
    skipReasons: {
      DONNEES_INSUFFISANTES: sum((d) => d.predictionsSkipped),
      STATUT_NON_UPCOMING: sum((d) => d.kept - d.predictionsGenerated - d.predictionsSkipped),
      SANS_IDENTIFIANT: sum((d) => d.errors.filter((e) => e.includes("identifiant")).length),
    },
  };
}
