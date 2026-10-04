import { cn } from "@/lib/utils";

/**
 * Logo SOLEIL — un soleil stylisé dont les rayons évoquent les lignes
 * d'un ballon de football et les nœuds d'un réseau de neurones.
 */
export function SoleilMark({ className, size = 32 }: { className?: string; size?: number }) {
  const id = "soleil-grad";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FBBF24" />
          <stop offset="0.55" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#EA580C" />
        </linearGradient>
      </defs>
      {/* Rayons : 8 directions, alternance courte/longue pour un rythme solaire */}
      <g stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round">
        <line x1="24" y1="3" x2="24" y2="10" />
        <line x1="24" y1="38" x2="24" y2="45" />
        <line x1="3" y1="24" x2="10" y2="24" />
        <line x1="38" y1="24" x2="45" y2="24" />
        <line x1="9" y1="9" x2="14" y2="14" />
        <line x1="34" y1="34" x2="39" y2="39" />
        <line x1="39" y1="9" x2="34" y2="14" />
        <line x1="14" y1="34" x2="9" y2="39" />
      </g>
      {/* Disque central — ballon réduit à sa structure essentielle */}
      <circle cx="24" cy="24" r="11.5" fill={`url(#${id})`} />
      <path
        d="M24 15.4 L31.6 21 L28.7 30 H19.3 L16.4 21 Z"
        fill="#fff"
        fillOpacity="0.92"
      />
      <circle cx="24" cy="24" r="3.1" fill="#fff" fillOpacity="0.55" />
    </svg>
  );
}

export function SoleilWordmark({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <SoleilMark size={size} />
      <span className="text-[17px] font-semibold tracking-[0.16em] text-fg">SOLEIL</span>
    </span>
  );
}
