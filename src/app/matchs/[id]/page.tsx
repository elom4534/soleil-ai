import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ProbabilityBar, OutcomeBar } from "@/components/ui/ProgressBar";
import { ConfidenceRing } from "@/components/match/ConfidenceRing";
import { DistributionBars } from "@/components/charts/DistributionBars";
import { TeamBadge } from "@/components/match/MatchCard";
import { XgBlock, HalfTimeBlock, ExactScoreBlock } from "@/components/match/MatchMarkets";
import { DataQualityPanel } from "@/components/match/DataQuality";
import { checkPredictionView } from "@/lib/coherence";
import { getMatchCenter } from "@/server/predictions/queries";
import { cn, pct, num, formatDate, formatTime, confidenceTone, DATA_QUALITY_LABELS } from "@/lib/utils";
import {
  toDisplay,
  type ModelOutputPayload,
} from "@/server/predictions/presenter";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getMatchCenter(id);
  if (!data) return { title: "Match introuvable" };
  return {
    title: `${data.match.homeTeam.name} – ${data.match.awayTeam.name}`,
    description: `Analyse SOLEIL : probabilités 1X2, total de buts, mi-temps, BTTS et score exact pour ${data.match.homeTeam.name} contre ${data.match.awayTeam.name}.`,
  };
}

export default async function MatchCenterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getMatchCenter(id);
  if (!data) notFound();

  const { match, prediction, h2h, homeForm, awayForm, halfTimeCoverage } = data;
  const isFinished = match.status === "FINISHED";
  const vm = toDisplay(prediction);

  // §6 — Contrôle de cohérence exécuté AVANT affichage, sur la vue réellement
  // montrée. Le contrôle est en lecture seule : il ne corrige jamais une
  // probabilité. Un écart critique serait signalé ici, jamais rafistolé.
  const coherence = checkPredictionView(vm);
  const knownDrift = coherence.infos.find((v) => v.code === "outcomes.vs_matrix");

  return (
    <div className="space-y-4">
      <Link
        href="/matchs"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="size-3.5" strokeWidth={2.2} />
        Tous les matchs
      </Link>

      {/* ============================= HEADER (§17) ============================= */}
      <Card className="overflow-hidden">
        <div className="bg-bg-subtle px-4 py-2.5 sm:px-5">
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="font-medium text-fg-muted">
              {match.league.name}
              {match.season?.year ? ` · ${match.season.year}` : ""}
            </span>
            <span className="text-fg-subtle">
              {formatDate(match.utcDate)} · {formatTime(match.utcDate)}
            </span>
          </div>
        </div>

        <CardBody className="py-5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <TeamBlock
              name={match.homeTeam.name}
              tla={match.homeTeam.tla}
              crest={match.homeTeam.crest}
              side="Domicile"
              form={homeForm}
              teamId={match.homeTeamId}
            />
            <div className="text-center">
              {isFinished && match.homeScore !== null ? (
                <div className="font-mono text-3xl font-semibold tabular-nums text-fg">
                  {match.homeScore}
                  <span className="mx-1 text-fg-subtle">–</span>
                  {match.awayScore}
                </div>
              ) : (
                <div className="text-[11px] font-semibold tracking-[0.18em] text-fg-subtle">VS</div>
              )}
            </div>
            <TeamBlock
              name={match.awayTeam.name}
              tla={match.awayTeam.tla}
              crest={match.awayTeam.crest}
              side="Extérieur"
              form={awayForm}
              teamId={match.awayTeamId}
              align="right"
            />
          </div>

          {match.venue ? (
            <p className="mt-4 text-center text-[11.5px] text-fg-subtle">{match.venue}</p>
          ) : null}
        </CardBody>
      </Card>

      {prediction === null ? (
        <Card>
          <CardBody className="py-8 text-center">
            <AlertTriangle className="mx-auto size-6 text-amber-500" strokeWidth={1.9} />
            <p className="mt-3 text-[14px] font-medium text-fg">
              Prédiction non publiée — données insuffisantes.
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-fg-muted">
              SOLEIL ne force pas une prédiction lorsque l&apos;historique disponible ne permet
              pas d&apos;estimer les probabilités de façon fiable.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* ================= SOLEIL PREDICTION & CONFIANCE (§17) ================= */}
          <Card>
            <CardBody className="py-5">
              <div className="flex items-start gap-4">
                <ConfidenceRing score={prediction.confidenceScore} size={76} strokeWidth={6} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold tracking-[0.16em] text-soleil-600 uppercase dark:text-soleil-400">
                    SOLEIL Prediction
                  </p>
                  <p className="mt-1 text-[15px] font-semibold text-fg">
                    {confidenceTone(prediction.confidenceScore).label}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">
                      Qualité des données ·{" "}
                      <span className={cn("ml-1", DATA_QUALITY_LABELS[prediction.dataQuality]?.tone)}>
                        {DATA_QUALITY_LABELS[prediction.dataQuality]?.label ?? prediction.dataQuality}
                      </span>
                    </Badge>
                    {prediction.modelAgreement !== null ? (
                      <Badge variant="outline" className="tabular-nums">
                        Accord des modèles {pct(prediction.modelAgreement)}
                      </Badge>
                    ) : null}
                    {isFinished ? (
                      prediction.isCorrect === true ? (
                        <Badge variant="success">
                          <CheckCircle2 className="size-3" /> Prédiction correcte
                        </Badge>
                      ) : prediction.isCorrect === false ? (
                        <Badge variant="danger">
                          <XCircle className="size-3" /> Prédiction incorrecte
                        </Badge>
                      ) : null
                    ) : null}
                  </div>
                </div>
              </div>

              {vm ? (
                <>
                  <div className="mt-5">
                    <OutcomeBar
                      home={vm.outcomes.home}
                      draw={vm.outcomes.draw}
                      away={vm.outcomes.away}
                      className="h-2.5"
                    />
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <OutcomeCell
                        label={match.homeTeam.shortName ?? match.homeTeam.name}
                        value={vm.outcomes.home}
                        color="var(--color-win)"
                        picked={vm.consensusPick === "HOME_WIN"}
                      />
                      <OutcomeCell label="Match nul" value={vm.outcomes.draw} color="var(--color-draw)" picked={vm.consensusPick === "DRAW"} />
                      <OutcomeCell
                        label={match.awayTeam.shortName ?? match.awayTeam.name}
                        value={vm.outcomes.away}
                        color="var(--color-loss)"
                        picked={vm.consensusPick === "AWAY_WIN"}
                      />
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl bg-bg-subtle p-3.5">
                    <p className="text-[11.5px] font-medium text-fg-subtle">Total de buts attendu</p>
                    <p className="mt-0.5 font-mono text-[24px] font-semibold tabular-nums text-fg">
                      {num(vm.expectedGoals.total)}
                      <span className="ml-1.5 text-[13px] font-normal text-fg-muted">buts</span>
                    </p>
                    <p className="mt-1 text-[12px] tabular-nums text-fg-muted">
                      {match.homeTeam.shortName ?? match.homeTeam.name} {num(vm.expectedGoals.home)} —{" "}
                      {match.awayTeam.shortName ?? match.awayTeam.name} {num(vm.expectedGoals.away)}
                    </p>
                  </div>
                </>
              ) : null}
            </CardBody>
          </Card>

          {/* La prédiction a été retenue : on explique pourquoi (§15) */}
          {prediction.status === "GENERATED" ? (
            <Notice tone="warning" title="Prédiction non publiée">
              {vm?.blockingReason ??
                "La confiance calculée est inférieure au seuil de publication. SOLEIL préfère ne rien publier plutôt que de publier une prédiction fragile."}
            </Notice>
          ) : null}

          {vm ? (
            <>
              <div className="flex items-center gap-3 pt-1">
                <span className="text-[11px] font-semibold tracking-[0.16em] text-fg-subtle uppercase">La prédiction — marchés détaillés</span>
                <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
              </div>

              {/* ===================== OVER / UNDER (§7) ===================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Over / Under — total de buts</CardTitle>
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Probabilité que le total de buts du match dépasse la ligne.
                  </p>
                </CardHeader>
                <CardBody className="space-y-3.5">
                  {vm.totalGoals.map((line) => (
                    <div key={line.line}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[13px] font-medium text-fg">
                          Ligne {line.line.toFixed(1)}
                        </span>
                        <span className="text-[12px] tabular-nums text-fg-muted">
                          Over <span className="font-semibold text-fg">{pct(line.over, 1)}</span>
                          <span className="mx-1.5 text-fg-subtle">·</span>
                          Under <span className="font-semibold text-fg">{pct(line.under, 1)}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-bg-inset">
                        <div style={{ width: `${line.over * 100}%`, backgroundColor: "var(--color-soleil-500)" }} />
                        <div style={{ width: `${line.under * 100}%`, backgroundColor: "var(--color-astro-500)" }} />
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <p className="text-[11.5px] leading-relaxed text-fg-subtle">{line.explanation}</p>
                        <Badge variant="outline" className="shrink-0 tabular-nums">
                          Confiance {line.confidence}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </CardBody>
              </Card>

              {/* ======================== BTTS (§11) ======================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Les deux équipes marquent</CardTitle>
                </CardHeader>
                <CardBody>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-inset">
                        <div style={{ width: `${vm.btts.yes * 100}%`, backgroundColor: "var(--color-win)" }} />
                        <div style={{ width: `${vm.btts.no * 100}%`, backgroundColor: "var(--color-draw)" }} />
                      </div>
                      <div className="mt-2.5 flex justify-between text-[13px] tabular-nums">
                        <span>
                          <span className="font-semibold text-fg">{pct(vm.btts.yes, 1)}</span>
                          <span className="ml-1 text-fg-muted">Oui</span>
                        </span>
                        <span>
                          <span className="font-semibold text-fg">{pct(vm.btts.no, 1)}</span>
                          <span className="ml-1 text-fg-muted">Non</span>
                        </span>
                      </div>
                    </div>
                    <Badge variant="outline" className="tabular-nums">
                      Confiance {vm.btts.confidence}
                    </Badge>
                  </div>
                </CardBody>
              </Card>

              {/* ================== BUTS PAR ÉQUIPE (§8) ================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Buts par équipe</CardTitle>
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Distribution du nombre de buts marqués par chaque équipe.
                  </p>
                </CardHeader>
                <CardBody className="space-y-5">
                  {vm.teamGoals.map((tg) => (
                    <div key={tg.teamId}>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium text-fg">
                          {tg.side === "home" ? match.homeTeam.name : match.awayTeam.name}
                        </span>
                        <span className="text-[12px] tabular-nums text-fg-muted">
                          {num(tg.expectedGoals)} buts attendus
                        </span>
                      </div>
                      <DistributionBars
                        className="mt-2"
                        height={64}
                        color="var(--color-astro-500)"
                        data={tg.distribution.map((v, i) => ({
                          label: i === 4 ? "4+" : String(i),
                          value: v,
                        }))}
                      />
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {tg.overUnder.map((l) => (
                          <Badge key={l.line} variant="outline" className="tabular-nums">
                            Over {l.line} · {pct(l.over, 1)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </CardBody>
              </Card>

              {/* ================= SCORES EXACTS (§5) ================= */}
              <ExactScoreBlock view={vm} />

              {/* ================== DISTRIBUTION DES BUTS (§12) ================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Distribution des buts</CardTitle>
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Probabilité d&apos;observer exactement ce nombre de buts sur l&apos;ensemble du match.
                  </p>
                </CardHeader>
                <CardBody>
                  <DistributionBars
                    data={vm.goalsDistribution.map((g) => ({
                      label: g.goals === -1 ? "5+" : String(g.goals),
                      value: g.probability,
                    }))}
                  />
                </CardBody>
              </Card>

              {/* ========================= xG (§7) ========================= */}
              <XgBlock
                view={vm}
                homeName={match.homeTeam.name}
                awayName={match.awayTeam.name}
              />

              {/* ====================== MI-TEMPS (§10) ====================== */}
              <HalfTimeBlock view={vm} coverage={halfTimeCoverage} />

              <div className="flex items-center gap-3 pt-1">
                <span className="text-[11px] font-semibold tracking-[0.16em] text-fg-subtle uppercase">L&apos;explication</span>
                <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
              </div>

              {/* ================== POURQUOI ? (§21) ================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Pourquoi cette prédiction ?</CardTitle>
                </CardHeader>
                <CardBody className="space-y-4">
                  <p className="rounded-xl bg-bg-subtle p-3.5 text-[12.5px] leading-relaxed text-fg-muted">
                    {vm.summary}
                  </p>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-2 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
                        Facteurs favorables
                      </p>
                      <ul className="space-y-1.5">
                        {vm.explanation.positive.length > 0 ? (
                          vm.explanation.positive.map((f) => (
                            <li
                              key={f.key}
                              className="flex gap-2 text-[12.5px] leading-relaxed text-fg-muted"
                            >
                              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                              {f.label}
                            </li>
                          ))
                        ) : (
                          <li className="text-[12.5px] text-fg-subtle">
                            Aucun facteur nettement favorable identifié.
                          </li>
                        )}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-2 text-[12px] font-semibold text-orange-600 dark:text-orange-400">
                        Facteurs défavorables
                      </p>
                      <ul className="space-y-1.5">
                        {vm.explanation.negative.length > 0 ? (
                          vm.explanation.negative.map((f) => (
                            <li
                              key={f.key}
                              className="flex gap-2 text-[12.5px] leading-relaxed text-fg-muted"
                            >
                              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-orange-500" />
                              {f.label}
                            </li>
                          ))
                        ) : (
                          <li className="text-[12.5px] text-fg-subtle">
                            Aucun facteur défavorable majeur identifié.
                          </li>
                        )}
                      </ul>
                    </div>
                  </div>

                  {/* Indicateurs dérivés — transparence totale */}
                  <div className="grid grid-cols-2 gap-2 border-t border-border-subtle pt-3.5 sm:grid-cols-4">
                    <Derived label={`Attaque ${match.homeTeam.tla ?? "DOM"}`} value={vm.derived.homeAttackStrength} />
                    <Derived label={`Défense ${match.homeTeam.tla ?? "DOM"}`} value={vm.derived.homeDefenseStrength} />
                    <Derived label={`Attaque ${match.awayTeam.tla ?? "EXT"}`} value={vm.derived.awayAttackStrength} />
                    <Derived label={`Défense ${match.awayTeam.tla ?? "EXT"}`} value={vm.derived.awayDefenseStrength} />
                  </div>
                  <p className="text-[11px] leading-relaxed text-fg-subtle">
                    Valeurs exprimées en multiple de la moyenne de la compétition. 1,00 = exactement
                    la moyenne. Une défense supérieure à 1,00 encaisse plus que la moyenne.
                  </p>
                </CardBody>
              </Card>

              {/* ================== MODÈLES (§14) ================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Consensus des modèles</CardTitle>
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Poids obtenu selon la fiabilité observée, la confiance intrinsèque et la
                    convergence avec les autres modèles.
                  </p>
                </CardHeader>
                <CardBody className="space-y-2.5">
                  {vm.models.map((m) => (
                    <ModelRow key={m.name} model={m} />
                  ))}
                  <p className="pt-1 text-[11px] leading-relaxed text-fg-subtle">
                    Le modèle Machine Learning n&apos;est pas entraîné dans cette version : il
                    apparaît explicitement comme exclu plutôt que de produire une sortie simulée.
                  </p>
                </CardBody>
              </Card>

              {/* ================== QUALITÉ DES DONNÉES & ANOMALIES ================== */}
              <Card>
                <CardHeader>
                  <CardTitle>Qualité des données</CardTitle>
                  <p className="mt-1 text-[12px] text-fg-muted">
                    Score {vm.dataQuality.score}/100 · {vm.dataQuality.label}
                  </p>
                </CardHeader>
                <CardBody className="space-y-4">
                  {/* §6 — l'utilisateur voit que la cohérence est vérifiée */}
                  <div className="flex items-start gap-2.5 rounded-xl bg-bg-subtle p-3.5">
                    {coherence.ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2} />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" strokeWidth={2} />
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-fg">
                        {coherence.ok
                          ? "Cohérence des marchés vérifiée"
                          : "Incohérence détectée entre marchés"}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
                        {coherence.ok
                          ? "Les probabilités affichées proviennent d'une distribution unique et ont été contrôlées avant publication : somme 1X2, couples Over/Under, BTTS et scores exacts."
                          : "Une incohérence a été détectée. Elle est signalée telle quelle : aucune probabilité n'est corrigée à l'affichage."}
                      </p>
                      {knownDrift ? (
                        <p className="mt-1 text-[11.5px] leading-relaxed text-fg-subtle">
                          Écart connu et documenté entre le 1X2 publié (consensus des modèles) et la
                          distribution des scores : {(knownDrift.deviation * 100).toFixed(2)} points
                          au maximum. Valeur affichée sans modification.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* §8 — traduction en trois états lisibles, jamais inventés */}
                  <div className="rounded-xl bg-bg-subtle p-3.5">
                    <DataQualityPanel
                      grade={vm.dataQuality.grade}
                      score={vm.dataQuality.score}
                      sources={vm.dataQuality.sources}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-5">
                    <QualityComponent label="Volume" value={vm.dataQuality.components.volume} />
                    <QualityComponent label="Fraîcheur" value={vm.dataQuality.components.recency} />
                    <QualityComponent label="Richesse" value={vm.dataQuality.components.richness} />
                    <QualityComponent label="Diversité sources" value={vm.dataQuality.components.sourceDiversity} />
                    <QualityComponent label="Couverture" value={vm.dataQuality.components.coverage} />
                  </div>

                  <div className="grid gap-2 border-t border-border-subtle pt-3.5 sm:grid-cols-2">
                    <div>
                      <p className="text-[11.5px] font-medium text-fg-subtle">Champs disponibles</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {vm.dataQuality.usedFields.length > 0 ? (
                          vm.dataQuality.usedFields.map((f) => (
                            <Badge key={f} variant="success">{f}</Badge>
                          ))
                        ) : (
                          <span className="text-[12px] text-fg-subtle">Donnée indisponible</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11.5px] font-medium text-fg-subtle">Champs manquants</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {vm.dataQuality.missingFields.length > 0 ? (
                          vm.dataQuality.missingFields.map((f) => (
                            <Badge key={f} variant="outline">{f}</Badge>
                          ))
                        ) : (
                          <span className="text-[12px] text-fg-subtle">Aucun</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {vm.anomalies.length > 0 ? (
                    <div className="border-t border-border-subtle pt-3.5">
                      <p className="text-[11.5px] font-medium text-fg-subtle">
                        Anomalies détectées
                      </p>
                      <ul className="mt-2 space-y-2">
                        {vm.anomalies.map((a, i) => (
                          <li key={`${a.code}-${i}`} className="flex items-start gap-2">
                            <span
                              className={cn(
                                "mt-1.5 size-1.5 shrink-0 rounded-full",
                                a.severity === "critical"
                                  ? "bg-red-500"
                                  : a.severity === "warning"
                                    ? "bg-amber-500"
                                    : "bg-fg-subtle",
                              )}
                            />
                            <span className="text-[12.5px] leading-relaxed text-fg-muted">
                              {a.message}
                              {a.confidencePenalty > 0 ? (
                                <span className="ml-1 text-fg-subtle">
                                  (−{a.confidencePenalty} pts de confiance)
                                </span>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {vm.dataQuality.sources.length > 0 ? (
                    <div className="border-t border-border-subtle pt-3.5">
                      <p className="text-[11.5px] font-medium text-fg-subtle">Sources utilisées</p>
                      <ul className="mt-2 space-y-1.5">
                        {vm.dataQuality.sources.map((s) => (
                          <li
                            key={s.name}
                            className="flex items-center justify-between text-[12.5px] text-fg-muted"
                          >
                            <span>{s.name}</span>
                            <span className="tabular-nums text-fg-subtle">
                              dernière donnée{" "}
                              {s.lastUpdate ? new Date(s.lastUpdate).toLocaleDateString("fr-FR") : "—"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </>
          ) : null}
        </>
      )}

      {/* ===================== CONFRONTATIONS DIRECTES ===================== */}
      {h2h.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Confrontations directes</CardTitle>
          </CardHeader>
          <CardBody className="space-y-1.5 p-0 pb-1 sm:px-5">
            {h2h.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-3 px-4 py-2 sm:px-0"
              >
                <span className="text-[11.5px] tabular-nums text-fg-subtle">
                  {new Date(m.utcDate).toLocaleDateString("fr-FR")}
                </span>
                <span className="min-w-0 flex-1 truncate text-center text-[12.5px] text-fg-muted">
                  {m.homeTeam.shortName ?? m.homeTeam.name} –{" "}
                  {m.awayTeam.shortName ?? m.awayTeam.name}
                </span>
                <span className="font-mono text-[12.5px] font-semibold tabular-nums text-fg">
                  {m.homeScore}–{m.awayScore}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : (
        <Notice tone="info" title="Confrontations directes">
          Aucune confrontation directe enregistrée entre ces deux équipes dans les données
          disponibles. Cette absence réduit légèrement le score de confiance.
        </Notice>
      )}

      <p className="pt-1 text-center text-[11px] leading-relaxed text-fg-subtle">
        SOLEIL publie des probabilités calibrées, jamais des certitudes. Ce contenu est fourni à
        titre informatif et analytique.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sous-composants
// ---------------------------------------------------------------------------

/** Résultat d'un match du point de vue d'une équipe. */
type FormEntry = {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
};

function formResults(entries: FormEntry[], teamId: string): ("V" | "N" | "D")[] {
  return entries.slice(0, 5).map((m) => {
    const isHome = m.homeTeamId === teamId;
    const gf = (isHome ? m.homeScore : m.awayScore) ?? 0;
    const ga = (isHome ? m.awayScore : m.homeScore) ?? 0;
    return gf > ga ? "V" : gf === ga ? "N" : "D";
  });
}

function TeamBlock({
  name,
  tla,
  crest,
  side,
  form,
  teamId,
  align = "left",
}: {
  name: string;
  tla: string | null;
  crest: string | null;
  side: string;
  form: FormEntry[];
  teamId: string;
  align?: "left" | "right";
}) {
  const results = formResults(form, teamId);

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", align === "right" && "items-end")}>
      <TeamBadge name={name} tla={tla} crest={crest} size={40} />
      <div className={cn("min-w-0", align === "right" && "text-right")}>
        <p className="truncate text-[13.5px] font-semibold text-fg">{name}</p>
        <p className="text-[11px] text-fg-subtle">{side}</p>
      </div>
      {results.length > 0 ? (
        <div className={cn("flex gap-1", align === "right" && "flex-row-reverse")}>
          {results.map((r, i) => (
            <span
              key={i}
              className={cn(
                "grid size-5 place-items-center rounded text-[10px] font-semibold text-white",
                r === "V" ? "bg-emerald-500" : r === "N" ? "bg-slate-400" : "bg-red-500",
              )}
              title={r === "V" ? "Victoire" : r === "N" ? "Nul" : "Défaite"}
            >
              {r}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[10.5px] text-fg-subtle">Forme indisponible</p>
      )}
    </div>
  );
}

function OutcomeCell({
  label,
  value,
  color,
  picked,
}: {
  label: string;
  value: number;
  color: string;
  picked: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl px-2.5 py-2.5 text-center",
        picked ? "bg-bg-subtle ring-1 ring-border-strong" : "bg-bg-subtle/60",
      )}
    >
      <p className="truncate text-[11px] text-fg-subtle">{label}</p>
      <p className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums" style={{ color }}>
        {pct(value, 1)}
      </p>
    </div>
  );
}

function ModelRow({ model }: { model: ModelOutputPayload }) {
  return (
    <div className={cn("rounded-xl bg-bg-subtle px-3 py-2.5", !model.applicable && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{model.label ?? model.name}</span>
        {model.applicable ? (
          <span className="text-[11.5px] tabular-nums text-fg-muted">
            poids {pct(model.weight, 1)}
          </span>
        ) : (
          <Badge variant="outline">Exclu</Badge>
        )}
      </div>
      {model.applicable ? (
        <>
          <div className="mt-1.5 flex items-center gap-1.5">
            <OutcomeBar home={model.outcomes.home} draw={model.outcomes.draw} away={model.outcomes.away} className="h-1.5 flex-1" />
          </div>
          <p className="mt-1.5 text-[11.5px] tabular-nums text-fg-subtle">
            {pct(model.outcomes.home, 1)} · {pct(model.outcomes.draw, 1)} · {pct(model.outcomes.away, 1)}
            {model.expectedGoals ? ` · ${num(model.expectedGoals.total)} buts attendus` : ""}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[11.5px] leading-relaxed text-fg-subtle">
          {model.unavailableReason ?? "Modèle indisponible"}
        </p>
      )}
    </div>
  );
}

function QualityComponent({ label, value }: { label: string; value: number }) {
  const tone = value >= 75 ? "var(--color-win)" : value >= 50 ? "var(--color-soleil-500)" : "var(--color-loss)";
  return (
    <div>
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className="mt-0.5 text-[13px] font-semibold tabular-nums text-fg">{value}</p>
      <ProbabilityBar value={value / 100} color={tone} height={3} className="mt-1" />
    </div>
  );
}

function Derived({ label, value }: { label: string; value: number }) {
  const tone = value >= 1.15 ? "high" : value <= 0.85 ? "low" : "mid";
  return (
    <div className="rounded-lg bg-bg-subtle px-2.5 py-2">
      <p className="truncate text-[10.5px] text-fg-subtle">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-[14px] font-semibold tabular-nums",
          tone === "high" ? "text-orange-600 dark:text-orange-400" : tone === "low" ? "text-emerald-600 dark:text-emerald-400" : "text-fg",
        )}
      >
        {value.toFixed(2)}
      </p>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "warning";
  title: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3",
        tone === "warning"
          ? "border-amber-500/25 bg-amber-500/[0.06]"
          : "border-border-subtle bg-bg-elevated",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "warning" ? "text-amber-600 dark:text-amber-400" : "text-fg-subtle",
        )}
        strokeWidth={2}
      />
      <div>
        <p className="text-[12.5px] font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{children}</p>
      </div>
    </div>
  );
}
