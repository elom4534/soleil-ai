"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

type Mode = "light" | "dark" | "system";

const STORAGE_KEY = "soleil-theme";
const OPTIONS: { value: Mode; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Clair" },
  { value: "dark", icon: Moon, label: "Sombre" },
  { value: "system", icon: Monitor, label: "Système" },
];

// ---------------------------------------------------------------------------
// Petit store externe : il évite d'écrire de l'état dans un effet, ce qui
// provoquerait un rendu en cascade au montage.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // Un changement de préférence système doit rafraîchir l'interface lorsque
  // le mode « système » est actif.
  media.addEventListener("change", callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    media.removeEventListener("change", callback);
    window.removeEventListener("storage", callback);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

/** Valeur lue côté navigateur. Côté serveur, on renvoie « system ». */
function readMode(): Mode {
  const stored = window.localStorage.getItem(STORAGE_KEY) as Mode | null;
  return stored ?? "system";
}

function serverMode(): Mode {
  return "system";
}

function applyMode(mode: Mode) {
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * Sélecteur de thème clair / sombre / système.
 * Le choix est appliqué avant le premier rendu par le script inline du layout,
 * ce qui évite tout clignotement.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const mode = useSyncExternalStore(subscribe, readMode, serverMode);
  // `hydrated` distingue la valeur serveur (« system ») de la valeur réelle :
  // on n'affiche l'état sélectionné qu'après hydratation.
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const choose = useCallback((next: Mode) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    applyMode(next);
    emit();
  }, []);

  if (compact) {
    const next: Mode = mode === "dark" ? "light" : "dark";
    const Icon = mode === "dark" ? Sun : Moon;
    return (
      <button
        type="button"
        onClick={() => choose(next)}
        aria-label={`Passer en mode ${next === "dark" ? "sombre" : "clair"}`}
        className="grid size-9 place-items-center rounded-full text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
      >
        <Icon className="size-[18px]" strokeWidth={1.9} />
      </button>
    );
  }

  return (
    <div
      className="inline-flex rounded-full bg-bg-subtle p-0.5"
      role="radiogroup"
      aria-label="Thème d'affichage"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => {
        const active = hydrated && mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all",
              active ? "bg-bg-elevated text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            <Icon className="size-3.5" strokeWidth={2} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Script anti-flash injecté avant le premier paint (évite le clignotement). */
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('soleil-theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
