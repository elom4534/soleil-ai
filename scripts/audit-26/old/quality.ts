/**
 * ============================================================================
 * SOLEIL PREDICTION ENGINE — Qualité des données, anomalies & confiance
 * ============================================================================
 * Implémente §13 (SOLEIL CONFIDENCE SCORE), §15 (détection d'anomalies) et §4
 * (score de qualité des données). Aucun de ces scores n'est arbitraire :
 * chaque composante est calculée et expliquée.
 */

import type {
  Anomaly,
  ConfidenceBreakdown,
  DataQualityReport,
  LeagueBaseline,
  ModelPrediction,
  TeamSnapshot,
} from "./types";
import { mean, stdDev } from "./math";
import { computeTeamRatings } from "./ratings";

// ---------------------------------------------------------------------------
// §4 — Score de qualité des données
// ---------------------------------------------------------------------------

export interface DataQualityInput {
  home: TeamSnapshot;
  away: TeamSnapshot;
  baseline: LeagueBaseline;
  matchDate: Date;
}

export function assessDataQuality(input: DataQualityInput): DataQualityReport {
  const { home, away, baseline, matchDate } = input;

  const totalMatches = home.seasonMatches.length + away.seasonMatches.length;

  // --- Volume : 0 match → 0 ; 30+ matchs cumulés → 100 ---
  const volume = Math.min(100, (totalMatches / 30) * 100);

  // --- Récence : fraîcheur de la dernière donnée disponible ---
  const allMatches = [...home.seasonMatches, ...away.seasonMatches];
  const latest = allMatches.reduce<Date | null>(
    (acc, m) => (acc === null || m.date > acc ? m.date : acc),
    null,
  );
  const ageDays = latest ? (matchDate.getTime() - latest.getTime()) / 86_400_000 : Infinity;
  const recency = !latest ? 0 : Math.max(0, 100 - Math.max(0, ageDays - 7) * 3.2);

  // --- Richesse : champs avancés réellement présents ---
  const advancedFields = [
    { key: "xG", present: allMatches.some((m) => m.homeXg !== null) },
    { key: "tirs", present: allMatches.some((m) => m.homeShots !== null) },
    { key: "tirs cadrés", present: allMatches.some((m) => m.homeShotsOnTarget !== null) },
    {
      key: "score à la mi-temps",
      present: allMatches.some((m) => m.halfTimeHomeGoals !== null),
    },
    { key: "corners", present: allMatches.some((m) => m.homeCorners !== null) },
    { key: "cartons", present: allMatches.some((m) => m.homeYellowCards !== null) },
  ];
  const presentCount = advancedFields.filter((f) => f.present).length;
  const richness = (presentCount / advancedFields.length) * 100;

  // --- Diversité des sources ---
  const sources = new Set(allMatches.map((m) => m.source));
  const sourceDiversity = Math.min(100, sources.size * 50);

  // --- Couverture : confrontations directes + taille de l'échantillon ligue ---
  const h2hCoverage = Math.min(100, (home.headToHead.length / 5) * 100);
  const leagueCoverage = Math.min(100, (baseline.sampleSize / 100) * 100);
  const coverage = h2hCoverage * 0.4 + leagueCoverage * 0.6;

  const score =
    volume * 0.32 +
    recency * 0.2 +
    richness * 0.23 +
    sourceDiversity * 0.09 +
    coverage * 0.16;

  const rounded = Math.round(Math.max(0, Math.min(100, score)));

  const grade: DataQualityReport["grade"] =
    rounded >= 85 ? "EXCELLENT"
    : rounded >= 70 ? "GOOD"
    : rounded >= 50 ? "MEDIUM"
    : rounded >= 30 ? "LOW"
    : "INSUFFICIENT";

  const labels: Record<DataQualityReport["grade"], string> = {
    EXCELLENT: "Excellent",
    GOOD: "Bon",
    MEDIUM: "Moyen",
    LOW: "Faible",
    INSUFFICIENT: "Insuffisant",
  };

  const sourceEntries = [...sources].map((name) => {
    const fromSource = allMatches.filter((m) => m.source === name);
    const last = fromSource.reduce<Date | null>(
      (acc, m) => (acc === null || m.date > acc ? m.date : acc),
      null,
    );
    return { name, lastUpdate: last, score: home.sourceScores[name] ?? 0.7 };
  });

  return {
    score: rounded,
    grade,
    label: labels[grade],
    components: {
      volume: Math.round(volume),
      recency: Math.round(recency),
      richness: Math.round(richness),
      sourceDiversity: Math.round(sourceDiversity),
      coverage: Math.round(coverage),
    },
    sources: sourceEntries,
    usedFields: advancedFields.filter((f) => f.present).map((f) => f.key),
    missingFields: advancedFields.filter((f) => !f.present).map((f) => f.key),
  };
}

// ---------------------------------------------------------------------------
// §15 — Détection d'anomalies
// ---------------------------------------------------------------------------

export function detectAnomalies(ctx: {
  home: TeamSnapshot;
  away: TeamSnapshot;
  baseline: LeagueBaseline;
  models: ModelPrediction[];
  agreement: number;
  matchDate: Date;
}): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const { home, away, baseline, models, agreement, matchDate } = ctx;

  const homeN = home.seasonMatches.length;
  const awayN = away.seasonMatches.length;
  const minN = Math.min(homeN, awayN);

  // --- Historique insuffisant ---
  if (minN < 3) {
    anomalies.push({
      code: "INSUFFICIENT_MATCHES",
      severity: "critical",
      message: `Historique très réduit : ${home.identity.name} ${homeN} match(s), ${away.identity.name} ${awayN} match(s).`,
      confidencePenalty: 30,
    });
  } else if (minN < 6) {
    anomalies.push({
      code: "INSUFFICIENT_MATCHES",
      severity: "warning",
      message: `Échantillon limité : ${minN} matchs minimum par équipe. Les estimations restent instables.`,
      confidencePenalty: 12,
    });
  }

  // --- Déséquilibre du nombre de matchs entre les deux équipes ---
  if (Math.abs(homeN - awayN) >= 5) {
    anomalies.push({
      code: "UNBALANCED_SAMPLE",
      severity: "warning",
      message: `Volumes de données déséquilibrés entre les deux équipes (${homeN} vs ${awayN} matchs).`,
      confidencePenalty: 8,
    });
  }

  // --- Absence de xG ---
  const hasXg = home.hasXg && away.hasXg;
  if (!hasXg) {
    anomalies.push({
      code: "NO_XG",
      severity: "info",
      message:
        "Données xG absentes pour au moins une équipe : le modèle Expected Goals est exclu du consensus.",
      confidencePenalty: 5,
    });
  }

  // --- Données trop anciennes ---
  const allMatches = [...home.seasonMatches, ...away.seasonMatches];
  const latest = allMatches.reduce<Date | null>(
    (acc, m) => (acc === null || m.date > acc ? m.date : acc),
    null,
  );
  if (latest) {
    const ageDays = (matchDate.getTime() - latest.getTime()) / 86_400_000;
    if (ageDays > 45) {
      anomalies.push({
        code: "STALE_DATA",
        severity: "critical",
        message: `Les données les plus récentes datent de ${Math.round(ageDays)} jours.`,
        confidencePenalty: 25,
      });
    } else if (ageDays > 21) {
      anomalies.push({
        code: "STALE_DATA",
        severity: "warning",
        message: `Les données les plus récentes datent de ${Math.round(ageDays)} jours.`,
        confidencePenalty: 10,
      });
    }
  } else {
    anomalies.push({
      code: "STALE_DATA",
      severity: "critical",
      message: "Aucune donnée historique disponible pour cette rencontre.",
      confidencePenalty: 40,
    });
  }

  // --- Taille d'échantillon de la compétition ---
  if (baseline.sampleSize < 40) {
    anomalies.push({
      code: "LOW_SOURCE_DIVERSITY",
      severity: "info",
      message: `Référence de compétition calculée sur ${baseline.sampleSize} matchs seulement.`,
      confidencePenalty: 4,
    });
  }

  // --- Absence de confrontations directes ---
  if (home.headToHead.length === 0) {
    anomalies.push({
      code: "MISSING_H2H",
      severity: "info",
      message: "Aucune confrontation directe enregistrée entre ces deux équipes.",
      confidencePenalty: 3,
    });
  }

  // --- Désaccord entre modèles ---
  if (agreement < 0.35) {
    anomalies.push({
      code: "MODEL_DISAGREEMENT",
      severity: "warning",
      message: `Les modèles divergent fortement (accord ${(agreement * 100).toFixed(0)} %). La prédiction est peu robuste.`,
      confidencePenalty: 15,
    });
  } else if (agreement < 0.55) {
    anomalies.push({
      code: "MODEL_DISAGREEMENT",
      severity: "info",
      message: `Accord modéré entre les modèles (${(agreement * 100).toFixed(0)} %).`,
      confidencePenalty: 6,
    });
  }

  // --- Variance extrême : incohérence de la production de buts ---
  for (const [side, snapshot] of [
    ["home", home],
    ["away", away],
  ] as const) {
    const teamId = snapshot.identity.id;
    const scored = snapshot.seasonMatches.map((m) =>
      m.homeTeamId === teamId ? m.homeGoals : m.awayGoals,
    );
    const sd = stdDev(scored);
    const m = mean(scored);
    if (sd !== null && m !== null && m > 0 && sd / m > 1.35 && scored.length >= 5) {
      anomalies.push({
        code: "EXTREME_VARIANCE",
        severity: "warning",
        message: `Production de buts très irrégulière pour ${
          side === "home" ? home.identity.name : away.identity.name
        } (coefficient de variation ${(sd / m).toFixed(2)}).`,
        confidencePenalty: 7,
      });
    }
  }

  // --- Statistiques contradictoires : attaque et défense en opposition totale ---
  const ratios = models.find((m) => m.name === "poisson");
  if (ratios?.applicable) {
    const homeTotal =
      (ratios.expectedGoals?.home ?? 0) + (ratios.expectedGoals?.away ?? 0);
    if (homeTotal < 1.2 || homeTotal > 4.6) {
      anomalies.push({
        code: "ODD_DISTRIBUTION",
        severity: "warning",
        message: `Total de buts attendu inhabituel (${homeTotal.toFixed(2)}). Vérifier la cohérence des données sources.`,
        confidencePenalty: 6,
      });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// §13 — SOLEIL CONFIDENCE SCORE
// ---------------------------------------------------------------------------

export interface ConfidenceInput {
  dataQuality: DataQualityReport;
  home: TeamSnapshot;
  away: TeamSnapshot;
  models: ModelPrediction[];
  agreement: number;
  anomalies: Anomaly[];
  baseline: LeagueBaseline;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const { dataQuality, home, away, agreement, anomalies, baseline } = input;

  // --- Composante 1 : qualité des données (35 %) ---
  const dataQualityComponent = dataQuality.score;

  // --- Composante 2 : volume (15 %) ---
  const totalMatches = home.seasonMatches.length + away.seasonMatches.length;
  const dataVolume = Math.min(100, (totalMatches / 28) * 100);

  // --- Composante 3 : accord entre modèles (25 %) ---
  const modelAgreement = Math.round(agreement * 100);

  // --- Composante 4 : stabilité des statistiques (12 %) ---
  const stability = Math.round(
    (stabilityOf(home) * 0.5 + stabilityOf(away) * 0.5) * 100,
  );

  // --- Composante 5 : cohérence des indicateurs (13 %) ---
  const coherence = Math.round(coherenceScore(home, away, baseline));

  const base =
    dataQualityComponent * 0.35 +
    dataVolume * 0.15 +
    modelAgreement * 0.25 +
    stability * 0.12 +
    coherence * 0.13;

  const penalties = anomalies
    .filter((a) => a.confidencePenalty > 0)
    .map((a) => ({ code: a.code, points: a.confidencePenalty, message: a.message }));

  const totalPenalty = penalties.reduce((acc, p) => acc + p.points, 0);
  // Atténuation : les pénalités ne peuvent pas retirer plus de 45 points au total.
  const appliedPenalty = Math.min(45, totalPenalty);

  const score = Math.round(Math.max(0, Math.min(100, base - appliedPenalty)));

  const grade: ConfidenceBreakdown["grade"] =
    score >= 80 ? "TRES_FORTE"
    : score >= 68 ? "FORTE"
    : score >= 55 ? "MODEREE"
    : score >= 40 ? "FAIBLE"
    : "TRES_FAIBLE";

  const labels: Record<ConfidenceBreakdown["grade"], string> = {
    TRES_FORTE: "Très forte confiance",
    FORTE: "Forte confiance",
    MODEREE: "Confiance modérée",
    FAIBLE: "Confiance faible",
    TRES_FAIBLE: "Très faible confiance",
  };

  return {
    score,
    grade,
    label: labels[grade],
    components: {
      dataQuality: Math.round(dataQualityComponent),
      dataVolume: Math.round(dataVolume),
      modelAgreement,
      stability,
      coherence,
    },
    penalties,
  };
}

/** Stabilité d'une équipe : inverse de l'irrégularité des points et des buts. */
function stabilityOf(snapshot: TeamSnapshot): number {
  const teamId = snapshot.identity.id;
  const recent = snapshot.seasonMatches.slice(0, 8);
  if (recent.length < 3) return 0.25;

  const points = recent.map((m) => {
    const gf = m.homeTeamId === teamId ? m.homeGoals : m.awayGoals;
    const ga = m.homeTeamId === teamId ? m.awayGoals : m.homeGoals;
    return gf > ga ? 3 : gf === ga ? 1 : 0;
  });

  const sd = stdDev(points) ?? 1.5;
  const pointsStability = Math.max(0, 1 - sd / 1.5);

  const goalDiffs = recent.map((m) => {
    const gf = m.homeTeamId === teamId ? m.homeGoals : m.awayGoals;
    const ga = m.homeTeamId === teamId ? m.awayGoals : m.homeGoals;
    return gf - ga;
  });
  const gsd = stdDev(goalDiffs) ?? 3;
  const goalStability = Math.max(0, 1 - gsd / 3.5);

  return Math.min(1, pointsStability * 0.6 + goalStability * 0.4);
}

/**
 * Cohérence : les indicateurs racontent-ils la même histoire ?
 * Ex. une équipe avec une attaque forte et une défense forte est cohérente ;
 * un profil « beaucoup de buts marqués ET beaucoup encaissés » sur un match
 * à faible total attendu est incohérent.
 */
function coherenceScore(home: TeamSnapshot, away: TeamSnapshot, baseline: LeagueBaseline): number {
  const hr = computeTeamRatings(home, baseline);
  const ar = computeTeamRatings(away, baseline);

  let score = 100;

  // Écart crédible : le rapport des forces ne doit pas être démesuré.
  const ratio = Math.max(hr.attack, 0.01) / Math.max(ar.attack, 0.01);
  if (ratio > 2.4 || ratio < 0.42) score -= 22;
  else if (ratio > 1.8 || ratio < 0.55) score -= 10;

  // Équipe très offensive mais aussi très perméable : signal contradictoire.
  for (const r of [hr, ar]) {
    if (r.attack > 1.35 && r.defense > 1.35) score -= 12;
    if (r.attack > 1.3 && r.failedToScoreRate !== null && r.failedToScoreRate > 0.45) score -= 10;
  }

  // Le nombre de matchs joués doit être suffisant pour les deux.
  if (Math.min(hr.sampleSize, ar.sampleSize) < 5) score -= 18;

  return Math.max(0, Math.min(100, score));
}
