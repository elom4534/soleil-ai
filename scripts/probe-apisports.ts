/**
 * ============================================================================
 * SOLEIL — Profil de sonde : API-SPORTS / API-Football
 * ============================================================================
 * Conservé pour deux raisons :
 *   1. L'utilisateur peut basculer sur ce fournisseur plus tard ;
 *   2. La comparaison entre fournisseurs (§17) exige de pouvoir rejouer le
 *      même plan ailleurs.
 *
 * Ce profil n'est PAS celui utilisé par défaut : le fournisseur de
 * l'utilisateur est LiveFootballApi (voir `probe-lfa.ts`).
 */

import { asObject, detectScores, detectXg, findKeys, surveyFields, type ProbeContext, type ProbeProfile, type ProbeStep, type StepAnalysis } from "./probe-kit";

// ---------------------------------------------------------------------------
// Plan de sonde — 10 étapes, 10 crédits au maximum
// ---------------------------------------------------------------------------

export const API_SPORTS_STEPS: ProbeStep[] = [
  {
    key: "leagues",
    question:
      "L'authentification fonctionne-t-elle, et quelles données sont couvertes par compétition (xG, statistiques, événements) ?",
    endpoint: "leagues",
    params: () => ({ country: "England", current: "true" }),
    cost: 1,
    required: true,
    ttlSeconds: 86_400,
  },
  {
    key: "seasons",
    question: "Quelle profondeur historique est disponible ?",
    endpoint: "leagues/seasons",
    params: () => ({}),
    cost: 1,
    required: false,
    ttlSeconds: 86_400,
  },
  {
    key: "fixtures_today",
    question:
      "Les matchs à venir d'aujourd'hui sont-ils accessibles ? C'est l'endpoint de la page « Matchs du jour ».",
    endpoint: "fixtures",
    params: (ctx) => ({ date: ctx.today, timezone: "UTC" }),
    cost: 1,
    required: true,
    ttlSeconds: 300,
  },
  {
    key: "last_fixture",
    question: "Un match terminé récent est-il récupérable avec son score final et son score à la mi-temps ?",
    endpoint: "fixtures",
    params: (ctx) => ({ league: ctx.league, season: ctx.season, last: 1 }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
  },
  {
    key: "fixtures_next",
    question: "Les matchs à venir d'une compétition sont-ils accessibles (calendrier) ?",
    endpoint: "fixtures",
    params: (ctx) => ({ league: ctx.league, season: ctx.season, next: 3 }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
  },
  {
    key: "statistics",
    question: "Quelles statistiques de match sont réellement fournies ? Contient-elle l'expected goals ?",
    endpoint: "fixtures/statistics",
    params: (ctx) => ({ fixture: ctx.fixtureId }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.fixtureId ? null : "Identifiant de match indisponible."),
  },
  {
    key: "events",
    question: "Les événements de but sont-ils fournis avec leur minute (analyse par mi-temps) ?",
    endpoint: "fixtures/events",
    params: (ctx) => ({ fixture: ctx.fixtureId }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.fixtureId ? null : "Identifiant de match indisponible."),
  },
  {
    key: "team_statistics",
    question:
      "Les statistiques agrégées d'une équipe (forme, domicile/extérieur, buts marqués/encaissés) sont-elles disponibles ?",
    endpoint: "teams/statistics",
    params: (ctx) => ({ league: ctx.league, season: ctx.season, team: ctx.teamId ?? 0 }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.teamId ? null : "Identifiant d'équipe indisponible."),
  },
  {
    key: "standings",
    question: "Le classement complet est-il disponible (points, différence de buts, forme) ?",
    endpoint: "standings",
    params: (ctx) => ({ league: ctx.league, season: ctx.season }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
  },
  {
    key: "h2h",
    question: "Les confrontations directes entre deux équipes sont-elles disponibles ?",
    endpoint: "fixtures/headtohead",
    params: (ctx) => ({
      h2h: ctx.homeTeamId && ctx.awayTeamId ? `${ctx.homeTeamId}-${ctx.awayTeamId}` : undefined,
      last: 5,
    }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) =>
      ctx.homeTeamId && ctx.awayTeamId ? null : "Identifiants d'équipes indisponibles.",
  },
];

// ---------------------------------------------------------------------------
// Lecture des réponses
// ---------------------------------------------------------------------------

/** Repère les types de statistiques déclarés (forme API-SPORTS : {type, value}). */
function extractStatisticTypes(raw: unknown): string[] {
  const types = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth <= 0 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth - 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.type === "string") types.add(obj.type);
    for (const value of Object.values(obj)) walk(value, depth - 1);
  };
  walk(raw, 7);
  return [...types].sort();
}

/** Extrait le bloc « coverage » d'une réponse de compétition. */
function extractCoverage(raw: unknown): Record<string, unknown> | null {
  const entries = Array.isArray(raw) ? raw : [];
  for (const entry of entries) {
    const league = (entry as { league?: { coverage?: Record<string, unknown> } })?.league;
    if (league?.coverage) return league.coverage;
  }
  return null;
}

function analyseApiSports(key: string, raw: unknown): StepAnalysis {
  switch (key) {
    case "leagues": {
      const coverage = extractCoverage(raw);
      return {
        answers: coverage
          ? [
              "Bloc de couverture déclaré par le fournisseur pour la première compétition :",
              Object.entries(coverage)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" · "),
            ]
          : ["Aucun bloc de couverture renvoyé pour la compétition testée."],
        evidence: { coverage },
      };
    }
    case "statistics": {
      const types = extractStatisticTypes(raw);
      const xg = detectXg(raw);
      return {
        answers: [
          `${types.length} type(s) de statistique renvoyé(s).`,
          xg.present
            ? `xG : PRÉSENT — ${xg.evidence.slice(0, 4).join(" · ")}`
            : "xG : ABSENT de cette réponse.",
          ...(types.length > 0 ? [`Libellés : ${types.join(" · ")}`] : []),
        ],
        evidence: { statisticTypes: types, xg },
      };
    }
    case "last_fixture":
    case "fixtures_today":
    case "fixtures_next": {
      const scores = detectScores(raw);
      return {
        answers: [
          `Score final détecté : ${scores.final ? "oui" : "non"} · score à la mi-temps détecté : ${scores.halftime ? "oui" : "non"}.`,
        ],
        evidence: { scores, fields: surveyFields(raw, 4).slice(0, 60) },
      };
    }
    case "seasons": {
      const seasons = Array.isArray(raw) ? raw : [];
      return {
        answers: [`${seasons.length} saison(s) listée(s) : ${seasons.join(", ") || "aucune"}.`],
        evidence: { seasons },
      };
    }
    default:
      return {
        answers: [],
        evidence: { fields: surveyFields(raw, 5).slice(0, 80) },
      };
  }
}

/** Renseigne les identifiants nécessaires aux étapes suivantes. */
function hydrateApiSports(key: string, raw: unknown, ctx: ProbeContext): void {
  if (!Array.isArray(raw)) return;
  if (key === "last_fixture" || key === "fixtures_today") {
    const first = raw[0] as
      | { fixture?: { id?: number }; teams?: { home?: { id?: number }; away?: { id?: number } } }
      | undefined;
    if (first?.fixture?.id) ctx.fixtureId = first.fixture.id;
    if (first?.teams?.home?.id) ctx.homeTeamId = first.teams.home.id;
    if (first?.teams?.away?.id) ctx.awayTeamId = first.teams.away.id;
    if (!ctx.teamId) ctx.teamId = ctx.homeTeamId;
  }
}

export const API_SPORTS_PROFILE: ProbeProfile = {
  label: "API-Football / API-SPORTS — audit (10 étapes, 10 crédits au maximum)",
  steps: API_SPORTS_STEPS,
  // Palier gratuit : 10 requêtes/minute.
  minIntervalMs: 1200,
  analyse: (key, raw) => analyseApiSports(key, raw),
  hydrate: hydrateApiSports,
};

/** Exposé pour les tests et pour la lecture manuelle des réponses. */
export const apiSportsInternals = { findKeys, asObject };
