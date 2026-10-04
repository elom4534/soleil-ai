import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ProbabilityBar } from "@/components/ui/ProgressBar";
import { CalibrationChart } from "@/components/charts/CalibrationChart";
import { computePerformance } from "@/server/predictions/service";
import { cn, pct, num } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Performance" };

export default async function PerformancePage() {
  const perf = await computePerformance();

  if (!perf) {
    return (
      <div className="space-y-5">
        <SectionHeader title="SOLEIL Performance" />
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[14px] font-medium text-fg">Aucune prédiction réglée</p>
            <p className="mx-auto mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-fg-muted">
              SOLEIL n&apos;affiche aucune statistique de performance tant qu&apos;aucune
              prédiction publiée n&apos;a été comparée à un résultat réel. Les métriques ne sont
              jamais estimées ni extrapolées.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const window = perf.window;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="SOLEIL Performance"
        subtitle="Mesurée uniquement sur des prédictions publiées avant le coup d'envoi, jamais réécrites."
      />

      {/* Métriques principales */}
      <Card>
        <CardBody className="grid grid-cols-2 gap-5 py-5 sm:grid-cols-4">
          <Metric label="Prédictions réglées" value={perf.sample.toString()} />
          <Metric label="Taux de réussite 1X2" value={pct(perf.accuracy, 1)} accent />
          <Metric
            label="Brier Score"
            value={num(perf.brierScore, 4)}
            hint="Référence aléatoire : 0,6667"
          />
          <Metric
            label="Log Loss"
            value={num(perf.logLoss, 4)}
            hint="Référence aléatoire : 1,0986"
          />
        </CardBody>
        {window ? (
          <div className="border-t border-border-subtle px-4 py-2.5 sm:px-5">
            <p className="text-[11.5px] text-fg-subtle">
              Période couverte : du {window.from.toLocaleDateString("fr-FR")} au{" "}
              {window.to.toLocaleDateString("fr-FR")}
            </p>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Calibration */}
        <Card>
          <CardHeader>
            <CardTitle>Calibration</CardTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Une probabilité annoncée à 60 % doit se réaliser environ 6 fois sur 10. Plus les
              points sont proches de la diagonale, plus les probabilités sont fiables.
            </p>
          </CardHeader>
          <CardBody>
            <CalibrationChart points={perf.calibration} />
            {perf.calibration.length > 0 ? (
              <p className="mt-3 text-center text-[11.5px] text-fg-subtle">
                {perf.calibration.reduce((a, c) => a + c.count, 0)} prédictions réparties sur{" "}
                {perf.calibration.length} intervalles
              </p>
            ) : null}
          </CardBody>
        </Card>

        {/* Par bande de confiance */}
        <Card>
          <CardHeader>
            <CardTitle>Performance par niveau de confiance</CardTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Vérification directe : un score de confiance élevé doit correspondre à un taux de
              réussite supérieur.
            </p>
          </CardHeader>
          <CardBody className="space-y-3">
            {perf.byConfidence.map((b) => (
              <div key={b.band}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium text-fg">{b.band}</span>
                  <span className="text-[12px] tabular-nums text-fg-muted">
                    {pct(b.accuracy, 1)}{" "}
                    <span className="text-fg-subtle">· n={b.sample}</span>
                  </span>
                </div>
                <ProbabilityBar
                  value={b.accuracy}
                  height={6}
                  className="mt-1.5"
                  color="var(--color-astro-500)"
                />
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      {/* Classement des modèles (§24) */}
      <Card>
        <CardHeader>
          <CardTitle>Classement des modèles</CardTitle>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
            Chaque modèle est évalué sur exactement les mêmes rencontres. Un modèle absent du lot
            apparaît comme non applicable plutôt qu&apos;avec un score calculé sur un autre
            échantillon.
          </p>
        </CardHeader>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-fg-subtle">
                  <th className="px-4 py-2.5 font-medium sm:px-5">Modèle</th>
                  <th className="px-3 py-2.5 text-right font-medium">n</th>
                  <th className="px-3 py-2.5 text-right font-medium">Exactitude</th>
                  <th className="px-3 py-2.5 text-right font-medium">Brier</th>
                  <th className="px-4 py-2.5 text-right font-medium sm:px-5">Log Loss</th>
                </tr>
              </thead>
              <tbody>
                {perf.byModel.map((m) => (
                  <tr key={m.name} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5 sm:px-5">
                      <span className={cn("font-medium", m.applicable ? "text-fg" : "text-fg-subtle")}>
                        {m.label}
                      </span>
                      {!m.applicable ? (
                        <Badge variant="outline" className="ml-2">
                          Non applicable
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{m.sample || "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg">
                      {m.applicable ? pct(m.accuracy, 1) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">
                      {m.brierScore !== null ? num(m.brierScore, 4) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted sm:px-5">
                      {m.logLoss !== null ? num(m.logLoss, 4) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Performance par marché</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {perf.byMarket.length > 0 ? (
              perf.byMarket.map((m) => (
                <div key={m.market}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12.5px] font-medium text-fg">{m.market}</span>
                    <span className="text-[12px] tabular-nums text-fg-muted">
                      {pct(m.accuracy, 1)} <span className="text-fg-subtle">· n={m.sample}</span>
                    </span>
                  </div>
                  <ProbabilityBar value={m.accuracy} height={6} className="mt-1.5" />
                </div>
              ))
            ) : (
              <p className="text-[12.5px] text-fg-subtle">Donnée indisponible</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Performance par compétition</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {perf.byLeague.map((l) => (
              <div key={l.league}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium text-fg">{l.league}</span>
                  <span className="text-[12px] tabular-nums text-fg-muted">
                    {pct(l.accuracy, 1)} <span className="text-fg-subtle">· n={l.sample}</span>
                  </span>
                </div>
                <ProbabilityBar value={l.accuracy} height={6} className="mt-1.5" color="var(--color-soleil-500)" />
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <p className="pt-1 text-center text-[11px] leading-relaxed text-fg-subtle">
        Les prédictions sont enregistrées avant le coup d&apos;envoi et ne sont jamais modifiées
        rétroactivement. Seul le verdict (correct / incorrect) et le Brier Score sont ajoutés après
        la rencontre.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-[11.5px] text-fg-subtle">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-[21px] font-semibold tabular-nums",
          accent ? "text-soleil-600 dark:text-soleil-400" : "text-fg",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[10.5px] text-fg-subtle">{hint}</p> : null}
    </div>
  );
}
