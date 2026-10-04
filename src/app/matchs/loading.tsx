import { MatchCardSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** §14 — Chargement de la liste des matchs. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <MatchCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
