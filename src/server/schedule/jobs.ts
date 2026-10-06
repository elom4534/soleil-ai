/**
 * ============================================================================
 * SOLEIL — Phase 16 · §11, §20, §25, §27 · Tâches planifiées
 * ============================================================================
 * Trois tâches, pas une de plus — chacune répond à un besoin identifié lors de
 * l'audit (§27 : « inspecter avant de modifier » ; l'audit a montré qu'aucune
 * tâche n'existait) :
 *
 *   1. `ingestion-calendrier` — apporte les rencontres futures à la base.
 *   2. `rafraichissement-jour-j` — surveille les rencontres du jour : reports,
 *      annulations, changements d'horaire.
 *   3. `maintenance-donnees` — **gratuite** : purge du cache périmé, contrôle
 *      des invariants du flux public, état de santé des logos.
 *
 * ## Le crédit ne se dépense pas tout seul
 *
 * Les deux premières tâches appellent un fournisseur payant. Leur coût est
 * **annoncé à l'avance** (`estimatedCredits`) et leur accès réseau est
 * **fermé par défaut** : il faut `SOLEIL_SCHEDULER_NETWORK=on` pour qu'elles
 * sortent sur le réseau. Sans cette variable, elles s'exécutent quand même —
 * elles lisent le cache, vérifient les invariants, journalisent — mais ne
 * consomment rien. Une tâche planifiée ne doit jamais transformer une
 * autorisation ponctuelle en dépense récurrente silencieuse (§5, §34).
 *
 * ## Sûreté d'exécution
 *
 * · **Verrou** par tâche (table `SystemConfig`) : deux exécutions ne peuvent
 *   pas se chevaucher, même si la précédente traîne. Le verrou expire seul
 *   (`LOCK_TTL`), pour ne jamais bloquer définitivement la planification.
 * · **Idempotence** : chaque tâche peut être rejouée sans doublon — c'est la
 *   propriété vérifiée par les tests (§11).
 * · **Trace** : après chaque exécution, un résumé est écrit dans
 *   `SystemConfig` (`scheduler:last:<id>`) et chaque passage de journée laisse
 *   une ligne dans `DataSyncLog` (§26).
 */

import { prisma } from "@/lib/prisma";
import { cachePurgeExpired } from "@/server/data/cache";
import { runUpcomingPipeline, type PipelineReport } from "@/server/data/upcoming-pipeline";
import { ingestTsdbUpcoming } from "@/server/data/upcoming-tsdb";
import { importWindows, utcDayKey, assertNoStartedMatchInFeed } from "./window";
import { listUpcomingPredictions } from "@/server/predictions/upcoming";
import { generateAndPersist } from "@/server/predictions/service";
import { refreshReason } from "./freshness";
import { nextRun, parseCron, type CronExpression } from "./cron";

export type JobId =
  | "ingestion-calendrier"
  | "rafraichissement-jour-j"
  | "maintenance-donnees"
  | "alimentation-premium"
  | "alimentation-matchs-a-venir"
  | "rafraichissement-predictions";

export interface JobContext {
  now: Date;
  /** Vrai si l'opérateur a ouvert l'accès réseau pour l'ordonnanceur. */
  networkAllowed: boolean;
  log: (line: string) => void;
}

export interface JobOutcome {
  ok: boolean;
  summary: string;
  /** Crédits réellement consommés (0 en mode cache). */
  creditsSpent: number;
  /** Détail chiffré, écrit dans `SystemConfig` et repris dans les rapports. */
  details: Record<string, unknown>;
}

export interface JobDefinition {
  id: JobId;
  label: string;
  purpose: string;
  /** Expression à cinq champs, évaluée en UTC. */
  schedule: string;
  /** Vrai si la tâche peut consommer des crédits fournisseur. */
  usesNetwork: boolean;
  /** Dépense maximale d'une exécution complète, en crédits. */
  estimatedCredits: number;
  handler: (ctx: JobContext) => Promise<JobOutcome>;
}

/* -------------------------------------------------------------------------- */
/* §5, §34 — Accès réseau : fermé par défaut                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'ordonnanceur ne sort sur le réseau que si l'opérateur l'a explicitement
 * ouvert. Deux clés sont requises volontairement :
 *
 *   · `SOLEIL_SCHEDULER_NETWORK=on` — autorisation durable ;
 *   · `SOLEIL_API_DAILY_BUDGET` > 0 — plafond du jour, appliqué par le client.
 *
 * Si l'une des deux manque, la tâche le **dit** au lieu d'échouer en silence.
 */
export function networkAllowed(): boolean {
  const flag = (process.env.SOLEIL_SCHEDULER_NETWORK ?? "").toLowerCase();
  const budget = Number(process.env.SOLEIL_API_DAILY_BUDGET ?? 0);
  return (flag === "on" || flag === "true") && budget > 0;
}

/** Explication à journaliser quand l'accès réseau est refusé. */
export function networkRefusalReason(): string {
  const flag = (process.env.SOLEIL_SCHEDULER_NETWORK ?? "").toLowerCase();
  const budget = Number(process.env.SOLEIL_API_DAILY_BUDGET ?? 0);
  const reasons: string[] = [];
  if (flag !== "on" && flag !== "true") reasons.push("SOLEIL_SCHEDULER_NETWORK≠on");
  if (!(budget > 0)) reasons.push("SOLEIL_API_DAILY_BUDGET=0");
  return reasons.join(" et ") || "aucune";
}

/* -------------------------------------------------------------------------- */
/* Verrou et trace                                                             */
/* -------------------------------------------------------------------------- */

const LOCK_TTL_MS = 30 * 60 * 1000;

export interface JobRunRecord {
  jobId: JobId;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  summary: string;
  creditsSpent: number;
  networkAllowed: boolean;
  details?: Record<string, unknown>;
}

async function readConfig<T>(key: string): Promise<T | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row ? (row.value as T) : null;
}

async function writeConfig(key: string, value: unknown, description?: string): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value: value as never, description },
    update: { value: value as never },
  });
}

/** Tentative d'acquisition du verrou d'une tâche. Renvoie `false` si prise. */
export async function acquireJobLock(jobId: JobId, now = new Date()): Promise<boolean> {
  const key = `scheduler:lock:${jobId}`;
  const existing = await readConfig<{ owner: string; expiresAt: string }>(key);

  if (existing && Date.parse(existing.expiresAt) > now.getTime()) return false;

  await writeConfig(
    key,
    { owner: `${jobId}:${now.toISOString()}`, startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + LOCK_TTL_MS).toISOString() },
    `Verrou d'exécution — ${jobId}`,
  );
  return true;
}

export async function releaseJobLock(jobId: JobId): Promise<void> {
  await prisma.systemConfig.deleteMany({ where: { key: `scheduler:lock:${jobId}` } });
}

export async function lastRun(jobId: JobId): Promise<JobRunRecord | null> {
  return readConfig<JobRunRecord>(`scheduler:last:${jobId}`);
}

/* -------------------------------------------------------------------------- */
/* Tâche 1 — Alimentation du calendrier                                        */
/* -------------------------------------------------------------------------- */

export const ingestionJob: JobDefinition = {
  id: "ingestion-calendrier",
  label: "Alimentation du calendrier (aujourd'hui → J+3)",
  purpose:
    "Récupère les rencontres des journées à venir (E0, SP1), conserve identifiants et logos, puis génère les prédictions des rencontres prêtes.",
  schedule: "0 6 * * *",
  usesNetwork: true,
  // 4 journées × 1 crédit. Le chiffre est vérifiable : `fetchFixturesForDate`
  // n'émet qu'une requête par journée.
  estimatedCredits: 4,

  async handler(ctx) {
    const windows = importWindows(ctx.now, { daysAhead: 3, includeToday: true });
    ctx.log(
      `Journées visées : ${windows.map((w) => `${w.date} (${w.label})`).join(", ")} — ` +
        `${ctx.networkAllowed ? `${windows.length} appel(s) → ${windows.length} crédit(s)` : "réutilisation du cache → 0 crédit"}`,
    );
    if (!ctx.networkAllowed) ctx.log(`Accès réseau fermé (${networkRefusalReason()}) : aucun crédit ne sera engagé.`);

    const report = await runUpcomingPipeline({
      dates: windows.map((w) => w.date),
      competitionCodes: ["E0", "SP1", "D1", "I1", "F1", "UCL", "UEL", "UNL"],
      allowNetwork: ctx.networkAllowed,
      predict: true,
      log: ctx.log,
    });

    return {
      ok: report.totals.errors === 0,
      summary:
        `${report.totals.inserted} création(s), ${report.totals.updated} mise(s) à jour, ` +
        `${report.totals.predictionsGenerated} prédiction(s) générée(s), ${report.totals.creditsSpent} crédit(s)`,
      creditsSpent: report.totals.creditsSpent,
      details: summarize(report),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Tâche 2 — Rafraîchissement du jour                                          */
/* -------------------------------------------------------------------------- */

export const refreshTodayJob: JobDefinition = {
  id: "rafraichissement-jour-j",
  label: "Rafraîchissement des rencontres du jour",
  purpose:
    "Surveille la journée en cours : report, annulation ou changement d'horaire. Une rencontre annulée disparaît du flux public dès le passage suivant.",
  schedule: "0 */6 * * *",
  usesNetwork: true,
  // 1 journée × 1 crédit, au maximum une fois par passage.
  estimatedCredits: 1,

  async handler(ctx) {
    const today = utcDayKey(ctx.now);
    ctx.log(`Journée surveillée : ${today} — ${ctx.networkAllowed ? "1 appel → 1 crédit" : "cache → 0 crédit"}`);
    if (!ctx.networkAllowed) ctx.log(`Accès réseau fermé (${networkRefusalReason()}) : aucun crédit ne sera engagé.`);

    const report = await runUpcomingPipeline({
      dates: [today],
      competitionCodes: ["E0", "SP1", "D1", "I1", "F1", "UCL", "UEL", "UNL"],
      allowNetwork: ctx.networkAllowed,
      predict: true,
      log: ctx.log,
    });

    // Contrôle immédiat : ce que voit l'utilisateur est-il encore valide ?
    const feed = await listUpcomingPredictions({ now: ctx.now, limit: 50 });
    ctx.log(`Flux public après rafraîchissement : ${feed.matches.length} rencontre(s) affichable(s).`);

    return {
      ok: report.totals.errors === 0,
      summary:
        `${report.totals.updated} mise(s) à jour, ${report.totals.inserted} création(s), ` +
        `${feed.matches.length} rencontre(s) affichable(s), ${report.totals.creditsSpent} crédit(s)`,
      creditsSpent: report.totals.creditsSpent,
      details: { ...summarize(report), displayable: feed.matches.length },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Tâche 3 — Maintenance (gratuite)                                            */
/* -------------------------------------------------------------------------- */

export const maintenanceJob: JobDefinition = {
  id: "maintenance-donnees",
  label: "Maintenance : cache, logos, invariants du flux public",
  purpose:
    "Passe le flux public au contrôle §29 (aucune rencontre commencée, toute rencontre affichée a une prédiction publiée et versionnée), purge le cache périmé et mesure la couverture des logos. Coût : 0 crédit.",
  schedule: "30 3 * * *",
  usesNetwork: false,
  estimatedCredits: 0,

  async handler(ctx) {
    const purged = await cachePurgeExpired();
    ctx.log(`Cache : ${purged} entrée(s) périmée(s) purgée(s).`);

    // §29 — contrôle critique, exécuté sur les données réelles du flux public.
    const feed = await listUpcomingPredictions({ now: ctx.now, limit: 200 });
    const violations = assertNoStartedMatchInFeed(
      feed.matches.map((match) => ({
        status: match.status,
        utcDate: match.utcDate,
        // `VALIDATION_SELECT` (couche de prédiction) charge bien `modelVersion` :
        // le type exposé par `MatchListItem` ne le reflète pas, d'où ce
        // élargissement local, sans effet sur la valeur lue.
        prediction: match.predictions[0]
          ? {
              status: match.predictions[0].status,
              modelVersion: (match.predictions[0] as { modelVersion?: string | null }).modelVersion ?? null,
            }
          : null,
      })),
      ctx.now,
    );

    if (violations.length > 0) {
      ctx.log(`✖ ${violations.length} violation(s) d'invariant détectée(s) — affichage à bloquer, jamais à rafistoler.`);
      for (const violation of violations.slice(0, 10)) {
        ctx.log(`   · #${violation.index} ${violation.code} — ${violation.detail}`);
      }
    } else {
      ctx.log(`✔ Invariants §29 vérifiés sur ${feed.matches.length} rencontre(s) affichable(s).`);
    }

    // Couverture des logos : mesurée, jamais supposée (§15, §30).
    const [teamsWithCrest, teamsTotal, leaguesWithLogo, leaguesTotal, assets] = await Promise.all([
      prisma.team.count({ where: { crest: { not: null } } }),
      prisma.team.count(),
      prisma.league.count({ where: { logo: { not: null } } }),
      prisma.league.count(),
      prisma.assetCache.count(),
    ]);

    const health = {
      checkedAt: ctx.now.toISOString(),
      displayable: feed.matches.length,
      violations: violations.length,
      teamsWithCrest,
      teamsTotal,
      leaguesWithLogo,
      leaguesTotal,
      assetsCached: assets,
      cachePurged: purged,
    };
    await writeConfig("scheduler:health", health, "Dernier état de santé mesuré par la maintenance");

    return {
      ok: violations.length === 0,
      summary:
        `${feed.matches.length} rencontre(s) affichable(s), ${violations.length} violation(s) d'invariant, ` +
        `logos ${teamsWithCrest}/${teamsTotal} équipes · ${leaguesWithLogo}/${leaguesTotal} compétitions`,
      creditsSpent: 0,
      details: health,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Registre — les trois tâches, créées et actives                              */
/* -------------------------------------------------------------------------- */

/**
 * Registre complet. `enabled` est volontairement absent : une tâche présente
 * dans ce tableau **est** active (§27). Désactiver une tâche se fait donc en
 * la retirant explicitement, ce qui laisse une trace lisible en revue de code.
 */
/* -------------------------------------------------------------------------- */
/* Tâche 4 — Matchs à venir via la source gratuite (0 crédit)                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Tâche 4-bis — Alimentation premium (Live Football API, mission 21)         */
/* -------------------------------------------------------------------------- */

/**
 * Source PRIORITAIRE des données récentes (mission 21) : saison courante des
 * compétitions prioritaires, statistiques détaillées des matchs récents,
 * logos/identité des équipes, contexte actuel des matchs à venir (H2H,
 * blessures, compositions). La source gratuite (tâche suivante) ne prend le
 * relais qu'en secours, jamais l'inverse.
 */
export const lfaPremiumJob: JobDefinition = {
  id: "alimentation-premium",
  label: "Alimentation premium (Live Football API)",
  purpose:
    "Synchronise la saison courante (résultats récents + à venir) des compétitions prioritaires depuis " +
    "Live Football API, enrichit les matchs récents en statistiques détaillées, les équipes en logos " +
    "et les matchs à venir en contexte actuel (H2H, blessures, compositions).",
  // Avant la tâche gratuite (6h15) : si celle-ci réussit, la suivante est
  // idempotente et n'ajoute rien.
  schedule: "0 6 * * *",
  usesNetwork: true,
  estimatedCredits: 260,

  async handler(ctx) {
    const { syncLfaLeague, enrichRecentStats, refreshUpcomingContext, discoverUpcoming, syncTeamLogos } =
      await import("@/server/data/lfaPremium");
    const leagues = Object.keys((await import("@/server/data/lfaPremium")).LFA_LEAGUES);
    const syncs = [];
    for (const code of leagues) {
      const s = await syncLfaLeague(code, ctx.now);
      syncs.push(s);
      ctx.log(`[premium] ${code} : ${s.received} reçus, ${s.inserted} créés, ${s.updated} mis à jour`);
    }
    const discovery = await discoverUpcoming(3);
    const stats = await enrichRecentStats(45, 90);
    const context = await refreshUpcomingContext(5, 18);
    const logos = await syncTeamLogos(120);
    const errors = [...syncs, ...discovery].flatMap((s) => s.errors);
    return {
      ok: errors.length === 0,
      summary:
        `${syncs.reduce((a, s) => a + s.inserted + s.updated, 0)} match(s) synchronisés, ` +
        `${stats.enriched} enrichi(s) en statistiques, ${context.withInjuries} contexte(s) de blessures, ` +
        `${logos.updated} logo(s), ${stats.creditsSpent + context.creditsSpent} crédits`,
      creditsSpent: stats.creditsSpent + context.creditsSpent,
      details: { syncs: syncs.map((s) => ({ league: s.league, inserted: s.inserted, updated: s.updated })), stats, context, logos },
    };
  },
};

export const upcomingTsdbJob: JobDefinition = {
  id: "alimentation-matchs-a-venir",
  label: "Alimentation des matchs à venir (source gratuite)",
  purpose:
    "Récupère les prochaines rencontres E0/SP1 depuis TheSportsDB (gratuit) et génère leurs prédictions. " +
    "Sert de voie automatique quand le fournisseur payant est indisponible.",
  // Juste après la tâche payante : si elle a réussi, cette exécution est
  // idempotente et n'ajoute rien (§11).
  schedule: "15 6 * * *",
  // Source libre : volontairement NON soumise au verrou réseau payant
  // (SOLEIL_SCHEDULER_NETWORK). Aucun crédit ne peut être engagé ici.
  usesNetwork: false,
  estimatedCredits: 0,

  async handler(ctx) {
    const report = await ingestTsdbUpcoming({ now: ctx.now, log: ctx.log });
    return {
      ok: report.errors.length === 0,
      summary:
        `${report.kept} rencontre(s) à venir, ${report.inserted} création(s), ${report.updated} mise(s) à jour, ` +
        `${report.predictionsPublished} prédiction(s) publiée(s), ${report.creditsSpent} crédit(s)`,
      creditsSpent: report.creditsSpent,
      details: { dates: report.dates, collected: report.collected, withheld: report.predictionsWithheld },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Tâche 5 — Actualisation des prédictions (0 crédit, lecture/écriture base)   */
/* -------------------------------------------------------------------------- */

/**
 * Dernière mise à jour des données utilisables par le contexte d'un match :
 * ses matchs antérieurs (les deux équipes), leurs données live, et le match
 * lui-même (report d'horaire, correction de statut).
 */
async function contextUpdatedAtFor(match: {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
}): Promise<Date | null> {
  const teamFilter = {
    OR: [{ homeTeamId: match.homeTeamId }, { awayTeamId: match.awayTeamId }],
  };
  const [prior, live, own] = await Promise.all([
    prisma.match.aggregate({
      _max: { updatedAt: true },
      where: { status: "FINISHED", ...teamFilter },
    }),
    prisma.matchLiveData.aggregate({
      _max: { updatedAt: true },
      where: { match: teamFilter },
    }),
    prisma.match.findUnique({ where: { id: match.id }, select: { updatedAt: true } }),
  ]);
  const times = [prior._max.updatedAt, live._max.updatedAt, own?.updatedAt].filter(
    (d): d is Date => d instanceof Date,
  );
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

export const refreshPredictionsJob: JobDefinition = {
  id: "rafraichissement-predictions",
  label: "Actualisation des prédictions (contexte enrichi / périmées)",
  purpose:
    "Détecte les matchs SCHEDULED dont la prédiction n'est plus à jour — données historiques enrichies depuis la génération " +
    "('context enriched') ou prédiction trop ancienne pour un match encore à jouer ('stale prediction') — et les recalcule. " +
    "Protège définitivement les prédictions SETTLED, ne touche qu'aux matchs futurs, et ne consomme aucun crédit (aucun appel réseau).",
  // Granularité de 30 min : la fraîcheur borne le travail réel (aucun recalcul
  // sans changement de contexte ni sans âge dépassé).
  schedule: "*/30 * * * *",
  usesNetwork: false,
  estimatedCredits: 0,

  async handler(ctx) {
    const upcoming = await prisma.match.findMany({
      where: { status: "SCHEDULED", utcDate: { gt: ctx.now } },
      orderBy: { utcDate: "asc" },
      take: 200,
      select: { id: true, homeTeamId: true, awayTeamId: true },
    });
    ctx.log(`${upcoming.length} match(s) SCHEDULED à venir examiné(s).`);

    let created = 0;
    let refreshedContextEnriched = 0;
    let refreshedStale = 0;
    let published = 0;
    let settledProtected = 0;
    let currentUntouched = 0;

    for (const match of upcoming) {
      try {
        const existing = await prisma.prediction.findFirst({
          where: { matchId: match.id },
          orderBy: { generatedAt: "desc" },
          select: { id: true, status: true, generatedAt: true },
        });

        // §22 — une prédiction réglée appartient à l'histoire : jamais touchée.
        if (existing?.status === "SETTLED") {
          settledProtected += 1;
          continue;
        }

        if (!existing) {
          const outcome = await generateAndPersist(match.id, { asOf: ctx.now });
          if (outcome.status === "skipped") continue;
          created += 1;
          if (outcome.status === "published") published += 1;
          ctx.log(`· ${match.id} : prédiction générée (match sans prédiction).`);
          continue;
        }

        const contextUpdatedAt = await contextUpdatedAtFor(match);
        const reason = refreshReason(existing.generatedAt, contextUpdatedAt, ctx.now);
        if (!reason) {
          currentUntouched += 1;
          continue; // §11 — rien n'a changé : aucune écriture, aucune boucle.
        }

        const outcome = await generateAndPersist(match.id, { asOf: ctx.now });
        if (outcome.status === "skipped") continue;
        if (reason === "context enriched") refreshedContextEnriched += 1;
        else refreshedStale += 1;
        if (outcome.status === "published") published += 1;
        ctx.log(`· ${match.id} : recalculée — motif « ${reason} ».`);
      } catch (error) {
        ctx.log(`· ${match.id} : erreur — ${(error as Error).message}`);
      }
    }

    return {
      ok: true,
      summary:
        `${created} créée(s), ${refreshedContextEnriched} rafraîchie(s) (context enriched), ` +
        `${refreshedStale} rafraîchie(s) (stale prediction), ${published} publiée(s), ` +
        `${settledProtected} SETTLED protégée(s), ${currentUntouched} inchangée(s)`,
      creditsSpent: 0,
      details: {
        created,
        refreshedContextEnriched,
        refreshedStale,
        published,
        settledProtected,
        currentUntouched,
        motifs: ["context enriched", "stale prediction"],
      },
    };
  },
};

export const JOBS: readonly JobDefinition[] = [ingestionJob, refreshTodayJob, maintenanceJob, lfaPremiumJob, upcomingTsdbJob, refreshPredictionsJob];

export function findJob(id: string): JobDefinition | undefined {
  return JOBS.find((job) => job.id === id);
}

/**
 * Coût quotidien maximal des tâches payantes.
 *
 * Le nombre de déclenchements est **compté sur l'expression cron elle-même**
 * (on avance de déclenchement en déclenchement sur 24 h), jamais écrit à la
 * main : le jour où une cadence change, le coût affiché change avec elle.
 */
export function totalDailyCredits(now = new Date()): number {
  return JOBS.reduce((total, job) => {
    if (!job.usesNetwork) return total;
    return total + job.estimatedCredits * runsPerDay(job.schedule, now);
  }, 0);
}

/**
 * Nombre de déclenchements d'une expression sur une fenêtre de 24 heures.
 *
 * La fenêtre est **semi-ouverte et inclusive au départ** : un déclenchement qui
 * tombe exactement sur l'instant de départ compte. La tâche de rafraîchissement
 * (toutes les six heures, à la minute zéro) partant de 00:00 vaut donc bien
 * 4 déclenchements, pas 3 — compter à côté d'une unité ferait mentir le coût
 * affiché, ce que ce calcul doit précisément rendre impossible.
 */
export function runsPerDay(schedule: CronExpression | string, from = new Date()): number {
  const cron: CronExpression = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const horizonMs = 24 * 60 * 60 * 1000;
  const limit = from.getTime() + horizonMs;

  let count = 0;
  // On recule d'une milliseconde : `nextRun` est strictement postérieur, ce
  // décalage rend l'instant de départ lui-même éligible.
  let cursor = nextRun(cron, new Date(from.getTime() - 1));
  while (cursor && cursor.getTime() < limit) {
    count += 1;
    cursor = nextRun(cron, cursor);
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                   */
/* -------------------------------------------------------------------------- */

function summarize(report: PipelineReport): Record<string, unknown> {
  return {
    jours: report.days.map((d) => ({
      date: d.date,
      recues: d.received,
      retenues: d.kept,
      creees: d.inserted,
      maj: d.updated,
      ignorees: d.skipped,
      logos: d.logosCached,
      predictions: d.predictionsGenerated,
      publiees: d.predictionsPublished,
      retenuesNonPubliees: d.predictionsWithheld,
      dejaAJour: d.predictionsAlreadyCurrent,
      credits: d.creditsSpent,
      solde: d.creditsRemaining,
      depuisCache: d.fromCache,
      erreurs: d.errors.slice(0, 3),
    })),
    ...report.totals,
  };
}

/**
 * Exécute une tâche, verrou compris.
 *
 * Le verrou est libéré **systématiquement**, y compris en cas d'erreur : une
 * tâche qui échoue ne doit pas condamner les suivantes. Le résultat est
 * enregistré, succès comme échec — un échec silencieux serait pire qu'un échec.
 */
export async function runJob(
  job: JobDefinition,
  options: { now?: Date; force?: boolean; onLog?: (line: string) => void } = {},
): Promise<JobRunRecord> {
  const now = options.now ?? new Date();
  const acquired = options.force ? true : await acquireJobLock(job.id, now);
  const startedAt = new Date();

  if (!acquired) {
    const record: JobRunRecord = {
      jobId: job.id,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      ok: false,
      summary: "Exécution ignorée : une exécution précédente est encore en cours (verrou actif).",
      creditsSpent: 0,
      networkAllowed: networkAllowed(),
    };
    return record;
  }

  const lines: string[] = [];
  let outcome: JobOutcome;

  try {
    outcome = await job.handler({
      now,
      networkAllowed: networkAllowed(),
      log: (line) => {
        lines.push(line);
        options.onLog?.(line);
      },
    });
  } catch (error) {
    outcome = {
      ok: false,
      summary: `Échec : ${(error as Error).message}`,
      creditsSpent: 0,
      details: { erreur: (error as Error).message },
    };
  } finally {
    if (!options.force) await releaseJobLock(job.id);
  }

  const completedAt = new Date();
  const record: JobRunRecord = {
    jobId: job.id,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    ok: outcome.ok,
    summary: outcome.summary,
    creditsSpent: outcome.creditsSpent,
    networkAllowed: networkAllowed(),
    details: outcome.details,
  };

  // Le journal est conservé avec le résultat : une exécution passée doit rester
  // explicable sans avoir à relancer quoi que ce soit.
  record.details = { ...(record.details ?? {}), journal: lines.slice(-40) };
  await writeConfig(`scheduler:last:${job.id}`, record, `Dernière exécution — ${job.label}`);

  return record;
}

/**
 * Exécute les tâches **dues** à l'instant `now`, puis rend la main. C'est la
 * forme unique appelée aussi bien par `scripts/scheduler.ts --once` que par le
 * cœur de l'ordonnanceur applicatif (AlwaysData : `crontab` interdit, le
 * processus applicatif porte donc la planification).
 */
export async function runDueJobs(
  options: { now?: Date; onLog?: (line: string) => void } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  for (const job of JOBS) {
    const record = await lastRun(job.id);
    const cursor = record ? new Date(record.completedAt) : new Date(now.getTime() - 86_400_000);
    const due = nextRun(parseCron(job.schedule), cursor);
    if (due && due.getTime() <= now.getTime()) {
      const result = await runJob(job, { now, onLog: options.onLog });
      options.onLog?.(`${job.id} : ${result.summary}`);
    }
  }
}
