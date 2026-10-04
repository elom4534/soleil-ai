import { Skeleton } from "@/components/ui/Skeleton";

/** §14 — Chargement de Soleil AI. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="h-3 w-72" />
      <Skeleton className="h-[60vh] w-full" />
    </div>
  );
}
