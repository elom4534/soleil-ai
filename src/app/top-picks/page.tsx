import Link from "next/link";
import { Flame, ShieldAlert } from "lucide-react";
import { Card, CardBody, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { MatchCard } from "@/components/match/MatchCard";
import { listUpcomingPredictions } from "@/server/predictions/upcoming";
import { CONFIDENCE_THRESHOLDS } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const metadata = { title: "Top Picks" };

export default async function TopPicksPage() {
  // §9 à §12 — Les Top Picks ne contiennent QUE des rencontres à venir dont la
  // prédiction est publiée, complète et cohérente. Le repli historique qui
  // présentait des matchs déjà joués a été retiré : il contredisait la règle.
  const { matches } = await listUpcomingPredictions({ limit: 200 });
  const picks = matches
    .filter((m) => {
      const prediction = m.predictions[0];
      if (!prediction) return false;
      return (
        prediction.confidenceScore >= CONFIDENCE_THRESHOLDS.HIGH &&
        ["EXCELLENT", "GOOD"].includes(prediction.dataQuality) &&
        (prediction.modelAgreement ?? 0) >= 0.5
      );
    })
    .sort((a, b) => (b.predictions[0]?.confidenceScore ?? 0) - (a.predictions[0]?.confidenceScore ?? 0))
    .slice(0, 12);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="SOLEIL Top Picks"
        subtitle="Prédictions présentant les meilleures caractéristiques statistiques mesurées."
      />

      {/* Critères explicites : aucune promesse, uniquement des seuils vérifiables */}
      <Card>
        <CardBody className="grid gap-3 py-4 sm:grid-cols-3">
          <Criterion
            title="Confiance élevée"
            detail={`Score SOLEIL ≥ ${CONFIDENCE_THRESHOLDS.HIGH}/100, calculé sur 5 composantes mesurées.`}
          />
          <Criterion
            title="Données de qualité"
            detail="Qualité de données « Bon » ou « Excellent » — volume, fraîcheur et richesse des champs."
          />
          <Criterion
            title="Modèles convergents"
            detail="Accord entre modèles ≥ 50 % : les indicateurs racontent la même histoire."
          />
        </CardBody>
      </Card>

      <div className="flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-3.5 py-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" strokeWidth={2} />
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">
            Aucune prédiction publiée par SOLEIL n&apos;est garantie.
          </span>{" "}
          Ces sélections répondent à des critères statistiques objectifs, mais le football demeure
          un sport à forte variance. Un score de confiance de 80/100 n&apos;implique jamais une
          réussite certaine.
        </p>
      </div>

      {picks.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center">
            <Flame className="mx-auto size-7 text-fg-subtle" strokeWidth={1.7} />
            <p className="mt-3 text-[14px] font-medium text-fg">Aucun Top Pick disponible</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-fg-muted">
              Aucune prédiction ne franchit actuellement les seuils de confiance, de qualité de
              données et d&apos;accord entre modèles. SOLEIL préfère ne rien publier plutôt que de
              présenter une sélection fragile.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {picks.map((pick) => (
              <MatchCard
                key={pick.id}
                match={pick}
              />
            ))}
          </div>
        </>
      )}

      <p className="text-center text-[11px] text-fg-subtle">
        <Link href="/performance" className="text-soleil-600 hover:underline dark:text-soleil-400">
          Consulter la performance mesurée de ces sélections
        </Link>
      </p>
    </div>
  );
}

function Criterion({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <p className="text-[13px] font-semibold text-fg">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{detail}</p>
    </div>
  );
}
