import { cn } from "@/lib/utils";

/**
 * Diagramme de calibration (§22) : probabilité annoncée vs fréquence observée.
 * Un modèle parfaitement calibré se situe sur la diagonale.
 */
export function CalibrationChart({
  points,
  className,
}: {
  points: { bin: string; predicted: number; observed: number; count: number }[];
  className?: string;
}) {
  if (points.length === 0) {
    return (
      <p className={cn("py-6 text-center text-[13px] text-fg-subtle", className)}>
        Donnée indisponible — aucune prédiction réglée sur cet intervalle.
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="relative aspect-square w-full max-w-[280px] mx-auto">
        <svg viewBox="0 0 100 100" className="size-full overflow-visible">
          {/* Grille */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={v} y1="100" x2={v} y2="0" stroke="var(--border)" strokeWidth="0.4" />
              <line x1="0" y1={100 - v} x2="100" y2={100 - v} stroke="var(--border)" strokeWidth="0.4" />
            </g>
          ))}
          {/* Diagonale de calibration parfaite */}
          <line
            x1="0"
            y1="100"
            x2="100"
            y2="0"
            stroke="var(--fg-subtle)"
            strokeWidth="0.8"
            strokeDasharray="3 3"
          />
          {/* Points observés */}
          {points.map((p) => {
            const r = Math.max(1.4, Math.min(3.4, Math.sqrt(p.count) / 4));
            return (
              <g key={p.bin}>
                <circle
                  cx={p.predicted * 100}
                  cy={100 - p.observed * 100}
                  r={r + 1}
                  fill="var(--color-soleil-400)"
                  opacity="0.25"
                />
                <circle
                  cx={p.predicted * 100}
                  cy={100 - p.observed * 100}
                  r={r}
                  fill="var(--color-soleil-500)"
                />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t border-dashed border-fg-subtle" />
          Calibration parfaite
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-soleil-500" />
          Observé (taille ∝ échantillon)
        </span>
      </div>
    </div>
  );
}
