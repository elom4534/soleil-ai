import { confidenceTone } from "@/lib/utils";

/**
 * Anneau du SOLEIL CONFIDENCE SCORE (§13).
 * SVG pur : aucun JavaScript côté client, rendu immédiat, léger sur mobile.
 */
export function ConfidenceRing({
  score,
  size = 64,
  strokeWidth = 5,
  showLabel = true,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  showLabel?: boolean;
}) {
  const tone = confidenceTone(score);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Score de confiance SOLEIL : ${score} sur 100 — ${tone.label}`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-inset)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      {showLabel ? (
        <div className="absolute inset-0 grid place-items-center">
          <span
            className="font-mono font-semibold tabular-nums"
            style={{ color: tone.color, fontSize: size * 0.3 }}
          >
            {score}
          </span>
        </div>
      ) : null}
    </div>
  );
}
