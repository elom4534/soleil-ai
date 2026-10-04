import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { listMatches, listLeagues } from "@/server/predictions/queries";
import { cn, pct, num } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analyses" };

/**
 * Page Analyses (§19/§27) — vue comparative par compétition.
 * Elle agrège uniquement des prédictions réellement stockées.
 */
export default async function AnalysesPage() {
  const leagues = await listLeagues();

  const perLeague = await Promise.all(
    leagues.slice(0, 12).map(async (league) => {
      const matches = await listMatches({
        leagueId: league.id,
        onlyWithPredictions: true,
        limit: 200,
      });
      const preds = matches.map((m) => m.predictions[0]).filter(Boolean);
      const avgConfidence =
        preds.length > 0
          ? preds.reduce((a, p) => a + p!.confidenceScore, 0) / preds.length
          : null;
      const avgGoals = preds
        .map((p) => p!.totalGoals?.expectedGoals)
        .filter((v): v is number => typeof v === "number");
      const avgOver25 = preds
        .map((p) => p!.totalGoals?.ou25Over)
        .filter((v): v is number => typeof v === "number");
      const avgBtts = preds
        .map((p) => p!.btts?.yesProb)
        .filter((v): v is number => typeof v === "number");

      return {
        league,
        sample: preds.length,
        avgConfidence,
        avgGoals: avgGoals.length > 0 ? avgGoals.reduce((a, b) => a + b, 0) / avgGoals.length : null,
        avgOver25:
          avgOver25.length > 0 ? avgOver25.reduce((a, b) => a + b, 0) / avgOver25.length : null,
        avgBtts: avgBtts.length > 0 ? avgBtts.reduce((a, b) => a + b, 0) / avgBtts.length : null,
      };
    }),
  );

  const active = perLeague.filter((l) => l.sample > 0);
  const globalGoals =
    active.map((l) => l.avgGoals).filter((v): v is number => v !== null);
  const globalOver25 = active.map((l) => l.avgOver25).filter((v): v is number => v !== null);

  return (
    <div className="space-y-5">
      {/* §11 (Phase 15) — séparation des deux mondes : cette page agrège des
          prédictions déjà réglées à des fins d'analyse. Ce n'est pas une liste
          de rencontres à jouer ; les prédictions à venir sont sur /matchs. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-subtle px-3.5 py-3">
        <span className="mt-1 size-2 shrink-0 rounded-full bg-astro-500" aria-hidden="true" />
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          Vue statistique interne, calculée sur les prédictions déjà réglées. Ce n&apos;est pas une
          liste de rencontres à venir : celles-ci se trouvent sur{" "}
          <Link href="/matchs" className="font-medium text-soleil-600 hover:underline dark:text-soleil-400">
            la page Matchs à venir
          </Link>
          .
        </p>
      </div>

      <SectionHeader
        title="Analyses"
        subtitle="Comparaison des profils de jeu estimés par le moteur, compétition par compétition."
      />

      {active.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[14px] font-medium text-fg">Aucune analyse disponible</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-fg-muted">
              Les analyses s&apos;appuient exclusivement sur des prédictions générées. Lancez une
              synchronisation pour alimenter la plateforme.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardBody className="grid grid-cols-2 gap-5 py-5 sm:grid-cols-3">
              <div>
                <p className="text-[11.5px] text-fg-subtle">Buts attendus moyens</p>
                <p className="mt-1 font-mono text-[21px] font-semibold tabular-nums text-fg">
                  {globalGoals.length > 0
                    ? num(globalGoals.reduce((a, b) => a + b, 0) / globalGoals.length)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-[11.5px] text-fg-subtle">Probabilité Over 2.5 moyenne</p>
                <p className="mt-1 font-mono text-[21px] font-semibold tabular-nums text-fg">
                  {globalOver25.length > 0
                    ? pct(globalOver25.reduce((a, b) => a + b, 0) / globalOver25.length, 1)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-[11.5px] text-fg-subtle">Prédictions analysées</p>
                <p className="mt-1 font-mono text-[21px] font-semibold tabular-nums text-fg">
                  {active.reduce((a, l) => a + l.sample, 0)}
                </p>
              </div>
            </CardBody>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            {active.map((item) => (
              <Card key={item.league.id}>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>{item.league.name}</CardTitle>
                  <Badge variant="outline" className="tabular-nums">
                    n={item.sample}
                  </Badge>
                </CardHeader>
                <CardBody className="space-y-2.5 pb-4">
                  <Row label="Buts attendus moyens" value={item.avgGoals !== null ? num(item.avgGoals) : "—"} />
                  <Row label="Over 2.5 moyen" value={item.avgOver25 !== null ? pct(item.avgOver25, 1) : "—"} />
                  <Row label="BTTS moyen" value={item.avgBtts !== null ? pct(item.avgBtts, 1) : "—"} />
                  <Row
                    label="Confiance moyenne"
                    value={item.avgConfidence !== null ? `${item.avgConfidence.toFixed(1)}/100` : "—"}
                    accent
                  />
                  <Link
                    href={`/matchs?ligue=${item.league.id}`}
                    className="mt-1 inline-block text-[12.5px] font-medium text-soleil-600 hover:underline dark:text-soleil-400"
                  >
                    Voir les matchs →
                  </Link>
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12.5px] text-fg-muted">{label}</span>
      <span
        className={cn(
          "font-mono text-[13px] font-semibold tabular-nums",
          accent ? "text-soleil-600 dark:text-soleil-400" : "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}
