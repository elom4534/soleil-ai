import Link from "next/link";
import { SearchX, Home, Goal } from "lucide-react";

/** §14 — Page introuvable. */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-bg-subtle text-fg-muted">
        <SearchX className="size-6" strokeWidth={1.9} />
      </span>
      <h1 className="mt-4 text-[17px] font-semibold text-fg">Page introuvable</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">
        Cette page n&apos;existe pas ou la rencontre demandée n&apos;est pas disponible dans les
        données SOLEIL.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <Link
          href="/matchs"
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-soleil-500 px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-soleil-600"
        >
          <Goal className="size-4" strokeWidth={2.2} />
          Voir les matchs
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-subtle px-4 text-[13.5px] font-medium text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
        >
          <Home className="size-4" strokeWidth={2.2} />
          Accueil
        </Link>
      </div>
    </div>
  );
}
