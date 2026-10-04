import Link from "next/link";
import { SearchX } from "lucide-react";
import { Card, CardBody, SectionHeader } from "@/components/ui/Card";
import { MatchCard } from "@/components/match/MatchCard";
import { MatchFilters } from "@/components/match/MatchFilters";
import { listLeagues } from "@/server/predictions/queries";
import { listUpcomingPredictions, referenceClock } from "@/server/predictions/upcoming";
import { importWindows } from "@/server/schedule/window";
import { CONFIDENCE_THRESHOLDS } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matchs" };

const PAGE_SIZE = 24;

interface SearchParams {
  ligue?: string;
  confiance?: string;
  marche?: string;
  statut?: string;
  quand?: string;
  /** Journée choisie, au format `AAAA-MM-JJ` (§18). */
  jour?: string;
  page?: string;
}

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));

  const minConfidence =
    params.confiance === "haute"
      ? CONFIDENCE_THRESHOLDS.HIGH
      : params.confiance === "tres-haute"
        ? CONFIDENCE_THRESHOLDS.VERY_HIGH
        : undefined;

  // §9 à §12 — Une seule source pour la liste publique : les rencontres à
  // venir dont la prédiction est publiée, complète et cohérente. Le filtrage
  // par période, compétition, confiance et marché s'applique ensuite sur cette
  // liste déjà validée : aucun match terminé ne peut y entrer.
  // Une seule référence temporelle pour la requête et pour les filtres.
  const reference = referenceClock();
  const [{ matches: validated }, leagues] = await Promise.all([
    listUpcomingPredictions({ limit: 200, now: reference }),
    listLeagues(),
  ]);

  const referenceTime = reference.getTime();

  // §18 — Filtre « matchs à venir » par journée réelle : Aujourd'hui, Demain,
  // puis le quantième. Les libellés et les bornes viennent du même calcul
  // (§7/§8) : un jour sélectionné vaut ses bornes UTC exactes, jamais une
  // comparaison de chaînes de caractères.
  const days = importWindows(reference, { daysAhead: 7 }).map((window) => ({
    value: window.date,
    label: window.label,
    startMs: window.startMs,
    endMs: window.endMs,
  }));
  const selectedDay = days.find((day) => day.value === params.jour) ?? null;
  const horizon = (() => {
    switch (params.quand) {
      case "24h":
        return 86_400_000;
      case "48h":
        return 2 * 86_400_000;
      case "7j":
        return 7 * 86_400_000;
      case "30j":
        return 30 * 86_400_000;
      default:
        return null;
    }
  })();

  const matches = validated.filter((m) => {
    const prediction = m.predictions[0];
    if (!prediction) return false;
    if (horizon !== null && m.utcDate.getTime() > referenceTime + horizon) return false;
    if (selectedDay) {
      const kickoff = m.utcDate.getTime();
      if (kickoff < selectedDay.startMs || kickoff > selectedDay.endMs) return false;
    }
    if (params.ligue && m.league.id !== params.ligue) return false;
    if (minConfidence && prediction.confidenceScore < minConfidence) return false;
    return true;
  });

  const paginated = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Filtrage applicatif par marché (les probabilités sont portées par la
  // prédiction jointe : un filtre SQL générique serait moins précis).
  const filtered = paginated.filter((m) => {
    const p = m.predictions[0];
    if (!p) return false;
    switch (params.marche) {
      case "over25":
        return (p.totalGoals?.ou25Over ?? 0) >= 0.5;
      case "under25":
        return (p.totalGoals?.ou25Over ?? 1) < 0.5;
      case "btts":
        return (p.btts?.yesProb ?? 0) >= 0.5;
      case "result":
        return p.matchResult !== null;
      default:
        return true;
    }
  });

  const hasPrev = page > 1;
  const hasNext = matches.length > page * PAGE_SIZE;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Matchs à venir"
        subtitle={`${filtered.length} rencontre${filtered.length > 1 ? "s" : ""} affichée${filtered.length > 1 ? "s" : ""} · page ${page}`}
      />

      <MatchFilters
        leagues={leagues}
        days={days.map(({ value, label }) => ({ value, label }))}
        current={params as Record<string, string | undefined>}
      />

      {filtered.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((match) => (
            <MatchCard key={match.id} match={match} />
          ))}
        </div>
      ) : (
        <Card>
          <CardBody className="py-10 text-center">
            <SearchX className="mx-auto size-7 text-fg-subtle" strokeWidth={1.7} />
            <p className="mt-3 text-[14px] font-medium text-fg">Aucune rencontre ne correspond</p>
            <p className="mt-1 text-[12.5px] text-fg-muted">
              Élargissez la période ou retirez un filtre. SOLEIL n&apos;affiche jamais de
              prédiction sur des données insuffisantes.
            </p>
          </CardBody>
        </Card>
      )}

      {(hasPrev || hasNext) && (
        <nav className="flex items-center justify-between pt-1" aria-label="Pagination">
          {hasPrev ? (
            <Link
              href={{ pathname: "/matchs", query: { ...params, page: page - 1 } }}
              className="rounded-xl border border-border-strong px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-bg-subtle"
            >
              ← Précédent
            </Link>
          ) : <span />}
          {hasNext ? (
            <Link
              href={{ pathname: "/matchs", query: { ...params, page: page + 1 } }}
              className="rounded-xl border border-border-strong px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-bg-subtle"
            >
              Suivant →
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  );
}
