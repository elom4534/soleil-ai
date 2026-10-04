import { Info, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn, num, pct } from "@/lib/utils";
import type { PredictionView } from "@/server/predictions/presenter";

/**
 * Blocs de marchés de la fiche match (§5, §7, §10).
 *
 * Règle commune : une donnée absente est déclarée absente. Aucune valeur
 * n'est reconstruite, extrapolée ou « complétée ».
 */

/* -------------------------------------------------------------------------- */
/* §7 — xG                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Affiche les xG **produits par le modèle xG** pour cette rencontre, et
 * uniquement lorsque ce modèle s'est réellement exécuté sur des données xG
 * observées. Sinon, la mention exacte « xG indisponible pour cette rencontre ».
 *
 * Le modèle xG n'est pas reconstruit à partir de tirs ou de buts : s'il ne
 * dispose pas de xG réels, il est exclu du consensus et cette carte le dit.
 */
export function XgBlock({
  view,
  homeName,
  awayName,
}: {
  view: PredictionView;
  homeName: string;
  awayName: string;
}) {
  const model = view.models.find((m) => m.name === "xg");
  const available = Boolean(model?.applicable && model.expectedGoals);

  return (
    <Card>
      <CardHeader>
        <CardTitle>xG — expected goals</CardTitle>
        <p className="mt-1 text-[12px] text-fg-muted">
          Buts attendus estimés à partir des xG observés des deux équipes.
        </p>
      </CardHeader>
      <CardBody>
        {available && model?.expectedGoals ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <XgValue label={homeName} value={model.expectedGoals.home} side="Domicile" />
              <XgValue label={awayName} value={model.expectedGoals.away} side="Extérieur" />
            </div>
            <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-fg-subtle">
              <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              Les xG sont intégrés au modèle lorsqu&apos;ils sont disponibles. Ils proviennent de la
              source live-football-api et n&apos;ont pas été vérifiés par une seconde source
              indépendante.
            </p>
          </>
        ) : (
          <div className="flex items-start gap-2.5">
            <XCircle className="mt-0.5 size-4 shrink-0 text-fg-subtle" strokeWidth={2} />
            <div>
              <p className="text-[13px] font-medium text-fg">xG indisponible pour cette rencontre</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                {model?.unavailableReason ??
                  "Aucun xG observé n'est disponible pour ces deux équipes."}{" "}
                Le modèle xG est exclu du consensus ; aucun xG n&apos;est reconstruit à partir des
                tirs ou des buts.
              </p>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function XgValue({ label, value, side }: { label: string; value: number; side: string }) {
  return (
    <div className="rounded-xl bg-bg-subtle px-3 py-2.5">
      <p className="truncate text-[11px] text-fg-subtle">{side}</p>
      <p className="mt-0.5 truncate text-[12.5px] font-medium text-fg-muted">{label}</p>
      <p className="mt-1 font-mono text-[22px] leading-none font-semibold tabular-nums text-fg">
        {num(value)}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* §10 — Marchés de mi-temps                                                   */
/* -------------------------------------------------------------------------- */

/** Couverture minimale exigée pour publier un marché de mi-temps. */
export const HALF_TIME_MIN_COVERAGE = 0.6;
export const HALF_TIME_MIN_SAMPLE = 10;

export function halfTimeIsUsable(coverage: {
  sample: number;
  withScore: number;
  ratio: number;
}): boolean {
  return coverage.sample >= HALF_TIME_MIN_SAMPLE && coverage.ratio >= HALF_TIME_MIN_COVERAGE;
}

/**
 * Marchés de mi-temps, ou explication de leur absence.
 *
 * Le moteur dérive toujours une intensité par période à partir de la part de
 * buts observée en 1re mi-temps dans la compétition. Si les rencontres
 * réelles de ces deux équipes ne portent pas de score à la mi-temps, la
 * couverture n'est pas suffisante : on n'affiche alors aucune prédiction de
 * mi-temps plutôt qu'une estimation fragile.
 */
export function HalfTimeBlock({
  view,
  coverage,
}: {
  view: PredictionView;
  coverage: { sample: number; withScore: number; ratio: number };
}) {
  const usable = halfTimeIsUsable(coverage);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mi-temps</CardTitle>
        <p className="mt-1 text-[12px] text-fg-muted">
          {usable
            ? "Probabilités de buts sur chaque période, dérivées de la répartition observée."
            : "Marchés conditionnés à la disponibilité de scores de mi-temps réels."}
        </p>
      </CardHeader>
      <CardBody className="space-y-4">
        {!usable ? (
          <div className="flex items-start gap-2.5">
            <XCircle className="mt-0.5 size-4 shrink-0 text-fg-subtle" strokeWidth={2} />
            <div>
              <p className="text-[13px] font-medium text-fg">
                Marché indisponible — données historiques insuffisantes.
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                Seules {coverage.withScore} des {coverage.sample} dernières rencontres de ces deux
                équipes portent un score à la mi-temps (
                {pct(coverage.ratio, 0)} de couverture). Les scores de mi-temps ne sont jamais
                reconstruits.
              </p>
            </div>
          </div>
        ) : (
          <>
            {([view.halfTime.firstHalf, view.halfTime.secondHalf] as const).map((half, i) => (
              <div key={i}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-fg">
                    {i === 0 ? "Première mi-temps" : "Deuxième mi-temps"}
                  </span>
                  <span className="text-[12px] tabular-nums text-fg-muted">
                    {num(half.expectedGoals)} buts attendus · ≥ 1 but {pct(half.probAtLeastOneGoal, 1)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {half.overUnder.map((l) => (
                    <div key={l.line} className="rounded-lg bg-bg-subtle px-2.5 py-2 text-center">
                      <p className="text-[10.5px] text-fg-subtle">Over {l.line}</p>
                      <p className="mt-0.5 font-mono text-[13.5px] font-semibold tabular-nums text-fg">
                        {pct(l.over, 1)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-[11.5px] leading-relaxed text-fg-subtle">
              Couverture des scores de mi-temps : {coverage.withScore} / {coverage.sample}{" "}
              rencontres réelles ({pct(coverage.ratio, 0)}). Les scores de mi-temps utilisés sont
              observés, jamais reconstruits.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* §5 — Scores exacts les plus probables                                       */
/* -------------------------------------------------------------------------- */

const MEDALS = ["1er", "2e", "3e", "4e", "5e", "6e", "7e", "8e"];

/** Au moins cinq scores, avec leur probabilité — jamais un seul. */
export function ExactScoreBlock({ view }: { view: PredictionView }) {
  const top = (view.exactScore.top ?? []).slice(0, 8);
  const max = Math.max(...top.map((s) => s.probability), 1e-9);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scores exacts les plus probables</CardTitle>
        <p className="mt-1 text-[12px] text-fg-muted">
          Probabilités issues de la distribution complète des scores. Le score le plus probable reste
          minoritaire : il ne désigne pas le score attendu avec certitude.
        </p>
      </CardHeader>
      <CardBody className="space-y-2">
        {top.length === 0 ? (
          <p className="text-[12.5px] text-fg-subtle">Donnée indisponible pour cette rencontre.</p>
        ) : (
          top.map((score, i) => (
            <div key={score.score} className="flex items-center gap-3">
              <span className="w-8 shrink-0 text-[11px] font-medium tabular-nums text-fg-subtle">
                {MEDALS[i] ?? `${i + 1}e`}
              </span>
              <span className="w-12 shrink-0 font-mono text-[14px] font-semibold tabular-nums text-fg">
                {score.score}
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-inset">
                <span
                  className={cn(
                    "block h-full rounded-full",
                    i === 0 ? "bg-soleil-500" : "bg-astro-500/70",
                  )}
                  style={{ width: `${(score.probability / max) * 100}%` }}
                />
              </span>
              <span className="w-12 shrink-0 text-right font-mono text-[12.5px] font-semibold tabular-nums text-fg">
                {pct(score.probability, 1)}
              </span>
            </div>
          ))
        )}
        {view.exactScore.disclaimer ? (
          <p className="pt-1.5 text-[11.5px] leading-relaxed text-fg-subtle">
            {view.exactScore.disclaimer}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
