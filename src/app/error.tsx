"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

/**
 * §14 — Erreur d'application.
 *
 * Message compréhensible par un utilisateur : aucune trace technique, aucun
 * code d'erreur, aucun détail d'infrastructure n'est exposé ici. Les détails
 * restent dans les journaux serveur.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Journalisation côté client uniquement (le détail reste hors de l'écran).
    console.error("SOLEIL — erreur d'affichage :", error.digest ?? error.name);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-6" strokeWidth={1.9} />
      </span>
      <h1 className="mt-4 text-[17px] font-semibold text-fg">Impossible d&apos;afficher cette page</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">
        Une erreur est survenue pendant le chargement des données. Rien n&apos;a été modifié et
        aucune prédiction n&apos;est perdue. Vous pouvez réessayer.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-soleil-500 px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-soleil-600"
        >
          <RefreshCw className="size-4" strokeWidth={2.2} />
          Réessayer
        </button>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-subtle px-4 text-[13.5px] font-medium text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
        >
          <Home className="size-4" strokeWidth={2.2} />
          Retour à l&apos;accueil
        </Link>
      </div>
      <p className="mt-6 text-[11.5px] text-fg-subtle">
        Si le problème persiste, les journaux serveur contiennent le détail technique.
      </p>
    </div>
  );
}
