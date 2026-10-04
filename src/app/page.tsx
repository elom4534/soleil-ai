import Link from "next/link";
import { ArrowRight, Database, ShieldCheck, Sparkles, Target, TrendingUp, AlertTriangle } from "lucide-react";
import { APP_SUBTITLE, APP_TAGLINE, CONFIDENCE_THRESHOLDS } from "@/lib/constants";
import { Card, CardBody, SectionHeader } from "@/components/ui/Card";
import { MatchCard } from "@/components/match/MatchCard";
import { SoleilMark } from "@/components/ui/Logo";
import { pct } from "@/lib/utils";
import { getPlatformStats, listLeagues } from "@/server/predictions/queries";
import { listUpcomingPredictions, upcomingVisibilityReport } from "@/server/predictions/upcoming";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // §9 à §12 — l'accueil n'affiche QUE des rencontres à venir munies d'une
  // prédiction valide. Les matchs terminés restent en base pour
  // l'apprentissage, jamais dans cette liste.
  const [stats, upcoming, visibility, leagues] = await Promise.all([
    getPlatformStats(),
    listUpcomingPredictions({ limit: 200 }),
    upcomingVisibilityReport(),
    listLeagues(),
  ]);
  const todayMatches = upcoming.matches.slice(0, 6);
  // §9 — les « Top Picks » de l'accueil sont extraits de la même liste
  // validée : aucune rencontre terminée ne peut y apparaître.
  const topPicks = upcoming.matches
    .filter((m) => {
      const prediction = m.predictions[0];
      return (
        !!prediction &&
        prediction.confidenceScore >= CONFIDENCE_THRESHOLDS.HIGH &&
        ["EXCELLENT", "GOOD"].includes(prediction.dataQuality) &&
        (prediction.modelAgreement ?? 0) >= 0.5
      );
    })
    .sort((a, b) => (b.predictions[0]?.confidenceScore ?? 0) - (a.predictions[0]?.confidenceScore ?? 0))
    .slice(0, 3);

  return (
    <div className="space-y-9">
      {/* ============================= HERO (§18) ============================= */}
      <section className="relative overflow-hidden rounded-2xl bg-bg-subtle px-5 py-7 sm:px-8 sm:py-9">
        {/* Halo décoratif — purement CSS, aucun impact sur les performances */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full opacity-[0.16] blur-3xl"
          style={{ background: "radial-gradient(circle, #e8548e 0%, transparent 70%)" }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <SoleilMark size={40} className="animate-[sun-pulse_4s_ease-in-out_infinite]" />
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-soleil-600 uppercase dark:text-soleil-400">
                Moteur d&apos;analyse footballistique
              </p>
              <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-fg sm:text-[34px]">
                SOLEIL
              </h1>
            </div>
          </div>

          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-fg-muted sm:text-[17px]">
            <span className="font-medium text-fg">{APP_TAGLINE}</span>
          </p>
          <p className="mt-1.5 text-[13.5px] text-fg-subtle sm:text-[14.5px]">{APP_SUBTITLE}</p>

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Link
              href="/matchs"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-soleil-400 to-soleil-600 px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-sm transition-transform active:scale-[0.98]"
            >
              Explorer les prédictions
              <ArrowRight className="size-4" strokeWidth={2.4} />
            </Link>
            <Link
              href="/top-picks"
              className="inline-flex items-center gap-2 rounded-xl border border-border-strong px-4 py-2.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-bg-subtle"
            >
              Voir les Top Picks
            </Link>
          </div>

          {/* Chiffres réels issus de la base — aucun chiffre marketing */}
          <dl className="mt-7 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Stat label="Compétitions" value={stats.leagues.toString()} />
            <Stat label="Équipes suivies" value={stats.teams.toString()} />
            <Stat label="Rencontres analysées" value={stats.matches.toLocaleString("fr-FR")} />
            <Stat
              label="Prédictions réglées"
              value={stats.settled.toString()}
              hint={stats.accuracy !== null ? `${pct(stats.accuracy, 1)} correctes` : undefined}
            />
          </dl>
        </div>
      </section>

      {/* Avertissement honnête, jamais masqué (§32, §34) */}
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          strokeWidth={2}
        />
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">SOLEIL ne promet pas de connaître le futur.</span>{" "}
          SOLEIL calcule les probabilités du futur à partir des données. Une probabilité de 70 %
          signifie 70 %, pas 100 %.
        </p>
      </div>

      {/* ========================= MATCHS DU JOUR (§18) ========================= */}
      <section>
        <SectionHeader
          title="Matchs à venir"
          subtitle={
            todayMatches.length > 0
              ? "Sélection priorisée par qualité des données et stabilité des prédictions."
              : "Rencontres à venir uniquement — les matchs terminés ne sont pas présentés comme des prédictions."
          }
          action={
            <Link
              href="/matchs"
              className="shrink-0 text-[13px] font-medium text-soleil-600 hover:underline dark:text-soleil-400"
            >
              Tout voir
            </Link>
          }
        />

        {todayMatches.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {todayMatches.slice(0, 6).map((match) => (
              <MatchCard key={match.id} match={match} />
            ))}
          </div>
        ) : (
          <Card>
            <CardBody className="py-6 text-center">
              <p className="text-[13.5px] text-fg-muted">
                Aucune rencontre à venir n&apos;est disponible dans les sources pour le moment.
              </p>
              <p className="mt-1.5 text-[12.5px] text-fg-subtle">
                {visibility.hiddenFinished > 0
                  ? `${visibility.hiddenFinished} rencontres déjà jouées sont conservées pour l'apprentissage, mais ne sont plus présentées comme des prédictions. `
                  : ""}
                Une rencontre n&apos;apparaît ici que si elle est réellement à venir, si une
                prédiction valide a été produite et si ses marchés sont complets. Les calendriers
                sont publiés par les sources quelques jours avant les rencontres.
              </p>
              <Link
                href="/performance"
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-bg-subtle"
              >
                Voir la performance historique
                <ArrowRight className="size-3.5" strokeWidth={2.2} />
              </Link>
            </CardBody>
          </Card>
        )}
      </section>

      {/* ========================== TOP PICKS (§20) ========================== */}
      {topPicks.length > 0 ? (
        <section>
          <SectionHeader
            title="Top Picks SOLEIL"
            subtitle="Rencontres à venir présentant les meilleures caractéristiques statistiques mesurées."
            action={
              <Link
                href="/top-picks"
                className="shrink-0 text-[13px] font-medium text-soleil-600 hover:underline dark:text-soleil-400"
              >
                Tout voir
              </Link>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {topPicks.map((pick) => (
              <MatchCard
                key={pick.id}
                match={pick}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ==================== FONCTIONNEMENT / TRANSPARENCE ==================== */}
      <section>
        <SectionHeader
          title="Comment SOLEIL calcule"
          subtitle="Cinq modèles complémentaires, un consensus pondéré, un score de confiance explicable."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FeatureCard
            icon={Target}
            title="Cinq modèles complémentaires"
            points={[
              "Poisson avec correction Dixon–Coles",
              "Distribution statistique empirique",
              "Expected goals (si les données existent)",
              "Forme récente pondérée par récence",
              "Avantage domicile / extérieur",
            ]}
          />
          <FeatureCard
            icon={Sparkles}
            title="Consensus SOLEIL"
            points={[
              "Moyenne pondérée par la fiabilité observée",
              "Détection automatique des modèles divergents",
              "Aucun modèle ne peut dominer : plafond à 45 %",
              "Un modèle sans données est exclu, jamais simulé",
            ]}
          />
          <FeatureCard
            icon={ShieldCheck}
            title="Confiance & anomalies"
            points={[
              "Score 0-100 décomposé en 5 composantes",
              "Détection de données insuffisantes ou incohérentes",
              "Pénalités explicites et chiffrées",
              "Prédiction retirée si les données ne suffisent pas",
            ]}
          />
          <FeatureCard
            icon={Database}
            title="Données traçables"
            points={[
              "Multi-source avec normalisation et déduplication",
              "Chaque valeur porte sa source et sa date",
              "Cache intelligent pour économiser les API",
              "Aucune donnée inventée : « Donnée indisponible » sinon",
            ]}
          />
        </div>
      </section>

      {/* =========================== COMPÉTITIONS =========================== */}
      {leagues.length > 0 ? (
        <section>
          <SectionHeader title="Compétitions couvertes" />
          <div className="flex flex-wrap gap-2">
            {leagues.map((l) => (
              <Link
                key={l.id}
                href={`/matchs?ligue=${l.id}`}
                className="rounded-full border border-border-subtle bg-bg-elevated px-3.5 py-2 text-[12.5px] font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                {l.name}
                <span className="ml-1.5 tabular-nums text-fg-subtle">
                  {l.matchCount.toLocaleString("fr-FR")}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* =========================== PERFORMANCE =========================== */}
      {stats.settled > 0 ? (
        <section>
          <SectionHeader
            title="SOLEIL Performance"
            subtitle="Mesurée sur les prédictions réellement publiées avant les rencontres."
          />
          <Card>
            <CardBody className="grid grid-cols-2 gap-5 py-5 sm:grid-cols-4">
              <Metric label="Prédictions réglées" value={stats.settled.toString()} />
              <Metric
                label="Taux de réussite 1X2"
                value={stats.accuracy !== null ? pct(stats.accuracy, 1) : "—"}
              />
              <Metric label="Rencontres terminées" value={stats.finished.toLocaleString("fr-FR")} />
              <Metric label="Prédictions publiées" value={stats.published.toString()} />
            </CardBody>
          </Card>
          <Link
            href="/performance"
            className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-soleil-600 hover:underline dark:text-soleil-400"
          >
            Détail complet : Brier Score, Log Loss, calibration
            <TrendingUp className="size-3.5" strokeWidth={2.2} />
          </Link>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-[19px] font-semibold tabular-nums text-fg">{value}</dd>
      {hint ? <dd className="text-[11.5px] text-soleil-600 dark:text-soleil-400">{hint}</dd> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11.5px] text-fg-subtle">{label}</p>
      <p className="mt-1 font-mono text-[20px] font-semibold tabular-nums text-fg">{value}</p>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  points,
}: {
  icon: typeof Target;
  title: string;
  points: string[];
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-soleil-500/12 text-soleil-600 dark:text-soleil-400">
          <Icon className="size-4" strokeWidth={2.1} />
        </span>
        <h3 className="text-[13.5px] font-semibold text-fg">{title}</h3>
      </div>
      <ul className="mt-3 space-y-1.5">
        {points.map((p) => (
          <li key={p} className="flex gap-2 text-[12.5px] leading-relaxed text-fg-muted">
            <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-soleil-500/60" />
            {p}
          </li>
        ))}
      </ul>
    </Card>
  );
}
