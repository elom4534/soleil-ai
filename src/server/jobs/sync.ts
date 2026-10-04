/**
 * ============================================================================
 * SOLEIL — Pipeline de synchronisation quotidien (§25)
 * ============================================================================
 *  1. récupérer les matchs
 *  2. récupérer les données disponibles
 *  3. nettoyer les données
 *  4. vérifier leur qualité
 *  5. calculer les statistiques
 *  6. lancer les modèles
 *  7. calculer les probabilités
 *  8. comparer les modèles
 *  9. calculer le consensus
 * 10. calculer le score de confiance
 * 11. sélectionner les meilleures prédictions
 * 12. publier automatiquement les résultats
 *
 * Aucune saisie manuelle de statistiques par l'utilisateur.
 */

import { prisma } from "@/lib/prisma";
import { HISTORICAL_LEAGUES } from "@/lib/constants";
import { PROVIDERS } from "@/server/data/providers";
import { ingestFixtures, currentSeasonLabel, previousSeasonLabel, refreshSeasonFlags } from "@/server/data/ingest";
import { generateAndPersist, settlePredictions } from "@/server/predictions/service";

/** Verrou d'exécution : empêche deux synchronisations simultanées. */
let running = false;

export interface SyncReport {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  leaguesProcessed: number;
  fixturesFetched: number;
  fixturesInserted: number;
  fixturesUpdated: number;
  teamsCreated: number;
  predictionsGenerated: number;
  predictionsPublished: number;
  predictionsWithheld: number;
  settled: number;
  apiRequests: number;
  providerReports: {
    provider: string;
    competition: string;
    season: string;
    status: "success" | "partial" | "failed";
    fetched: number;
    inserted: number;
    updated: number;
    error?: string;
  }[];
  errors: string[];
}

export interface SyncOptions {
  /** Codes de compétitions à synchroniser (par défaut : toutes). */
  competitions?: string[];
  /** Saisons à synchroniser : courante + précédente par défaut. */
  seasons?: string[];
  /** Générer les prédictions après ingestion. */
  predict?: boolean;
  /** Nombre maximal de matchs à venir pour lesquels générer une prédiction. */
  maxPredictions?: number;
  /** Règlement des prédictions passées. */
  settle?: boolean;
  /** Journaliser dans DataSyncLog. */
  log?: boolean;
}

/**
 * Exécute le pipeline complet.
 * Chaque fournisseur est interrogé dans l'ordre de priorité ; en cas d'échec,
 * le suivant prend le relais (résilience multi-source, §29).
 */
export async function runSync(options: SyncOptions = {}): Promise<SyncReport> {
  if (running) {
    throw new Error("Une synchronisation est déjà en cours.");
  }
  running = true;

  const startedAt = new Date();
  const now = new Date();
  const seasons = options.seasons ?? [currentSeasonLabel(now), previousSeasonLabel(now)];
  const competitions =
    options.competitions ?? HISTORICAL_LEAGUES.map((l) => l.code);

  const report: SyncReport = {
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    leaguesProcessed: 0,
    fixturesFetched: 0,
    fixturesInserted: 0,
    fixturesUpdated: 0,
    teamsCreated: 0,
    predictionsGenerated: 0,
    predictionsPublished: 0,
    predictionsWithheld: 0,
    settled: 0,
    apiRequests: 0,
    providerReports: [],
    errors: [],
  };

  try {
    await refreshSeasonFlags();

    // -------------------------------------------------------------------
    // Étapes 1-4 : collecte, nettoyage, validation, ingestion
    // -------------------------------------------------------------------
    for (const competition of competitions) {
      let leagueTouched = false;

      for (const provider of PROVIDERS) {
        if (!provider.isConfigured()) continue;

        for (const season of seasons) {
          const entry = {
            provider: provider.name,
            competition,
            season,
            status: "success" as "success" | "partial" | "failed",
            fetched: 0,
            inserted: 0,
            updated: 0,
            error: undefined as string | undefined,
          };

          const logRow = options.log
            ? await prisma.dataSyncLog
                .create({
                  data: {
                    dataSourceId: await ensureDataSource(provider.name, provider.displayName, PROVIDER_BASE_URLS[provider.name]),
                    entityType: `fixtures:${competition}:${season}`,
                    entityCount: 0,
                    status: "STARTED",
                    startedAt: new Date(),
                  },
                })
                .catch(() => null)
            : null;

          try {
            const result = await provider.fetchCompetition({
              competitionCode: competition,
              season,
            });
            report.apiRequests += result.requestCount;
            entry.fetched = result.data.length;
            report.fixturesFetched += result.data.length;

            if (result.data.length === 0) {
              entry.status = "partial";
              entry.error = "Aucune rencontre renvoyée par la source";
            } else {
              const stats = await ingestFixtures({
                provider: provider.name,
                competitionCode: competition,
                season,
                fixtures: result.data,
              });
              entry.inserted = stats.inserted;
              entry.updated = stats.updated;
              report.fixturesInserted += stats.inserted;
              report.fixturesUpdated += stats.updated;
              report.teamsCreated += stats.teamsCreated;
              if (stats.errors.length > 0) {
                entry.status = "partial";
                entry.error = stats.errors.slice(0, 3).join(" | ");
                report.errors.push(...stats.errors.slice(0, 3));
              }
              leagueTouched = true;
            }
          } catch (error) {
            entry.status = "failed";
            entry.error = (error as Error).message;
            report.errors.push(`${provider.name}/${competition}/${season} : ${entry.error}`);
            // On n'interrompt pas : le fournisseur suivant peut prendre le relais.
          }

          report.providerReports.push(entry);

          if (logRow) {
            await prisma.dataSyncLog
              .update({
                where: { id: logRow.id },
                data: {
                  entityCount: entry.fetched,
                  status:
                    entry.status === "success" ? "SUCCESS" : entry.status === "partial" ? "PARTIAL" : "FAILED",
                  errorMessage: entry.error ?? null,
                  completedAt: new Date(),
                  durationMs: Date.now() - startedAt.getTime(),
                },
              })
              .catch(() => null);
          }
        }
      }

      if (leagueTouched) report.leaguesProcessed += 1;
    }

    // -------------------------------------------------------------------
    // Étapes 5-12 : statistiques, modèles, consensus, confiance, publication
    // -------------------------------------------------------------------
    if (options.predict !== false) {
      const generated = await generateUpcomingPredictions(options.maxPredictions ?? 120);
      report.predictionsGenerated = generated.generated;
      report.predictionsPublished = generated.published;
      report.predictionsWithheld = generated.withheld;
    }

    if (options.settle !== false) {
      const settled = await settlePredictions(800);
      report.settled = settled.settled;
    }

    for (const provider of PROVIDERS) {
      // `updateMany` : certains fournisseurs ne sont jamais interrogés
      // (clé absente) et n'ont donc pas encore de ligne en base.
      await prisma.dataSource
        .updateMany({
          where: { name: provider.name },
          data: { lastSync: new Date(), errorCount: 0, lastError: null },
        })
        .catch(() => null);
    }
  } finally {
    running = false;
  }

  report.completedAt = new Date();
  report.durationMs = report.completedAt.getTime() - report.startedAt.getTime();
  return report;
}

/**
 * Sélectionne les rencontres à venir les plus pertinentes et génère leurs
 * prédictions. La sélection privilégie (§18) : suffisamment de données,
 * qualité statistique, stabilité, confiance élevée.
 */
export async function generateUpcomingPredictions(max = 120): Promise<{
  generated: number;
  published: number;
  withheld: number;
}> {
  const upcoming = await prisma.match.findMany({
    where: {
      status: "SCHEDULED",
      utcDate: { gt: new Date() },
    },
    orderBy: { utcDate: "asc" },
    take: max,
    select: { id: true },
  });

  let published = 0;
  let withheld = 0;
  let generated = 0;

  for (const match of upcoming) {
    try {
      const outcome = await generateAndPersist(match.id, { asOf: new Date() });
      if (outcome.status === "skipped") continue;
      generated += 1;
      if (outcome.status === "published") published += 1;
      else withheld += 1;
    } catch (error) {
      // Un match en échec ne doit jamais interrompre le lot complet.
      console.error(`[sync] prédiction impossible pour ${match.id}:`, (error as Error).message);
    }
  }

  return { generated, published, withheld };
}

/**
 * Rétro-remplit l'historique : génère des prédictions « à l'aveugle » pour des
 * matchs déjà joués, en n'utilisant QUE les données antérieures à chaque match
 * (cf. `buildMatchContext(..., asOf)`), puis les règle contre le résultat réel.
 *
 * C'est la seule manière honnête de mesurer une performance (§22). Aucune
 * prédiction n'est réécrite après coup.
 */
export async function backfillHistory(input: {
  limit?: number;
  leagueCode?: string;
  daysBack?: number;
} = {}): Promise<{ generated: number; published: number; settled: number; correct: number }> {
  const { limit = 300, leagueCode, daysBack = 120 } = input;

  const since = new Date(Date.now() - daysBack * 86_400_000);

  const matches = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      homeScore: { not: null },
      utcDate: { gte: since },
      ...(leagueCode ? { league: { shortName: leagueCode } } : {}),
      predictions: { none: { status: "SETTLED" } },
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    select: { id: true },
  });

  let generated = 0;
  let published = 0;

  for (const match of matches) {
    try {
      const outcome = await generateAndPersist(match.id, { asOf: undefined, force: true });
      if (outcome.status === "skipped") continue;
      generated += 1;
      if (outcome.status === "published") published += 1;
    } catch (error) {
      console.error(`[backfill] ${match.id}:`, (error as Error).message);
    }
  }

  const settled = await settlePredictions(matches.length + 50);
  return { generated, published, settled: settled.settled, correct: settled.correct };
}

async function ensureDataSource(name: string, displayName: string, baseUrl?: string) {
  const row = await prisma.dataSource.upsert({
    where: { name },
    create: {
      name,
      displayName,
      apiBaseUrl: baseUrl ?? null,
      priority: 1,
    },
    update: { displayName },
  });
  return row.id;
}

/** URL de base par fournisseur — purement informatif (dashboard admin §28). */
const PROVIDER_BASE_URLS: Record<string, string> = {
  "football-data-co-uk": "https://www.football-data.co.uk",
  thesportsdb: "https://www.thesportsdb.com/api/v1/json",
  "football-data-org": "https://api.football-data.org/v4",
};
