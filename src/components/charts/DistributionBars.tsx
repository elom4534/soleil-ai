/**
 * Distribution discrète (buts par équipe, total de buts) — §12.
 * Rendu en HTML/CSS : aucun canvas, donc fluide sur smartphone modeste.
 */
export function DistributionBars({
  data,
  color = "var(--color-soleil-500)",
  labelFormatter,
  height = 90,
  className,
}: {
  data: { label: string; value: number }[];
  color?: string;
  labelFormatter?: (label: string) => string;
  height?: number;
  className?: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 0.0001);

  return (
    <div className={className}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] font-medium tabular-nums text-fg-muted">
              {(d.value * 100).toFixed(1)}%
            </span>
            <div
              className="w-full rounded-t-md transition-[height] duration-500"
              style={{
                height: `${Math.max(2, (d.value / max) * 100)}%`,
                backgroundColor: color,
                opacity: 0.35 + (d.value / max) * 0.65,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d) => (
          <div
            key={d.label}
            className="flex-1 truncate text-center text-[10.5px] font-medium text-fg-subtle"
          >
            {labelFormatter ? labelFormatter(d.label) : d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
