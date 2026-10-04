/**
 * ============================================================================
 * SOLEIL AI — Agent d'explication
 * ============================================================================
 * §16 : « L'agent doit répondre uniquement à partir des données et résultats
 * disponibles. Il doit expliquer clairement les facteurs ayant influencé la
 * prédiction. Il ne doit jamais inventer une donnée. »
 *
 * Architecture retenue pour la V1 : un moteur d'explication **déterministe**,
 * fondé sur les prédictions réellement stockées. Chaque phrase d'une réponse
 * est traçable jusqu'à un champ de la base. Aucun texte n'est généré par un
 * modèle de langage à ce stade — c'est un choix de fiabilité, pas une limite :
 * la couche `LLMAdapter` permet de brancher un fournisseur (avec appels d'outils
 * sur ces mêmes fonctions) sans modifier l'interface ni le contrat de données.
 *
 * Cette approche garantit trois propriétés vérifiables :
 *  1. Aucune donnée n'est inventée : une information absente donne
 *     « Donnée indisponible ».
 *  2. Toute affirmation est rattachée à une valeur chiffrée réelle.
 *  3. Le comportement est testable et reproductible.
 */

import { prisma } from "@/lib/prisma";
import { toDisplay, type PredictionView } from "@/server/predictions/presenter";
import { pct, num } from "@/lib/utils";

export type Intent =
  | "why_winner"
  | "why_over25"
  | "most_likely_score"
  | "offensive_advantage"
  | "which_half"
  | "confidence_explanation"
  | "data_quality"
  | "btts"
  | "match_summary"
  | "best_picks"
  | "method"
  | "unknown";

export interface AIAnswer {
  intent: Intent;
  answer: string;
  /** Faits chiffrés ayant servi à construire la réponse (auditabilité). */
  evidence: { label: string; value: string; source: string }[];
  /** Suggestions de questions de suivi, contextuelles. */
  followUps: string[];
  /** Match effectivement utilisé, si la question portait sur une rencontre. */
  matchRef?: { id: string; label: string };
}

/**
 * Détection d'intention par expressions régulières françaises.
 * Volontairement explicite : un intent mal détecté produit une réponse
 * générique honnête plutôt qu'une réponse hors sujet.
 */
const INTENT_PATTERNS: { intent: Intent; patterns: RegExp[] }[] = [
  {
    intent: "why_over25",
    patterns: [/over\s*2\.?5/i, /plus de 2\.?5/i, /over\/under/i, /total de buts/i],
  },
  {
    intent: "most_likely_score",
    patterns: [/score le plus probable/i, /score exact/i, /quel score/i, /résultat exact/i],
  },
  {
    intent: "which_half",
    patterns: [/mi[- ]?temps/i, /première période/i, /seconde période/i, /1re? mt/i, /2e? mt/i],
  },
  {
    intent: "btts",
    patterns: [/btts/i, /deux équipes marquent/i, /les deux marquent/i],
  },
  {
    intent: "offensive_advantage",
    patterns: [/avantage offensif/i, /meilleure attaque/i, /qui attaque/i, /force offensive/i],
  },
  {
    intent: "confidence_explanation",
    patterns: [/score de confiance/i, /confiance/i, /pourquoi\s+\d+/i],
  },
  {
    intent: "data_quality",
    patterns: [/qualité des données/i, /données suffisantes/i, /source/i],
  },
  {
    intent: "why_winner",
    patterns: [/va gagner/i, /pourquoi.*gagn/i, /favori/i, /pronostic.*vainqueur/i, /qui va remporter/i],
  },
  {
    intent: "best_picks",
    patterns: [/meilleures? (prédiction|sélection|pari)/i, /top pick/i, /meilleurs pronostics/i],
  },
  {
    intent: "method",
    patterns: [
      /comment\s+(cela|ça|ca|tu|vous)?\s*(marche|fonctionne|calcul|est[- ]ce que)/i,
      /comment (fonctionne|marche|calcul)/i,
      /quelle méthode/i,
      /quels modèles/i,
      /comment\s+(sois|soleil)/i,
    ],
  },
  {
    intent: "match_summary",
    patterns: [/résume/i, /analyse/i, /que penses[- ]tu/i, /explique/i],
  },
];

export function detectIntent(question: string): Intent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(question))) return intent;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Résolution du match concerné
// ---------------------------------------------------------------------------

/**
 * Identifie la rencontre visée par la question, par recherche de noms
 * d'équipes réellement présents en base. Aucune supposition : si aucun nom
 * connu n'est reconnu, la question est traitée au niveau global.
 */
/**
 * Traductions des noms francisés vers les libellés publiés par les sources.
 * Table volontairement courte et vérifiable : un jeton absent n'est pas deviné,
 * la question est simplement considérée comme sans équipe identifiée.
 */
const FRENCH_TEAM_ALIASES: Record<string, string> = {
  barcelone: "barcelona",
  seville: "sevilla",
  valence: "valencia",
  lazio: "lazio",
  rome: "roma",
  naples: "napoli",
  milan: "milan",
  turin: "torino",
  genes: "genoa",
  florence: "fiorentina",
  munich: "munchen",
  francfort: "frankfurt",
  cologne: "koln",
  lisbonne: "lisbon",
  anvers: "antwerp",
  bruges: "brugge",
  gand: "gent",
  athenes: "athens",
  bordeaux: "bordeaux",
  nantes: "nantes",
  rennes: "rennes",
  toulouse: "toulouse",
  montpellier: "montpellier",
  strasbourg: "strasbourg",
  nice: "nice",
  reims: "reims",
  lens: "lens",
  lille: "lille",
  lyon: "lyon",
  marseille: "marseille",
  monaco: "monaco",
  paris: "paris",
  saint: "saint",
  etienne: "etienne",
};

export async function resolveMatchFromQuestion(question: string) {
  const teams = await prisma.team.findMany({
    select: { id: true, name: true, shortName: true, tla: true },
    take: 4000,
  });

  const normalize = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u030f]/g, "")
      .toLowerCase();

  const q = normalize(question);

  // --- 1. Correspondance par nom complet -----------------------------------
  const byFullName = teams.filter((t) => {
    const candidates = [t.name, t.shortName, t.tla].filter(Boolean) as string[];
    return candidates.some((c) => {
      const needle = normalize(c);
      return needle.length >= 5 && q.includes(needle);
    });
  });

  // --- 2. Correspondance par jeton distinctif -------------------------------
  // « Bayern » doit résoudre « Bayern Munich », « Liverpool » doit résoudre
  // « Liverpool ». On n'accepte un jeton que s'il désigne une seule équipe en
  // base : dans le cas contraire on refuse de deviner (règle §34).
  // Jetons trop génériques ou ambigus pour identifier une équipe à eux seuls.
  // « milan » désigne aussi bien l'AC Milan que l'Inter : on refuse de trancher.
  const GENERIC = new Set([
    "city", "united", "real", "sport", "sporting", "club", "atletico", "athletic",
    "olympique", "racing", "union", "town", "county", "rovers", "wanderers",
    "albion", "ath", "deportivo", "cd", "fc", "sc", "ac", "as", "us", "sv", "vfl",
    "vfb", "tsg", "bsc", "ud", "rc", "sl", "fk", "sk", "bk", "if", "ff", "cf",
    "inter", "milan", "borussia", "eintracht", "saint", "paris",
  ]);

  const tokenOwners = new Map<string, Set<string>>();
  for (const team of teams) {
    const tokens = new Set(
      [team.name, team.shortName ?? ""]
        .flatMap((n) => normalize(n).split(/[^a-z0-9]+/))
        .filter((t) => t.length >= 5 && !GENERIC.has(t)),
    );
    for (const token of tokens) {
      const owners = tokenOwners.get(token) ?? new Set<string>();
      owners.add(team.id);
      tokenOwners.set(token, owners);
    }
  }

  // Les utilisateurs francophones emploient souvent le nom francisé d'un club
  // alors que les sources publient le nom d'origine. On traduit donc les jetons
  // de la question avant la recherche, jamais les données elles-mêmes.
  const questionTokens = new Set(
    q
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((token) => FRENCH_TEAM_ALIASES[token] ?? token),
  );

  const distinctive: string[] = [];
  for (const token of questionTokens) {
    const owners = tokenOwners.get(token);
    if (owners && owners.size === 1) distinctive.push([...owners][0]);
  }

  const matchedIds = [
    ...new Set([
      ...byFullName.map((t) => t.id),
      ...distinctive,
    ]),
  ];

  if (matchedIds.length === 0) return null;

  // Match impliquant au moins une des équipes citées, avec une prédiction.
  const match = await prisma.match.findFirst({
    where: {
      OR: [
        { homeTeamId: { in: matchedIds } },
        { awayTeamId: { in: matchedIds } },
      ],
      predictions: { some: { status: { in: ["PUBLISHED", "SETTLED"] } } },
    },
    include: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      predictions: {
        where: { status: { in: ["PUBLISHED", "SETTLED"] } },
        orderBy: { generatedAt: "desc" },
        take: 1,
        include: { matchResult: true, modelOutputs: true },
      },
    },
    orderBy: { utcDate: "desc" },
  });

  return match;
}

// ---------------------------------------------------------------------------
// Génération des réponses
// ---------------------------------------------------------------------------

async function loadView(matchId: string): Promise<PredictionView | null> {
  const prediction = await prisma.prediction.findFirst({
    where: { matchId, status: { in: ["PUBLISHED", "SETTLED", "GENERATED"] } },
    orderBy: { generatedAt: "desc" },
    include: {
      matchResult: true,
      modelOutputs: true,
      totalGoals: true,
      exactScore: true,
      btts: true,
      halfTime: true,
      teamGoals: true,
    },
  });
  if (!prediction) return null;
  return toDisplay(prediction);
}

const UNAVAILABLE =
  "Je ne dispose pas de cette information dans les données actuellement chargées. " +
  "SOLEIL n'invente jamais une donnée : je préfère vous l'indiquer plutôt que de produire " +
  "une réponse non fondée.";

/**
 * Point d'entrée unique de l'agent.
 * @param question question en langage naturel
 * @param matchId rencontre explicitement ciblée par l'interface (facultatif)
 */
export async function answer(input: {
  question: string;
  matchId?: string | null;
}): Promise<AIAnswer> {
  const { question } = input;
  const intent = detectIntent(question);

  // Résolution de la rencontre : contexte explicite → sinon mention dans le texte.
  let matchId = input.matchId ?? null;
  let matchLabel: string | undefined;

  if (!matchId) {
    const resolved = await resolveMatchFromQuestion(question);
    if (resolved) {
      matchId = resolved.id;
      matchLabel = `${resolved.homeTeam.name} – ${resolved.awayTeam.name}`;
    }
  }

  if (matchId) {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: {
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
        league: { select: { name: true } },
      },
    });
    if (!match) {
      return {
        intent,
        answer: UNAVAILABLE,
        evidence: [],
        followUps: [],
      };
    }
    matchLabel = `${match.homeTeam.name} – ${match.awayTeam.name}`;
    const view = await loadView(matchId);
    if (!view) {
      return {
        intent,
        answer:
          `Aucune prédiction n'a été publiée pour ${matchLabel}. ` +
          `Prédiction non publiée — données insuffisantes.`,
        evidence: [],
        followUps: ["Pourquoi aucune prédiction n'a été publiée ?", "Quelles rencontres sont disponibles ?"],
        matchRef: { id: matchId, label: matchLabel },
      };
    }
    return answerForMatch(intent, view, match, matchId, matchLabel);
  }

  // Pas de rencontre identifiée : réponses globales.
  return answerGlobal(intent);
}

// ---------------------------------------------------------------------------

function answerForMatch(
  intent: Intent,
  view: PredictionView,
  match: {
    homeTeam: { name: string };
    awayTeam: { name: string };
    league: { name: string };
    homeScore: number | null;
    awayScore: number | null;
    status: string;
  },
  matchId: string,
  matchLabel: string,
): AIAnswer {
  const home = match.homeTeam.name;
  const away = match.awayTeam.name;
  const ref = { id: matchId, label: matchLabel };

  const baseEvidence = [
    { label: "Probabilité victoire " + home, value: pct(view.outcomes.home, 1), source: "matchResult.homeWinProb" },
    { label: "Probabilité match nul", value: pct(view.outcomes.draw, 1), source: "matchResult.drawProb" },
    { label: "Probabilité victoire " + away, value: pct(view.outcomes.away, 1), source: "matchResult.awayWinProb" },
    { label: "Score de confiance SOLEIL", value: `${view.confidence.score}/100`, source: "prediction.confidenceScore" },
  ];

  const followUps = [
    "Quel est le score le plus probable ?",
    "Pourquoi Over 2.5 possède cette probabilité ?",
    "Quelle mi-temps semble la plus susceptible de produire des buts ?",
    "Comment le score de confiance est-il calculé ?",
  ];

  switch (intent) {
    case "why_winner": {
      const pick = view.consensusPick;
      const favourite =
        pick === "HOME_WIN" ? home : pick === "AWAY_WIN" ? away : null;
      const prob =
        pick === "HOME_WIN" ? view.outcomes.home : pick === "AWAY_WIN" ? view.outcomes.away : view.outcomes.draw;

      const decisiveModels = view.models
        .filter((m) => m.applicable && m.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3);

      const modelText = decisiveModels
        .map(
          (m) =>
            `le ${(m.label ?? m.name).toLowerCase()} (poids ${pct(m.weight, 1)}) estime à ${pct(
              pick === "HOME_WIN" ? m.outcomes.home : pick === "AWAY_WIN" ? m.outcomes.away : m.outcomes.draw,
              1,
            )}`,
        )
        .join(", ");

      const positives = view.explanation.positive.filter((f) => f.key !== "ml_not_trained");

      const answer =
        (favourite
          ? `Pour ${matchLabel}, SOLEIL estime ${favourite} favori avec une probabilité de ${pct(prob, 1)}. ` +
            `Cette estimation n'est pas une certitude : l'issue inverse reste possible dans ${pct(1 - prob, 1)} des cas. `
          : `Pour ${matchLabel}, l'issue la plus probable selon SOLEIL est le match nul (${pct(view.outcomes.draw, 1)}). ` +
            `La rencontre est très ouverte : aucune équipe ne se dégage nettement. `) +
        (decisiveModels.length > 0
          ? `Les modèles qui pèsent le plus dans ce consensus sont : ${modelText}. `
          : "") +
        (positives.length > 0
          ? `Facteurs identifiés : ${positives.slice(0, 3).map((f) => f.label).join(" ; ")}. `
          : "") +
        `Accord global entre modèles : ${pct(view.agreement, 0)}. ` +
        `Score de confiance : ${view.confidence.score}/100 (${view.confidence.label.toLowerCase()}).`;

      return {
        intent,
        answer,
        evidence: [
          ...baseEvidence,
          { label: "Accord entre modèles", value: pct(view.agreement, 0), source: "prediction.modelAgreement" },
          ...view.explanation.positive.slice(0, 3).map((f) => ({
            label: f.label,
            value: f.value !== null ? f.value.toFixed(2) : "—",
            source: "modelOutputs.signals",
          })),
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "why_over25": {
      const line = view.totalGoals.find((l) => l.line === 2.5);
      if (!line) {
        return { intent, answer: UNAVAILABLE, evidence: [], followUps, matchRef: ref };
      }
      const dominant = line.over >= line.under ? "Over" : "Under";
      const dominantProb = Math.max(line.over, line.under);

      const answer =
        `Pour ${matchLabel}, la probabilité Over 2.5 est de ${pct(line.over, 1)} et Under 2.5 de ${pct(line.under, 1)}. ` +
        `${dominant} 2.5 est donc l'issue majoritaire à ${pct(dominantProb, 1)}. ` +
        `Le moteur attend ${num(view.expectedGoals.total)} buts au total ` +
        `(${home} ${num(view.expectedGoals.home)}, ${away} ${num(view.expectedGoals.away)}). ` +
        `Cette intensité provient de la confrontation des forces offensives et défensives ajustées ` +
        `à la moyenne de la compétition, puis d'une correction de dépendance sur les scores serrés (Dixon–Coles). ` +
        `Confiance attribuée à cette ligne : ${line.confidence}/100.`;

      return {
        intent,
        answer,
        evidence: [
          { label: "Over 2.5", value: pct(line.over, 1), source: "totalGoals.ou25Over" },
          { label: "Under 2.5", value: pct(line.under, 1), source: "totalGoals.ou25Under" },
          { label: "Écart Over/Under", value: pct(line.spread, 1), source: "calculé" },
          { label: "Buts attendus totaux", value: num(view.expectedGoals.total), source: "totalGoals.expectedGoals" },
          { label: "Confiance de la ligne", value: `${line.confidence}/100`, source: "totalGoals.ou25Confidence" },
        ],
        followUps: [
          "Quel est le score le plus probable ?",
          "Quelle mi-temps semble la plus susceptible de produire des buts ?",
          "Quelle équipe possède l'avantage offensif ?",
        ],
        matchRef: ref,
      };
    }

    case "most_likely_score": {
      const top = view.exactScore;
      const others = top.top.slice(1, 6);

      const answer =
        `Pour ${matchLabel}, le score le plus probable est ${top.mostLikely.score}, ` +
        `avec seulement ${pct(top.mostLikely.probability, 1)} de probabilité. ` +
        `Les scores suivants sont : ` +
        others.map((s) => `${s.score} (${pct(s.probability, 1)})`).join(", ") +
        `. ${top.disclaimer}`;

      return {
        intent,
        answer,
        evidence: [
          { label: `Score ${top.mostLikely.score}`, value: pct(top.mostLikely.probability, 1), source: "exactScore.mostLikelyScore" },
          ...others.slice(0, 4).map((s) => ({
            label: `Score ${s.score}`,
            value: pct(s.probability, 1),
            source: "exactScore.topScores",
          })),
          {
            label: "Somme des 5 scores les plus probables",
            value: pct(top.top.slice(0, 5).reduce((a, s) => a + s.probability, 0), 1),
            source: "calculé",
          },
        ],
        followUps: [
          "Pourquoi Over 2.5 possède cette probabilité ?",
          "Quelle mi-temps semble la plus susceptible de produire des buts ?",
          "Comment le score de confiance est-il calculé ?",
        ],
        matchRef: ref,
      };
    }

    case "offensive_advantage": {
      const hx = view.derived.homeXgPerMatch;
      const ax = view.derived.awayXgPerMatch;

      const attackLine =
        view.derived.homeAttackStrength >= view.derived.awayAttackStrength
          ? `${home} présente la force offensive contextuelle la plus élevée`
          : `${away} présente la force offensive contextuelle la plus élevée`;

      const xgLine =
        hx !== null && ax !== null
          ? `Sur les xG par match, ${home} affiche ${num(hx)} et ${away} ${num(ax)}.`
          : `Les données xG ne sont pas disponibles pour cette rencontre : l'avantage offensif est évalué à partir des buts réels et des tirs, pas d'une estimation xG inventée.`;

      const answer =
        `Pour ${matchLabel} : ${attackLine}. ` +
        `${home} — attaque ${num(view.derived.homeAttackStrength)}, défense ${num(view.derived.homeDefenseStrength)}. ` +
        `${away} — attaque ${num(view.derived.awayAttackStrength)}, défense ${num(view.derived.awayDefenseStrength)}. ` +
        `Ces valeurs sont exprimées en multiple de la moyenne de la compétition (1,00 = moyenne). ` +
        `${xgLine} ` +
        `Buts attendus : ${num(view.expectedGoals.home)} pour ${home}, ${num(view.expectedGoals.away)} pour ${away}.`;

      return {
        intent,
        answer,
        evidence: [
          { label: `Attaque ${home}`, value: num(view.derived.homeAttackStrength), source: "derived.homeAttackStrength" },
          { label: `Défense ${home}`, value: num(view.derived.homeDefenseStrength), source: "derived.homeDefenseStrength" },
          { label: `Attaque ${away}`, value: num(view.derived.awayAttackStrength), source: "derived.awayAttackStrength" },
          { label: `Défense ${away}`, value: num(view.derived.awayDefenseStrength), source: "derived.awayDefenseStrength" },
          {
            label: "xG/match (domicile)",
            value: hx !== null ? num(hx) : "Donnée indisponible",
            source: "derived.homeXgPerMatch",
          },
          {
            label: "xG/match (extérieur)",
            value: ax !== null ? num(ax) : "Donnée indisponible",
            source: "derived.awayXgPerMatch",
          },
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "which_half": {
      const fh = view.halfTime.firstHalf;
      const sh = view.halfTime.secondHalf;
      const moreLikely = fh.expectedGoals >= sh.expectedGoals ? "première" : "seconde";

      const answer =
        `Pour ${matchLabel}, la ${moreLikely} mi-temps est la plus susceptible de produire des buts. ` +
        `Première mi-temps : ${num(fh.expectedGoals)} but attendu, probabilité d'au moins un but ` +
        `${pct(fh.probAtLeastOneGoal, 1)}. ` +
        `Deuxième mi-temps : ${num(sh.expectedGoals)} but attendu, probabilité d'au moins un but ` +
        `${pct(sh.probAtLeastOneGoal, 1)}. ` +
        `Ces intensités sont dérivées de la part de buts réellement observée en première mi-temps ` +
        `dans cette compétition et pour ces deux équipes — aucun ratio arbitraire n'est appliqué. ` +
        `Over 0.5 en première mi-temps : ${pct(fh.overUnder.find((l) => l.line === 0.5)?.over ?? 0, 1)}.`;

      return {
        intent,
        answer,
        evidence: [
          { label: "Buts attendus 1re MT", value: num(fh.expectedGoals), source: "halfTime.htExpectedGoals" },
          { label: "Buts attendus 2e MT", value: num(sh.expectedGoals), source: "halfTime.stExpectedGoals" },
          { label: "≥ 1 but en 1re MT", value: pct(fh.probAtLeastOneGoal, 1), source: "halfTime.probGoalInFirstHalf" },
          { label: "≥ 1 but en 2e MT", value: pct(sh.probAtLeastOneGoal, 1), source: "halfTime.probGoalInSecondHalf" },
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "btts": {
      const answer =
        `Pour ${matchLabel}, la probabilité que les deux équipes marquent (BTTS Oui) est de ` +
        `${pct(view.btts.yes, 1)}, contre ${pct(view.btts.no, 1)} pour BTTS Non. ` +
        `Confiance de cette ligne : ${view.btts.confidence}/100. ` +
        `Le modèle s'appuie sur la distribution conjointe des scores : une équipe qui ne marque pas ` +
        `dans ${pct(1 - Math.min(view.outcomes.home + view.outcomes.draw, 1), 1)} des scénarios rend BTTS Non plus probable.`;

      return {
        intent,
        answer,
        evidence: [
          { label: "BTTS Oui", value: pct(view.btts.yes, 1), source: "btts.yesProb" },
          { label: "BTTS Non", value: pct(view.btts.no, 1), source: "btts.noProb" },
          { label: "Confiance", value: `${view.btts.confidence}/100`, source: "btts.confidence" },
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "confidence_explanation": {
      const c = view.confidence.components;
      const penalties = view.confidence.penalties;

      const answer =
        `Le score de confiance de ${matchLabel} est de ${view.confidence.score}/100 ` +
        `(${view.confidence.label.toLowerCase()}). Il n'est pas arbitraire : il combine cinq composantes mesurées — ` +
        `qualité des données ${c.dataQuality}/100 (poids 35 %), volume de données ${c.dataVolume}/100 (15 %), ` +
        `accord entre modèles ${c.modelAgreement}/100 (25 %), stabilité des statistiques ${c.stability}/100 (12 %) ` +
        `et cohérence des indicateurs ${c.coherence}/100 (13 %). ` +
        (penalties.length > 0
          ? `${penalties.length} anomalie(s) ont ensuite réduit le score : ` +
            penalties.map((p) => `${p.code.toLowerCase().replace(/_/g, " ")} (−${p.points})`).join(", ") +
            ". "
          : "Aucune anomalie n'a entraîné de pénalité. ") +
        `Sous le seuil de 45/100, SOLEIL ne publie pas de prédiction.`;

      return {
        intent,
        answer,
        evidence: [
          { label: "Score final", value: `${view.confidence.score}/100`, source: "confidence.score" },
          { label: "Qualité des données", value: `${c.dataQuality}/100`, source: "dataQuality.score" },
          { label: "Volume de données", value: `${c.dataVolume}/100`, source: "confidence.components" },
          { label: "Accord entre modèles", value: `${c.modelAgreement}/100`, source: "confidence.components" },
          { label: "Stabilité", value: `${c.stability}/100`, source: "confidence.components" },
          { label: "Cohérence", value: `${c.coherence}/100`, source: "confidence.components" },
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "data_quality": {
      const q = view.dataQuality;
      const answer =
        `Pour ${matchLabel}, la qualité des données est jugée « ${q.label.toLowerCase()} » (${q.score}/100). ` +
        `Décomposition : volume ${q.components.volume}/100, fraîcheur ${q.components.recency}/100, ` +
        `richesse des champs ${q.components.richness}/100, diversité des sources ${q.components.sourceDiversity}/100, ` +
        `couverture ${q.components.coverage}/100. ` +
        `Champs disponibles : ${q.usedFields.length > 0 ? q.usedFields.join(", ") : "aucun champ avancé"}. ` +
        `Champs manquants : ${q.missingFields.length > 0 ? q.missingFields.join(", ") : "aucun"}. ` +
        `Sources : ${q.sources.map((s) => s.name).join(", ") || "non renseignées"}.`;

      return {
        intent,
        answer,
        evidence: [
          { label: "Qualité globale", value: `${q.score}/100 (${q.label})`, source: "prediction.dataQuality" },
          { label: "Volume", value: `${q.components.volume}/100`, source: "qualité — composante" },
          { label: "Fraîcheur", value: `${q.components.recency}/100`, source: "qualité — composante" },
          { label: "Richesse", value: `${q.components.richness}/100`, source: "qualité — composante" },
          { label: "Sources", value: q.sources.map((s) => s.name).join(", ") || "—", source: "traçabilité" },
        ],
        followUps,
        matchRef: ref,
      };
    }

    case "method": {
      return {
        intent,
        answer: METHOD_ANSWER,
        evidence: view.models
          .filter((m) => m.applicable)
          .map((m) => ({
            label: m.label ?? m.name,
            value: `poids ${pct(m.weight, 1)}`,
            source: "modelOutputs",
          })),
        followUps,
        matchRef: ref,
      };
    }

    default: {
      const actual =
        match.status === "FINISHED" && match.homeScore !== null
          ? `Résultat final : ${match.homeScore}–${match.awayScore}. `
          : "";

      const answer =
        `${matchLabel} (${match.league.name}). ${actual}` +
        `${view.explanation.summary} ` +
        `Détail : victoire ${home} ${pct(view.outcomes.home, 1)}, nul ${pct(view.outcomes.draw, 1)}, ` +
        `victoire ${away} ${pct(view.outcomes.away, 1)}. ` +
        `Score de confiance ${view.confidence.score}/100, qualité des données « ${view.dataQuality.label.toLowerCase()} ».`;

      return {
        intent: "match_summary",
        answer,
        evidence: baseEvidence,
        followUps,
        matchRef: ref,
      };
    }
  }
}

// ---------------------------------------------------------------------------

async function answerGlobal(intent: Intent): Promise<AIAnswer> {
  if (intent === "method") {
    return { intent, answer: METHOD_ANSWER, evidence: [], followUps: DEFAULT_FOLLOWUPS };
  }

  if (intent === "best_picks") {
    const picks = await prisma.prediction.findMany({
      where: {
        status: "PUBLISHED",
        confidenceScore: { gte: 60 },
        match: { status: "SCHEDULED", utcDate: { gt: new Date() } },
      },
      include: {
        match: { include: { homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } },
      },
      orderBy: { confidenceScore: "desc" },
      take: 5,
    });

    if (picks.length === 0) {
      const settled = await prisma.prediction.findMany({
        where: { status: "SETTLED", confidenceScore: { gte: 68 } },
        include: {
          match: {
            include: {
              homeTeam: { select: { name: true } },
              awayTeam: { select: { name: true } },
            },
          },
        },
        orderBy: { confidenceScore: "desc" },
        take: 5,
      });

      if (settled.length === 0) {
        return {
          intent,
          answer:
            "Aucune prédiction ne dépasse actuellement le seuil de confiance de 60/100. " +
            "SOLEIL ne présente pas de sélection tant que les critères ne sont pas réunis.",
          evidence: [],
          followUps: DEFAULT_FOLLOWUPS,
        };
      }

      return {
        intent,
        answer:
          `Aucune rencontre à venir n'est disponible dans les sources en ce moment. ` +
          `Voici les dernières prédictions publiées à confiance élevée (historique réglé) : ` +
          settled
            .map((p) => `${p.match.homeTeam.name} – ${p.match.awayTeam.name} (confiance ${p.confidenceScore}/100)`)
            .join(" ; ") +
          ". Ces rencontres sont déjà jouées : elles illustrent le fonctionnement du moteur, elles ne constituent pas des sélections à venir.",
        evidence: settled.map((p) => ({
          label: `${p.match.homeTeam.name} – ${p.match.awayTeam.name}`,
          value: `${p.confidenceScore}/100`,
          source: "prediction.confidenceScore",
        })),
        followUps: DEFAULT_FOLLOWUPS,
      };
    }

    return {
      intent,
      answer:
        `Voici les prédictions à venir les plus solides selon les critères SOLEIL (confiance ≥ 60/100, ` +
        `qualité de données vérifiée, accord entre modèles mesuré) : ` +
        picks
          .map((p) => `${p.match.homeTeam.name} – ${p.match.awayTeam.name} (confiance ${p.confidenceScore}/100)`)
          .join(" ; ") +
        ". Ces sélections ne sont jamais garanties : elles répondent à des critères statistiques objectifs.",
      evidence: picks.map((p) => ({
        label: `${p.match.homeTeam.name} – ${p.match.awayTeam.name}`,
        value: `${p.confidenceScore}/100`,
        source: "prediction.confidenceScore",
      })),
      followUps: DEFAULT_FOLLOWUPS,
    };
  }

  // Intentions qui exigent une rencontre identifiée : on demande à
  // l'utilisateur de préciser plutôt que de produire une réponse creuse.
  const NEEDS_MATCH: Intent[] = [
    "match_summary",
    "why_winner",
    "why_over25",
    "most_likely_score",
    "offensive_advantage",
    "which_half",
    "btts",
    "confidence_explanation",
    "data_quality",
  ];

  if (NEEDS_MATCH.includes(intent)) {
    const available = await prisma.prediction.findFirst({
      where: { status: { in: ["PUBLISHED", "SETTLED"] } },
      include: {
        match: {
          include: {
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        },
      },
      orderBy: { generatedAt: "desc" },
    });

    const example = available
      ? `« ${available.match.homeTeam.name} contre ${available.match.awayTeam.name} »`
      : "« Arsenal contre Chelsea »";

    return {
      intent,
      answer:
        `Précisez la rencontre qui vous intéresse, par exemple ${example} : ` +
        "je répondrai uniquement à partir des données disponibles pour ce match. " +
        "Sans rencontre identifiée, je ne peux pas produire d'analyse fondée — et je préfère " +
        "vous le dire plutôt que d'inventer une réponse.",
      evidence: [],
      followUps: [
        "Quelles sont les meilleures prédictions ?",
        "Comment fonctionne le moteur SOLEIL ?",
      ],
    };
  }

  return {
    intent: "unknown",
    answer:
      "Je n'ai pas identifié de question correspondant à mes capacités d'analyse. " +
      "Je peux expliquer une prédiction, détailler un marché (Over/Under, BTTS, score exact, mi-temps), " +
      "justifier un score de confiance ou décrire la qualité des données utilisées. " +
      "Je réponds exclusivement à partir des données disponibles et je n'invente jamais une valeur.",
    evidence: [],
    followUps: DEFAULT_FOLLOWUPS,
  };
}

const DEFAULT_FOLLOWUPS = [
  "Pourquoi Soleil pense que cette équipe va gagner ?",
  "Pourquoi Over 2.5 possède cette probabilité ?",
  "Quel est le score le plus probable ?",
  "Quelle mi-temps semble la plus susceptible de produire des buts ?",
];

const METHOD_ANSWER =
  "Le moteur SOLEIL enchaîne six étapes, toutes fondées sur des données réelles. " +
  "1) Collecte multi-source : résultats, scores à la mi-temps, tirs, corners et cartons — " +
  "chaque valeur est tracée avec sa source et sa date. " +
  "2) Construction des forces : attaque et défense de chaque équipe sont exprimées en multiple " +
  "de la moyenne de la compétition, avec un repli progressif vers la moyenne quand l'échantillon est faible. " +
  "3) Cinq modèles complémentaires : Poisson corrigé par Dixon–Coles pour la dépendance des scores serrés, " +
  "distribution statistique empirique, Expected Goals lorsqu'ils sont disponibles, forme récente pondérée " +
  "par récence, et avantage domicile/extérieur. " +
  "4) Consensus pondéré : chaque modèle reçoit un poids selon sa fiabilité observée, sa confiance " +
  "intrinsèque et sa divergence par rapport aux autres ; aucun modèle ne peut dépasser 45 % du poids total. " +
  "5) Calcul des marchés à partir d'une matrice conjointe de scores : 1X2, Over/Under, buts par équipe, " +
  "mi-temps, BTTS et score exact. " +
  "6) Score de confiance et détection d'anomalies : si les données ne permettent pas une estimation " +
  "fiable, la prédiction est retirée et l'application affiche « Prédiction non publiée — données insuffisantes ». " +
  "SOLEIL n'entraîne pas encore de modèle de machine learning : ce composant est déclaré non applicable " +
  "plutôt que simulé.";
