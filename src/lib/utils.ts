import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Fusionne des classes Tailwind en résolvant les conflits. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formate une probabilité (0-1) en pourcentage lisible. */
export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** Formate un nombre avec séparateur décimal français. */
export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits).replace(".", ",");
}

/** Contraint une valeur dans un intervalle. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Arrondit proprement à n décimales. */
export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Affiche « Donnée indisponible » plutôt que de fabriquer une valeur.
 * Règle fondamentale §34 : on n'invente jamais une statistique.
 */
export function available<T>(value: T | null | undefined, fallback = "Donnée indisponible"): T | string {
  return value === null || value === undefined ? fallback : value;
}

/** Somme d'un tableau. */
export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Moyenne d'un tableau (null si vide). */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/** Écart-type d'échantillon (null si moins de 2 valeurs). */
export function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

export function formatDate(date: Date | string, locale = "fr-FR"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

export function formatTime(date: Date | string, timeZone?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
}

export function formatShortDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(d);
}

/** Retourne la couleur sémantique associée à un niveau de confiance. */
export function confidenceTone(score: number): {
  label: string;
  color: string;
  bg: string;
  text: string;
} {
  if (score >= 80)
    return { label: "Très forte confiance", color: "#059669", bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400" };
  if (score >= 68)
    return { label: "Forte confiance", color: "#10b981", bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400" };
  if (score >= 55)
    return { label: "Confiance modérée", color: "#f59e0b", bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" };
  if (score >= 40)
    return { label: "Confiance faible", color: "#f97316", bg: "bg-orange-500/10", text: "text-orange-600 dark:text-orange-400" };
  return { label: "Très faible confiance", color: "#ef4444", bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400" };
}

export const DATA_QUALITY_LABELS: Record<string, { label: string; tone: string }> = {
  EXCELLENT: { label: "Excellent", tone: "text-emerald-600 dark:text-emerald-400" },
  GOOD: { label: "Bon", tone: "text-lime-600 dark:text-lime-400" },
  MEDIUM: { label: "Moyen", tone: "text-amber-600 dark:text-amber-400" },
  LOW: { label: "Faible", tone: "text-orange-600 dark:text-orange-400" },
  INSUFFICIENT: { label: "Insuffisant", tone: "text-red-600 dark:text-red-400" },
};
