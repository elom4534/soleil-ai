import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { cn, pct, formatTime, formatShortDate } from "@/lib/utils";
import { CompetitionLine, EntityLogo } from "@/components/match/Assets";
import { Badge } from "@/components/ui/Badge";
import { OutcomeBar } from "@/components/ui/ProgressBar";
import { ConfidenceRing } from "./ConfidenceRing";
import { DataQualityDot } from "./DataQuality";
import type { MatchListItem } from "@/server/predictions/queries";

/**
 * Carte de match — unité d'affichage principale (§4).
 *
 * Hiérarchie : équipes → issue la plus probable → marchés principaux →
 * scores probables → état des données. Conçue pour être lisible sur un écran
 * de 360 px sans défilement horizontal, puis aérée sur desktop.
 *
 * Toutes les valeurs proviennent de la prédiction persistée : aucune n'est
 * recalculée ni arrondie vers une valeur plus flatteuse.
 */
export function MatchCard({
  match,
  showDate = true,
  className,
}: {
  match: MatchListItem;
  showDate?: boolean;
  className?: string;
}) {
  const prediction = match.predictions[0] ?? null;
  const isFinished = match.status === "FINISHED";
  const scores = readingScores(prediction?.exactScore?.topScores);

  return (
    <Link
      href={`/matchs/${match.id}`}
      className={cn("card card-interactive block p-3.5 sm:p-4", className)}
      aria-label={`${match.homeTeam.name} contre ${match.awayTeam.name}`}
    >
      {/* En-tête : compétition (+ logo, pays, drapeau) puis date et heure */}
      <div className="flex items-center justify-between gap-2 text-[11.5px]">
        <CompetitionLine
          name={match.league.name}
          country={match.league.country}
          countryCode={match.league.countryCode}
          logo={match.league.logo}
          className="min-w-0"
        />
        <span className="flex shrink-0 items-center gap-1 tabular-nums text-fg-subtle">
          <CalendarDays className="size-3" strokeWidth={2} aria-hidden="true" />
          {showDate ? `${formatShortDate(match.utcDate)} · ` : ""}
          {formatTime(match.utcDate)}
        </span>
      </div>

      <div className="mt-2.5 flex items-start gap-3">
        {/* Équipes + score */}
        <div className="min-w-0 flex-1">
          <TeamLine
            name={match.homeTeam.name}
            tla={match.homeTeam.tla}
            crest={match.homeTeam.crest}
            score={isFinished ? match.homeScore : null}
            highlight={
              isFinished
                ? match.homeScore !== null && match.awayScore !== null && match.homeScore > match.awayScore
                : prediction?.matchResult?.consensusPick === "HOME_WIN"
            }
          />
          <TeamLine
            name={match.awayTeam.name}
            tla={match.awayTeam.tla}
            crest={match.awayTeam.crest}
            score={isFinished ? match.awayScore : null}
            highlight={
              isFinished
                ? match.homeScore !== null && match.awayScore !== null && match.awayScore > match.homeScore
                : prediction?.matchResult?.consensusPick === "AWAY_WIN"
            }
          />
        </div>

        {/* Prédiction ou score final */}
        {isFinished && match.homeScore !== null ? (
          <div className="shrink-0 text-right">
            <div className="font-mono text-2xl leading-none font-semibold tabular-nums text-fg">
              {match.homeScore}
              <span className="mx-1 text-fg-subtle">–</span>
              {match.awayScore}
            </div>
            <div className="mt-1.5">
              {prediction?.isCorrect === true ? (
                <Badge variant="success">Réussie</Badge>
              ) : prediction?.isCorrect === false ? (
                <Badge variant="danger">Manquée</Badge>
              ) : (
                <Badge variant="outline">Terminé</Badge>
              )}
            </div>
          </div>
        ) : prediction ? (
          <ConfidenceRing score={prediction.confidenceScore} size={54} />
        ) : (
          <Badge variant="outline" className="shrink-0">
            Non publiée
          </Badge>
        )}
      </div>

      {/* Sortie du modèle */}
      {prediction?.matchResult && !isFinished ? (
        <div className="mt-3.5 space-y-3">
          {/* 1X2 — barre puis valeurs étiquetées */}
          <div>
            <OutcomeBar
              home={prediction.matchResult.homeWinProb}
              draw={prediction.matchResult.drawProb}
              away={prediction.matchResult.awayWinProb}
            />
            <div className="mt-2 flex items-baseline justify-between">
              <OutcomeCell label="1" value={prediction.matchResult.homeWinProb} tone="win" />
              <OutcomeCell label="X" value={prediction.matchResult.drawProb} tone="draw" />
              <OutcomeCell label="2" value={prediction.matchResult.awayWinProb} tone="loss" />
            </div>
          </div>

          {/* Marchés principaux */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums">
            {prediction.totalGoals?.ou25Over !== null && prediction.totalGoals?.ou25Over !== undefined ? (
              <span className="text-fg-muted">
                Over 2,5{" "}
                <span className="font-semibold text-fg">{pct(prediction.totalGoals.ou25Over)}</span>
              </span>
            ) : null}
            {prediction.btts?.yesProb !== null && prediction.btts?.yesProb !== undefined ? (
              <span className="text-fg-muted">
                BTTS <span className="font-semibold text-fg">{pct(prediction.btts.yesProb)}</span>
              </span>
            ) : null}
          </div>

          {/* Scores les plus probables (§4) */}
          {scores.length > 0 ? (
            <div className="rounded-lg bg-bg-subtle px-2.5 py-1.5">
              <p className="text-[10.5px] font-medium tracking-wide text-fg-subtle uppercase">
                Score le plus probable
              </p>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[12px] tabular-nums">
                {scores.map((s, i) => (
                  <span key={s.score} className={i === 0 ? "text-fg" : "text-fg-muted"}>
                    <span className={i === 0 ? "font-semibold" : "font-medium"}>{s.score}</span>
                    <span className="ml-1 text-fg-subtle">{pct(s.probability, 1)}</span>
                  </span>
                ))}
              </p>
            </div>
          ) : null}

          {/* État des données (§8) */}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <DataQualityDot grade={prediction.dataQuality} />
            {prediction.modelAgreement !== null ? (
              <span className="text-[11px] tabular-nums text-fg-subtle">
                Modèles d&apos;accord à {pct(prediction.modelAgreement)}
              </span>
            ) : null}
          </div>
        </div>
      ) : prediction === null ? (
        <p className="mt-3 text-[11.5px] text-fg-subtle">
          Prédiction non publiée — données insuffisantes.
        </p>
      ) : null}
    </Link>
  );
}

/** Lit les scores probables persistés, en tolérant les anciens formats. */
function readingScores(raw: unknown): { score: string; probability: number }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { score?: unknown; probability?: unknown }[])
    .filter((s) => typeof s?.score === "string" && typeof s?.probability === "number")
    .slice(0, 3)
    .map((s) => ({ score: s.score as string, probability: s.probability as number }));
}

/** Issue 1X2 étiquetée — « 1 », « X », « 2 » comme sur un tableau d'affichage. */
function OutcomeCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "win" | "draw" | "loss";
}) {
  const color =
    tone === "win" ? "var(--color-win)" : tone === "draw" ? "var(--color-draw)" : "var(--color-loss)";
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className="grid size-4 place-items-center rounded text-[9.5px] font-bold text-white"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      >
        {label}
      </span>
      <span className="font-mono text-[14px] font-semibold tabular-nums text-fg">{pct(value)}</span>
    </span>
  );
}

function TeamLine({
  name,
  tla,
  crest,
  score,
  highlight,
}: {
  name: string;
  tla: string | null;
  crest: string | null;
  score: number | null;
  highlight: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <TeamBadge name={name} tla={tla} crest={crest} highlight={highlight} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13.5px]",
          highlight ? "font-semibold text-fg" : "font-medium text-fg-muted",
        )}
      >
        {name}
      </span>
      {score !== null ? (
        <span
          className={cn(
            "font-mono text-[13.5px] font-semibold tabular-nums",
            highlight ? "text-fg" : "text-fg-subtle",
          )}
        >
          {score}
        </span>
      ) : null}
    </div>
  );
}

/** Vignette d'équipe : logo de la source, sinon monogramme stable. */
export function TeamBadge({
  name,
  tla,
  crest,
  highlight,
  size = 28,
}: {
  name: string;
  tla: string | null;
  crest: string | null;
  highlight?: boolean;
  size?: number;
}) {
  return (
    <EntityLogo
      name={name}
      tla={tla}
      logo={crest}
      size={size}
      className={
        highlight
          ? "bg-soleil-500/15 text-soleil-700 dark:text-soleil-300"
          : undefined
      }
    />
  );
}
