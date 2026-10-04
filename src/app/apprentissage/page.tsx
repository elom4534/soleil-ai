import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { pct, num } from "@/lib/utils";
import { analyseErrors, type DiagnosticRow } from "@/server/learning/diagnostics";
import { listVersions } from "@/server/learning/registry";
import { sortieHumaine } from "@/lib/learning-format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apprentissage" };

/**
 * ============================================================================
 * SOLEIL — §11 (Phase 15) · Mémoire des erreurs, vue interne
 * ============================================================================
 * Cette page est **interne**. Elle ne présente aucune prédiction à l'utilisateur :
 * elle montre ce que le modèle a appris de ses propres erreurs passées.
 *
 * Séparation tenue :
 *   · l'interface publique ne présente que des rencontres à venir ;
 *   · cette page ne présente que des rencontres déjà jouées, à des fins
 *     d'analyse, jamais comme des prédictions.
 */
export default async function LearningPage() {
  const [stored, versions] = await Promise.all([
    prisma.predictionError.findMany({ orderBy: { matchDate: "asc" } }),
    listVersions(10),
  ]);

  const rows: DiagnosticRow[] = stored.map((e) => ({
    error1x2: e.error1x2,
    errorOver25: e.errorOver25,
    errorBtts: e.errorBtts,
    errorTeamHome: e.errorTeamHome,
    errorTeamAway: e.errorTeamAway,
    brier: e.brier,
    logLoss: e.logLoss,
    hit: e.hit,
    pickProbability: e.pickProbability,
    biasHome: e.biasHome,
    biasOver25: e.biasOver25,
    biasBtts: e.biasBtts,
    competition: e.competition,
    season: e.season,
    confidence: e.confidence,
    dataGrade: e.dataGrade,
    xgUsed: e.xgUsed,
    expectedGoals: e.expectedGoals,
    favouriteSide: e.favouriteSide as "HOME" | "DRAW" | "AWAY",
  }));

  const diagnostics = analyseErrors(rows);
  const reference = diagnostics[0]?.reference;
  const withXg = rows.filter((r) => r.xgUsed).length;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Apprentissage"
        subtitle="Mémoire interne : ce que le modèle a mesuré sur ses prédictions déjà réglées."
      />

      <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3">
        <span className="mt-1 size-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          Page interne d&apos;analyse. Les rencontres ci-dessous sont <strong className="font-semibold text-fg">terminées</strong> :
          elles servent à mesurer les erreurs du modèle, jamais à lui faire une prédiction. Aucune
          prédiction déjà publiée n&apos;est modifiée rétroactivement.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardBody className="py-8 text-center">
            <p className="text-[13.5px] font-medium text-fg">Aucune erreur enregistrée</p>
            <p className="mx-auto mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-fg-muted">
              La mémoire d&apos;erreurs se remplit à partir des prédictions réglées. Lancez
              <code className="mx-1 rounded bg-bg-subtle px-1.5 py-0.5 text-[11.5px]">npx tsx scripts/learning-build.ts</code>
              pour l&apos;alimenter à partir des données locales (aucun crédit consommé).
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* ---------------------- Synthèse ---------------------- */}
          {reference ? (
            <Card>
              <CardHeader>
                <CardTitle>Synthèse mesurée</CardTitle>
                <p className="mt-1 text-[12px] text-fg-muted">
                  {reference.n} prédictions réglées · {withXg} avec xG utilisé · les deux scores
                  sont calculés sur le 1X2 publié.
                </p>
              </CardHeader>
              <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Brier (1X2)" value={reference.brier.toFixed(4)} hint="0 = parfait, 2 = pire" />
                <Metric label="Log Loss" value={reference.logLoss.toFixed(4)} hint="0 = parfait" />
                <Metric label="Réussite" value={pct(reference.hitRate, 1)} hint="issue publiée exacte" />
                <Metric
                  label="Calibration"
                  value={`${(reference.calibration * 100).toFixed(2)} pt`}
                  hint="écart moyen annoncé / observé"
                />
              </CardBody>
            </Card>
          ) : null}

          {/* ---------------------- Diagnostics ---------------------- */}
          {diagnostics.map((diagnostic) => (
            <Card key={diagnostic.family}>
              <CardHeader>
                <CardTitle>{diagnostic.title}</CardTitle>
                <p className="mt-1 text-[12px] text-fg-muted">{diagnostic.question}</p>
              </CardHeader>
              <CardBody className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-[12.5px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[11px] tracking-wide text-fg-subtle uppercase">
                        <th className="py-1.5 pr-2 font-medium">Groupe</th>
                        <th className="px-2 py-1.5 text-right font-medium">n</th>
                        <th className="px-2 py-1.5 text-right font-medium">Brier</th>
                        <th className="px-2 py-1.5 text-right font-medium">Log Loss</th>
                        <th className="px-2 py-1.5 text-right font-medium">Réussite</th>
                        <th className="px-2 py-1.5 text-right font-medium">Biais 1</th>
                        <th className="px-2 py-1.5 text-right font-medium">Biais O 2,5</th>
                        <th className="px-2 py-1.5 text-right font-medium">Biais BTTS</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {diagnostic.groups.map((group) => (
                        <tr key={group.group} className="border-b border-border-subtle/60 last:border-0">
                          <td className="py-1.5 pr-2 text-fg">{group.group}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{group.n}</td>
                          <td className="px-2 py-1.5 text-right text-fg">{group.brier.toFixed(4)}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{group.logLoss.toFixed(4)}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{pct(group.hitRate, 1)}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{signed(group.biasHome)}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{signed(group.biasOver25)}</td>
                          <td className="px-2 py-1.5 text-right text-fg-muted">{signed(group.biasBtts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[12px] leading-relaxed text-fg-subtle">{diagnostic.reading}</p>
              </CardBody>
            </Card>
          ))}

          {/* ---------------------- Versions ---------------------- */}
          <Card>
            <CardHeader>
              <CardTitle>Versions du modèle</CardTitle>
              <p className="mt-1 text-[12px] text-fg-muted">
                Chaque prédiction conserve la version qui l&apos;a produite. L&apos;historique
                n&apos;est jamais écrasé : une version change d&apos;état, jamais de contenu.
              </p>
            </CardHeader>
            <CardBody className="space-y-3">
              {versions.map((version) => (
                <div
                  key={version.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-subtle px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12.5px] font-medium text-fg">{version.label}</p>
                    <p className="mt-0.5 text-[11.5px] text-fg-muted">
                      modèle {version.modelVersion} · 1X2 {version.outcomeSource} · poids xG{" "}
                      {num(version.xgWeight, 2)} · données {version.dataSnapshot}
                    </p>
                  </div>
                  <Badge
                    variant={
                      version.status === "ACTIVE"
                        ? "success"
                        : version.status === "ROLLED_BACK"
                          ? "danger"
                          : "outline"
                    }
                  >
                    {sortieHumaine(version.status)}
                  </Badge>
                </div>
              ))}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-bg-subtle px-3 py-2.5">
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums text-fg">{value}</p>
      <p className="mt-0.5 text-[10.5px] text-fg-subtle">{hint}</p>
    </div>
  );
}

function signed(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
}
