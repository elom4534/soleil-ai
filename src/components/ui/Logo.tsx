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
          <stop stopColor="#6EE7A0" />
          <stop offset="0.55" stopColor="#24C767" />
          <stop offset="1" stopColor="#128643" />
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

/**
 * Ballon de football — utilisé sur la plaque d'accueil (hero).
 * Ballon blanc structuré : pentagone central + 5 patches au pourtour +
 * coutures, dans l'esprit de la maquette neumorphic.
 */
export function BallMark({ className, size = 48 }: { className?: string; size?: number }) {
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
        <radialGradient id="ball-shine" cx="35%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#f2f6fa" />
          <stop offset="100%" stopColor="#c7d2e0" />
        </radialGradient>
        <clipPath id="ball-clip">
          <circle cx="24" cy="24" r="21" />
        </clipPath>
      </defs>
      {/* Sphère */}
      <circle cx="24" cy="24" r="21" fill="url(#ball-shine)" />
      <g clipPath="url(#ball-clip)">
        {/* Coutures */}
        <g stroke="#22303f" strokeWidth="1.5" strokeLinecap="round" opacity="0.85">
          <line x1="24" y1="17.5" x2="24" y2="1.5" />
          <line x1="29.2" y1="21.3" x2="45.2" y2="16.1" />
          <line x1="27.2" y1="27.4" x2="37.2" y2="43.2" />
          <line x1="20.8" y1="27.4" x2="10.8" y2="43.2" />
          <line x1="18.8" y1="21.3" x2="2.8" y2="16.1" />
        </g>
        {/* Pentagone central */}
        <polygon
          points="24,17.5 29.2,21.3 27.2,27.4 20.8,27.4 18.8,21.3"
          fill="#22303f"
        />
        {/* 5 patches sombres au pourtour (sur les faces du pentagone) */}
        <ellipse cx="35.5" cy="7.2" rx="5" ry="3.8" transform="rotate(36 35.5 7.2)" fill="#22303f" />
        <ellipse cx="42.5" cy="29" rx="5" ry="3.8" transform="rotate(108 42.5 29)" fill="#22303f" />
        <ellipse cx="24" cy="42.5" rx="5.4" ry="3.8" fill="#22303f" />
        <ellipse cx="5.5" cy="29" rx="5" ry="3.8" transform="rotate(72 5.5 29)" fill="#22303f" />
        <ellipse cx="12.5" cy="7.2" rx="5" ry="3.8" transform="rotate(54 12.5 7.2)" fill="#22303f" />
      </g>
      {/* Contour + éclat */}
      <circle cx="24" cy="24" r="21" stroke="rgba(34,48,63,0.18)" strokeWidth="0.8" />
      <ellipse cx="17" cy="13.5" rx="7.5" ry="4.6" transform="rotate(-28 17 13.5)" fill="#ffffff" fillOpacity="0.55" />
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
