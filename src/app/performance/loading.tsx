import { StatSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** §14 — Chargement de la page Performance. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-56" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatSkeleton key={i} />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
