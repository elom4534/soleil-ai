import { MatchCardSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** §14 — Chargement des Top Picks. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-3 w-72" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <MatchCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
