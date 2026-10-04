/**
 * ============================================================================
 * SOLEIL — Phase 16 · §20, §24, §26 · État de l'ordonnanceur
 * ============================================================================
 * Point de supervision unique : quelles tâches existent, quand passent-elles,
 * qu'ont-elles fait la dernière fois, combien ont-elles coûté, et quand la
 * donnée affichée a-t-elle été mise à jour.
 *
 * 🔒 Cette route ne contacte **aucun** fournisseur : elle ne lit que la base
 * (résultats d'exécution, compteurs, journal). L'ouvrir ne coûte rien et ne
 * peut rien coûter — c'est la contrepartie de §24 (« pas d'appel fournisseur à
 * l'ouverture d'une page »).
 *
 * La réponse porte systématiquement `retrievedAt` : l'interface peut donc
 * afficher « données mises à jour récemment » sans jamais mentir (§20).
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { JOBS, lastRun, networkAllowed, networkRefusalReason, totalDailyCredits } from "@/server/schedule/jobs";
import { describeCron, nextRun, parseCron } from "@/server/schedule/cron";

export const dynamic = "force-dynamic";

interface JobStatus {
  id: string;
  label: string;
  purpose: string;
  schedule: string;
  scheduleLabel: string;
  nextRun: string | null;
  usesNetwork: boolean;
  estimatedCredits: number;
  lastRun: {
    at: string;
    ok: boolean;
    durationMs: number;
    creditsSpent: number;
    summary: string;
  } | null;
}

export async function GET() {
  const now = new Date();
  const retrievedAt = now.toISOString();

  const statuses: JobStatus[] = [];
  for (const job of JOBS) {
    const record = await lastRun(job.id);
    statuses.push({
      id: job.id,
      label: job.label,
      purpose: job.purpose,
      schedule: job.schedule,
      scheduleLabel: describeCron(job.schedule),
      nextRun: nextRun(parseCron(job.schedule), now)?.toISOString() ?? null,
      usesNetwork: job.usesNetwork,
      estimatedCredits: job.estimatedCredits,
      lastRun: record
        ? {
            at: record.completedAt,
            ok: record.ok,
            durationMs: record.durationMs,
            creditsSpent: record.creditsSpent,
            summary: record.summary,
          }
        : null,
    });
  }

  const [matches, upcoming, published, logos, assets, lastSync, lastApiCall] = await Promise.all([
    prisma.match.count(),
    prisma.match.count({ where: { status: "SCHEDULED", utcDate: { gt: now } } }),
    prisma.prediction.count({ where: { status: "PUBLISHED" } }),
    prisma.team.count({ where: { crest: { not: null } } }),
    prisma.assetCache.count(),
    prisma.dataSyncLog.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true, status: true, entityCount: true } }),
    prisma.apiCallLog.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true, provider: true, endpoint: true, cost: true, statusCode: true, fromCache: true } }),
  ]);

  return NextResponse.json({
    retrievedAt,
    // Ce qui est affiché à l'utilisateur aujourd'hui, et depuis quand.
    data: {
      matchesTotal: matches,
      matchesUpcoming: upcoming,
      predictionsPublished: published,
      teamsWithLogo: logos,
      logoAssetsCached: assets,
      lastSync: lastSync
        ? { at: lastSync.startedAt.toISOString(), status: lastSync.status, entityCount: lastSync.entityCount }
        : null,
      lastProviderCall: lastApiCall
        ? {
            at: lastApiCall.createdAt.toISOString(),
            provider: lastApiCall.provider,
            endpoint: lastApiCall.endpoint,
            cost: lastApiCall.cost,
            statusCode: lastApiCall.statusCode,
            fromCache: lastApiCall.fromCache,
          }
        : null,
    },
    scheduler: {
      jobs: statuses,
      networkOpen: networkAllowed(),
      networkClosedReason: networkAllowed() ? null : networkRefusalReason(),
      maxDailyCredits: totalDailyCredits(now),
    },
  });
}
