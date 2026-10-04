import { Skeleton } from "@/components/ui/Skeleton";

/**
 * §14 — Chargement global.
 *
 * Squelette de page : la mise en page n'est jamais vide ni « sautante », et
 * aucune donnée fictive n'est affichée pendant l'attente. Les routes les plus
 * lourdes possèdent en plus leur propre squelette, adapté à leur structure.
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-3 h-3 w-64" />
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    </div>
  );
}
