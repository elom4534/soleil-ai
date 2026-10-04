import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

/**
 * Indicateur de qualité des données (§8).
 *
 * Le grade provient du moteur (`DataQualityReport.grade`) : il n'est jamais
 * recalculé ni « arrondi vers le haut » à l'affichage. Ce composant se
 * contente de le traduire en trois états lisibles par un utilisateur.
 */

export type QualityState = "complete" | "partial" | "insufficient";

const STATE_BY_GRADE: Record<string, QualityState> = {
  EXCELLENT: "complete",
  GOOD: "complete",
  MEDIUM: "partial",
  LOW: "partial",
  INSUFFICIENT: "insufficient",
};

export const QUALITY_STATES: Record<
  QualityState,
  { label: string; description: string; tone: string; dot: string; badge: "success" | "warning" | "danger" }
> = {
  complete: {
    label: "Données complètes",
    description: "Bonne couverture des données disponibles.",
    tone: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    badge: "success",
  },
  partial: {
    label: "Données partielles",
    description: "Certaines informations sont manquantes.",
    tone: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    badge: "warning",
  },
  insufficient: {
    label: "Données insuffisantes",
    description:
      "Le moteur ne publie pas de prédiction lorsque l'historique disponible ne permet pas d'estimer les probabilités de façon fiable.",
    tone: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
    badge: "danger",
  },
};

export function qualityState(grade: string | null | undefined): QualityState {
  return STATE_BY_GRADE[grade ?? ""] ?? "partial";
}

/** Version compacte — une pastille, un libellé. Utilisée sur les cartes. */
export function DataQualityDot({
  grade,
  className,
}: {
  grade: string | null | undefined;
  className?: string;
}) {
  const state = QUALITY_STATES[qualityState(grade)];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", state.tone, className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
      <span className="font-medium">{state.label}</span>
    </span>
  );
}

/** Version détaillée — utilisée sur la fiche match. */
export function DataQualityPanel({
  grade,
  score,
  sources,
}: {
  grade: string | null | undefined;
  score?: number | null;
  sources?: { name: string; lastUpdate: string | Date | null }[];
}) {
  const key = qualityState(grade);
  const state = QUALITY_STATES[key];
  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", state.dot)} />
        <div className="min-w-0">
          <p className={cn("text-[13.5px] font-semibold", state.tone)}>{state.label}</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{state.description}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {typeof score === "number" ? (
          <Badge variant="outline" className="tabular-nums">
            Couverture {score} / 100
          </Badge>
        ) : null}
        {sources?.length ? (
          <Badge variant="outline">
            {sources.length} source{sources.length > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>

      {sources?.length ? (
        <ul className="space-y-1 pt-0.5">
          {sources.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="truncate text-fg-muted">{s.name}</span>
              <span className="shrink-0 tabular-nums text-fg-subtle">
                {s.lastUpdate ? new Date(s.lastUpdate).toLocaleDateString("fr-FR") : "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
