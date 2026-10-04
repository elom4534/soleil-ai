import { cn, clamp } from "@/lib/utils";

/** Barre de probabilité — utilisée pour les 1X2, Over/Under, BTTS… */
export function ProbabilityBar({
  value,
  color = "var(--color-soleil-500)",
  className,
  height = 8,
  label,
}: {
  value: number;
  color?: string;
  className?: string;
  height?: number;
  label?: string;
}) {
  const pctValue = clamp(value * 100, 0, 100);
  return (
    <div
      className={cn("bar-track w-full", className)}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(pctValue)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pctValue}%`, backgroundColor: color }}
      />
    </div>
  );
}

/**
 * Barre 1X2 empilée : domicile / nul / extérieur.
 * Représentation compacte et immédiatement lisible.
 */
export function OutcomeBar({
  home,
  draw,
  away,
  className,
}: {
  home: number;
  draw: number;
  away: number;
  className?: string;
}) {
  const total = home + draw + away || 1;
  return (
    <div className={cn("flex h-2 w-full overflow-hidden rounded-full", className)}>
      <div
        style={{ width: `${(home / total) * 100}%`, backgroundColor: "var(--color-win)" }}
        className="transition-[width] duration-500"
      />
      <div
        style={{ width: `${(draw / total) * 100}%`, backgroundColor: "var(--color-draw)" }}
        className="transition-[width] duration-500"
      />
      <div
        style={{ width: `${(away / total) * 100}%`, backgroundColor: "var(--color-loss)" }}
        className="transition-[width] duration-500"
      />
    </div>
  );
}
