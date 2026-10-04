/**
 * ============================================================================
 * SOLEIL — §5 (Phase 15) · Recherche des erreurs récurrentes
 * ============================================================================
 * Ce module décrit ce qui se répète dans les erreurs du modèle. Il MESURE.
 *
 * Ce qu'il ne fait pas, par construction :
 *  • il n'écrit aucune explication causale — un groupe d'erreurs plus élevé
 *    n'est pas une cause, c'est une observation ;
 *  • il ne « corrige » rien : aucune de ses sorties ne modifie une probabilité ;
 *  • il ne réécrit aucune prédiction publiée.
 *
 * Chaque diagnostic est renvoyé avec son effectif, pour que le lecteur puisse
 * juger si la différence observée repose sur assez de rencontres.
 */

export interface DiagnosticRow {
  error1x2: number;
  errorOver25: number;
  errorBtts: number;
  errorTeamHome: number;
  errorTeamAway: number;
  brier: number;
  logLoss: number;
  /** L'issue publiée s'est-elle réalisée ? */
  hit: boolean;
  /** Probabilité accordée à l'issue publiée. */
  pickProbability: number;
  biasHome: number;
  biasOver25: number;
  biasBtts: number;
  competition: string;
  season: string | null;
  confidence: number;
  dataGrade: string;
  xgUsed: boolean;
  expectedGoals: number | null;
  favouriteSide: "HOME" | "DRAW" | "AWAY";
}

export interface GroupSummary {
  /** Libellé du groupe mesuré. */
  group: string;
  /** Nombre de rencontres dans le groupe. */
  n: number;
  brier: number;
  logLoss: number;
  /**
   * Erreur de calibration attendue (ECE), en points de probabilité.
   * Compare, par tranche de probabilité annoncée, la valeur moyenne annoncée
   * et la fréquence réellement observée. 0 = parfaitement calibré.
   */
  calibration: number;
  /** Probabilité moyenne accordée à l'issue publiée. */
  meanPickProbability: number;
  /** Taux de réussite observé de l'issue publiée. */
  hitRate: number;
  /** Biais signés moyens (positif = surestimation). */
  biasHome: number;
  biasOver25: number;
  biasBtts: number;
  errorOver25: number;
  errorBtts: number;
  errorTeamHome: number;
  errorTeamAway: number;
}

export type DiagnosticFamily =
  | "favori"
  | "confiance"
  | "qualite"
  | "xg"
  | "competition"
  | "saison"
  | "niveau_buts";

export interface Diagnostic {
  family: DiagnosticFamily;
  title: string;
  /** Question à laquelle ce tableau répond, en langage simple. */
  question: string;
  /** Groupe de référence (le plus large) pour situer les écarts. */
  reference: GroupSummary;
  groups: GroupSummary[];
  /** Commentaire factuel : ce que montrent les chiffres, sans cause supposée. */
  reading: string;
}

function mean(values: number[]): number {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return Number.NaN;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

/**
 * Erreur de calibration attendue sur des couples (probabilité annoncée,
 * résultat observé). C'est la mesure standard : elle ne se contente pas de
 * moyenner les écarts, elle compare ce qui est annoncé à ce qui arrive.
 */
export function expectedCalibrationError(
  pairs: { p: number; y: number }[],
  binCount = 10,
): number {
  if (pairs.length === 0) return Number.NaN;
  const bins: { n: number; sumP: number; sumY: number }[] = Array.from({ length: binCount }, () => ({
    n: 0,
    sumP: 0,
    sumY: 0,
  }));
  for (const { p, y } of pairs) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(p * binCount)));
    const bin = bins[index]!;
    bin.n += 1;
    bin.sumP += p;
    bin.sumY += y;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    ece += (bin.n / pairs.length) * Math.abs(bin.sumP / bin.n - bin.sumY / bin.n);
  }
  return ece;
}

/** Résume un ensemble de rencontres. */
export function summarise(group: string, rows: DiagnosticRow[]): GroupSummary {
  return {
    group,
    n: rows.length,
    brier: mean(rows.map((r) => r.brier)),
    logLoss: mean(rows.map((r) => r.logLoss)),
    calibration: expectedCalibrationError(
      rows.map((r) => ({ p: r.pickProbability, y: r.hit ? 1 : 0 })),
    ),
    meanPickProbability: mean(rows.map((r) => r.pickProbability)),
    hitRate: mean(rows.map((r) => (r.hit ? 1 : 0))),
    biasHome: mean(rows.map((r) => r.biasHome)),
    biasOver25: mean(rows.map((r) => r.biasOver25)),
    biasBtts: mean(rows.map((r) => r.biasBtts)),
    errorOver25: mean(rows.map((r) => r.errorOver25)),
    errorBtts: mean(rows.map((r) => r.errorBtts)),
    errorTeamHome: mean(rows.map((r) => r.errorTeamHome)),
    errorTeamAway: mean(rows.map((r) => r.errorTeamAway)),
  };
}

/** Seuil minimal d'effectif pour qu'un groupe soit présenté comme tel. */
export const MIN_GROUP_SIZE = 20;

function band(confidence: number): string {
  if (confidence >= 80) return "80 et plus";
  if (confidence >= 68) return "68 à 79";
  if (confidence >= 55) return "55 à 67";
  if (confidence >= 45) return "45 à 54";
  return "moins de 45";
}

function goalsBand(expected: number | null): string {
  if (expected === null) return "inconnu";
  if (expected < 2.2) return "moins de 2,2 buts attendus";
  if (expected < 2.8) return "2,2 à 2,7";
  if (expected < 3.4) return "2,8 à 3,3";
  return "3,4 et plus";
}

function maybe(p: number): string {
  return (p * 100).toFixed(1);
}

/** Signe et amplitude d'un biais, en langage factuel. */
function biasSentence(label: string, value: number, threshold = 0.01): string | null {
  if (!Number.isFinite(value) || Math.abs(value) < threshold) return null;
  const sens = value > 0 ? "surestimé" : "sous-estimé";
  return `${label} ${sens} de ${Math.abs(value * 100).toFixed(1)} point(s) en moyenne`;
}

function build(
  family: DiagnosticFamily,
  title: string,
  question: string,
  reference: GroupSummary,
  groups: GroupSummary[],
  readings: (string | null)[],
): Diagnostic {
  const kept = readings.filter((r): r is string => r !== null);
  return {
    family,
    title,
    question,
    reference,
    groups,
    reading:
      kept.length > 0
        ? kept.join(" · ")
        : "Aucun écart notable : les écarts mesurés restent sous le seuil de 1 point de probabilité.",
  };
}

/**
 * Produit l'ensemble des diagnostics demandés au §5.
 * Les groupes trop petits sont écartés (ils ne prouvent rien).
 */
export function analyseErrors(rows: DiagnosticRow[]): Diagnostic[] {
  const reference = summarise("ensemble", rows);
  if (rows.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  const groupBy = (key: (r: DiagnosticRow) => string) => {
    const map = new Map<string, DiagnosticRow[]>();
    for (const row of rows) {
      const k = key(row);
      const list = map.get(k);
      if (list) list.push(row);
      else map.set(k, [row]);
    }
    return map;
  };
  const toSummaries = (map: Map<string, DiagnosticRow[]>) =>
    [...map.entries()]
      .map(([k, list]) => summarise(k, list))
      .filter((s) => s.n >= MIN_GROUP_SIZE || s.group === "ensemble")
      .sort((a, b) => a.group.localeCompare(b.group));

  // --- Le favori est-il surestimé ? ----------------------------------------
  const favMap = groupBy((r) => r.favouriteSide);
  const favGroups = toSummaries(favMap);
  diagnostics.push(
    build(
      "favori",
      "Favoris et nuls",
      "Le modèle surestime-t-il la favorite, et sous-estime-t-il le match nul ?",
      reference,
      favGroups,
      [
        biasSentence("Probabilité de victoire à domicile", reference.biasHome),
        ...favGroups
          .filter((g) => g.group === "DRAW")
          .map((g) => `matchs nuls : réussite observée ${maybe(g.hitRate)} %, probabilité moyenne annoncée ${maybe(g.meanPickProbability)} %`),
        ...favGroups
          .filter((g) => g.group === "HOME")
          .map((g) => `victoires à domicile : réussite observée ${maybe(g.hitRate)} %`),
      ],
    ),
  );

  // --- Confiance ------------------------------------------------------------
  const confGroups = toSummaries(groupBy((r) => band(r.confidence)));
  diagnostics.push(
    build(
      "confiance",
      "Par niveau de confiance",
      "Les prédictions les plus confiantes sont-elles réellement les plus justes ?",
      reference,
      confGroups,
      confGroups
        .filter((g) => g.n >= MIN_GROUP_SIZE)
        .map((g) => `${g.group} : Brier ${g.brier.toFixed(4)}, réussite ${maybe(g.hitRate)} % (${g.n} rencontres)`),
    ),
  );

  // --- Qualité des données --------------------------------------------------
  const qualityGroups = toSummaries(groupBy((r) => r.dataGrade));
  diagnostics.push(
    build(
      "qualite",
      "Par qualité de données",
      "Une meilleure couverture de données apporte-t-elle réellement de meilleures probabilités ?",
      reference,
      qualityGroups,
      qualityGroups
        .filter((g) => g.n >= MIN_GROUP_SIZE)
        .map((g) => `${g.group} : Brier ${g.brier.toFixed(4)} (${g.n} rencontres)`),
    ),
  );

  // --- Disponibilité du xG --------------------------------------------------
  const xgGroups = toSummaries(groupBy((r) => (r.xgUsed ? "xG disponible" : "sans xG")));
  diagnostics.push(
    build(
      "xg",
      "Avec et sans xG",
      "Les marchés de buts se comportent-ils différemment selon que le xG est disponible ?",
      reference,
      xgGroups,
      xgGroups
        .filter((g) => g.n >= MIN_GROUP_SIZE)
        .map(
          (g) =>
            `${g.group} : Brier ${g.brier.toFixed(4)}, erreur Over 2,5 ${maybe(g.errorOver25)} pt, erreur BTTS ${maybe(g.errorBtts)} pt (${g.n})`,
        ),
    ),
  );

  // --- Buts ----------------------------------------------------------------
  const goalGroups = toSummaries(groupBy((r) => goalsBand(r.expectedGoals)));
  diagnostics.push(
    build(
      "niveau_buts",
      "Par niveau de buts attendu",
      "Le modèle se trompe-t-il davantage quand il attend beaucoup ou peu de buts ?",
      reference,
      goalGroups,
      [
        biasSentence("Probabilité Over 2,5", reference.biasOver25),
        biasSentence("Probabilité BTTS", reference.biasBtts),
        ...goalGroups
          .filter((g) => g.n >= MIN_GROUP_SIZE)
          .map((g) => `${g.group} : Brier ${g.brier.toFixed(4)}, erreur Over 2,5 ${maybe(g.errorOver25)} pt (${g.n})`),
      ],
    ),
  );

  // --- Compétition ----------------------------------------------------------
  const compGroups = toSummaries(groupBy((r) => r.competition));
  diagnostics.push(
    build(
      "competition",
      "Par compétition",
      "Certaines compétitions concentrent-elles les erreurs ?",
      reference,
      compGroups,
      compGroups
        .filter((g) => g.n >= MIN_GROUP_SIZE)
        .map((g) => `${g.group} : Brier ${g.brier.toFixed(4)}, Log Loss ${g.logLoss.toFixed(4)} (${g.n} rencontres)`),
    ),
  );

  // --- Saison ---------------------------------------------------------------
  const seasonGroups = toSummaries(groupBy((r) => r.season ?? "inconnue"));
  diagnostics.push(
    build(
      "saison",
      "Par saison",
      "La qualité des probabilités se dégrade-t-elle dans le temps ?",
      reference,
      seasonGroups,
      seasonGroups
        .filter((g) => g.n >= MIN_GROUP_SIZE)
        .map((g) => `${g.group} : Brier ${g.brier.toFixed(4)}, calibration ${maybe(g.calibration)} pt (${g.n})`),
    ),
  );

  return diagnostics;
}
