import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ProbabilityBar } from "@/components/ui/ProgressBar";
import { getAdminOverview } from "@/server/predictions/queries";
import { PROVIDERS } from "@/server/data/providers";
import { cn, num } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "default"> = {
  SUCCESS: "success",
  PARTIAL: "warning",
  FAILED: "danger",
  STARTED: "default",
};

export default async function AdminPage() {
  const overview = await getAdminOverview();

  const totalPredictions = overview.predictionStats.reduce((a, s) => a + s._count._all, 0);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Tableau de bord"
        subtitle="Surveillance des sources, des synchronisations, des modèles et de la qualité des données."
      />

      {/* Sources */}
      <Card>
        <CardHeader>
          <CardTitle>Fournisseurs de données</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            Architecture multi-source : un fournisseur peut être remplacé ou retiré sans modifier le
            reste de l&apos;application.
          </p>
        </CardHeader>
        <CardBody className="space-y-2.5 pb-4">
          {PROVIDERS.map((provider) => {
            const row = overview.sources.find((s) => s.name === provider.name);
            const configured = provider.isConfigured();
            return (
              <div
                key={provider.name}
                className="rounded-xl border border-border-subtle px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg">{provider.displayName}</p>
                    <p className="mt-0.5 text-[11px] text-fg-subtle">
                      Priorité {provider.priority}
                      {provider.rateLimitPerMinute
                        ? ` · ${provider.rateLimitPerMinute} req/min`
                        : " · limite non documentée"}
                    </p>
                  </div>
                  <Badge variant={configured ? "success" : "outline"}>
                    {configured ? "Actif" : "Non configuré"}
                  </Badge>
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Capability label="Résultats" ok={provider.capabilities.results} />
                  <Capability label="Calendrier" ok={provider.capabilities.fixtures} />
                  <Capability label="Stats détaillées" ok={provider.capabilities.matchStats} />
                  <Capability label="xG" ok={provider.capabilities.xg} />
                  <Capability label="Score mi-temps" ok={provider.capabilities.halfTimeScores} />
                </div>

                <p className="mt-2 text-[11px] text-fg-subtle">
                  Dernière synchronisation :{" "}
                  {row?.lastSync
                    ? new Date(row.lastSync).toLocaleString("fr-FR")
                    : "jamais"}
                  {row?.errorCount ? ` · ${row.errorCount} erreur(s)` : ""}
                </p>
              </div>
            );
          })}
        </CardBody>
      </Card>

      {/* Prédictions par statut */}
      <Card>
        <CardHeader>
          <CardTitle>Prédictions</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">{totalPredictions} enregistrements au total</p>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4 pb-4 sm:grid-cols-4">
          {(["PUBLISHED", "SETTLED", "GENERATED", "EXPIRED"] as const).map((status) => {
            const row = overview.predictionStats.find((s) => s.status === status);
            return (
              <div key={status}>
                <p className="text-[11.5px] text-fg-subtle">{STATUS_LABEL[status]}</p>
                <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-fg">
                  {row?._count._all ?? 0}
                </p>
                {row?._avg.confidenceScore !== null && row?._avg.confidenceScore !== undefined ? (
                  <p className="text-[10.5px] text-fg-subtle">
                    confiance moy. {row._avg.confidenceScore.toFixed(1)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </CardBody>
      </Card>

      {/* Modèles */}
      <Card>
        <CardHeader>
          <CardTitle>Utilisation des modèles</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            Nombre de sorties produites et poids moyen attribué par l&apos;ensemble.
          </p>
        </CardHeader>
        <CardBody className="space-y-3 pb-4">
          {overview.modelRows.length > 0 ? (
            overview.modelRows.map((m) => (
              <div key={m.modelName}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium text-fg">{m.modelName}</span>
                  <span className="text-[11.5px] tabular-nums text-fg-muted">
                    {m._count._all} sorties · poids moy. {num((m._avg.weight ?? 0) * 100, 1)} %
                  </span>
                </div>
                <ProbabilityBar value={m._avg.weight ?? 0} height={5} className="mt-1.5" />
              </div>
            ))
          ) : (
            <p className="text-[12.5px] text-fg-subtle">Donnée indisponible</p>
          )}
        </CardBody>
      </Card>

      {/* Anomalies & qualité */}
      <Card>
        <CardHeader>
          <CardTitle>Prédictions à surveiller</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            Qualité de données faible ou confiance insuffisante — ces prédictions ne sont pas
            publiées.
          </p>
        </CardHeader>
        <CardBody className="p-0 pb-1">
          {overview.anomalies.length > 0 ? (
            <ul>
              {overview.anomalies.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0 sm:px-5"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                    {a.match.homeTeam.name} – {a.match.awayTeam.name}
                  </span>
                  <Badge variant={a.dataQuality === "INSUFFICIENT" ? "danger" : "warning"}>
                    {a.dataQuality}
                  </Badge>
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-fg-muted">
                    {a.confidenceScore}/100
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-[12.5px] text-fg-subtle sm:px-5">
              Aucune anomalie détectée sur les dernières prédictions.
            </p>
          )}
        </CardBody>
      </Card>

      {/* Journal des synchronisations */}
      <Card>
        <CardHeader>
          <CardTitle>Journal des synchronisations</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            {overview.cacheRows} entrées en cache actives
          </p>
        </CardHeader>
        <CardBody className="p-0 pb-1">
          {overview.lastLogs.length > 0 ? (
            <ul>
              {overview.lastLogs.map((log) => (
                <li
                  key={log.id}
                  className="border-b border-border-subtle px-4 py-2.5 last:border-0 sm:px-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                      {log.dataSource.displayName} · {log.entityType}
                    </span>
                    <Badge variant={STATUS_TONE[log.status] ?? "default"}>{log.status}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] tabular-nums text-fg-subtle">
                    {new Date(log.startedAt).toLocaleString("fr-FR")} ·{" "}
                    {log.entityCount} entité(s)
                    {log.durationMs ? ` · ${(log.durationMs / 1000).toFixed(1)} s` : ""}
                  </p>
                  {log.errorMessage ? (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-orange-600 dark:text-orange-400">
                      {log.errorMessage}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-[12.5px] text-fg-subtle sm:px-5">
              Aucune synchronisation enregistrée. Lancez <code className="font-mono">npm run sync</code>.
            </p>
          )}
        </CardBody>
      </Card>

      <p className="text-center text-[11px] leading-relaxed text-fg-subtle">
        Accès administrateur : les routes sensibles doivent être protégées par le contrôle de rôle
        (ADMIN / SUPER_ADMIN) avant toute mise en production. Les clés d&apos;API restent
        exclusivement côté serveur (§30).
      </p>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  PUBLISHED: "Publiées",
  SETTLED: "Réglées",
  GENERATED: "Retenues",
  EXPIRED: "Expirées",
};

function Capability({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        ok
          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
          : "bg-bg-inset text-fg-subtle line-through",
      )}
    >
      {label}
    </span>
  );
}
