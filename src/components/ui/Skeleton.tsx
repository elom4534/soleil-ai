import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-lg", className)} />;
}

/** Carte de match en chargement — évite le saut de mise en page. */
export function MatchCardSkeleton() {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
      <Skeleton className="mt-4 h-2 w-full" />
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="card space-y-3 p-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}
