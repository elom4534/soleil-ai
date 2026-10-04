import { Skeleton } from "@/components/ui/Skeleton";

/** §14 — Chargement des analyses. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-3 w-80" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
