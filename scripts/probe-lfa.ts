/**
 * ============================================================================
 * SOLEIL — Profil de sonde : LiveFootballApi (live-football-api.com)
 * ============================================================================
 * Fournisseur retenu par l'utilisateur. Caractéristiques connues d'après la
 * documentation officielle (relevée le 29/09/2026) :
 *   · URL de base   : https://live-football-api.com/api/v1
 *   · Authentification : paramètre de requête `api_key`
 *   · Facturation   : 1 crédit par appel (les crédits n'expirent jamais),
 *                     500 crédits offerts à l'ouverture du compte
 *   · Débit         : 2 req/s soutenues (palier Starter), 429 si dépassement
 *   · Erreurs       : 400 / 401 / 403 (crédits insuffisants ou quota du jour)
 *                     / 429 / 500 / 503
 *   · Réponse       : { success, credits_remaining, data, timestamp }
 *   · Webhooks      : inscription gratuite, 1 crédit par but notifié
 *
 * Le plan ci-dessous n'est PAS une lecture de la documentation : c'est la
 * vérification, sur données réelles, de ce que la documentation annonce — et
 * la découverte de ce qu'elle ne dit pas (liste exacte des statistiques).
 */

import {
  asArray,
  asObject,
  at,
  detectXg,
  distribution,
  fillRate,
  surveyFields,
  type ProbeContext,
  type ProbeProfile,
  type ProbeStep,
  type StepAnalysis,
} from "./probe-kit";

// ---------------------------------------------------------------------------
// Détection des compétitions africaines — enjeu direct pour SOLEIL
// ---------------------------------------------------------------------------

/** Pays et compétitions africains recherchés dans la réponse `/leagues`. */
const AFRICAN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "Togo", pattern: /togo/i },
  { label: "Ghana", pattern: /ghana/i },
  { label: "Nigeria", pattern: /nigeria/i },
  { label: "Côte d'Ivoire", pattern: /ivory|c[oô]te d.?ivoire/i },
  { label: "Sénégal", pattern: /s[eé]n[eé]gal/i },
  { label: "Cameroun", pattern: /camer?oun/i },
  { label: "Bénin", pattern: /b[eé]nin/i },
  { label: "Burkina Faso", pattern: /burkina/i },
  { label: "Mali", pattern: /mali/i },
  { label: "Guinée", pattern: /guin[eé]/i },
  { label: "Gabon", pattern: /gabon/i },
  { label: "Congo", pattern: /congo/i },
  { label: "Angola", pattern: /angola/i },
  { label: "Zambie", pattern: /zambia/i },
  { label: "Kenya", pattern: /kenya/i },
  { label: "Tanzanie", pattern: /tanzania/i },
  { label: "Ouganda", pattern: /uganda/i },
  { label: "Éthiopie", pattern: /ethiopia/i },
  { label: "Afrique du Sud", pattern: /south africa/i },
  { label: "Maroc", pattern: /morocco|maroc/i },
  { label: "Algérie", pattern: /algeria|alg[eé]rie/i },
  { label: "Tunisie", pattern: /tunisia|tunisie/i },
  { label: "Égypte", pattern: /egypt|[eé]gypte/i },
  { label: "CAF / Afrique", pattern: /\bcaf\b|africa|afrique|afcon|continent/i },
];

interface LeagueRef {
  id: string;
  name: string;
  country: string;
}

/** Aplatit `/leagues` en une liste plate de compétitions. */
function flattenLeagues(data: unknown): { countries: string[]; leagues: LeagueRef[] } {
  const root = asObject(data);
  const groups = asArray(root.data);
  const countries: string[] = [];
  const leagues: LeagueRef[] = [];
  for (const group of groups) {
    const g = asObject(group);
    const country = String(g.country ?? "");
    if (country) countries.push(country);
    for (const league of asArray(g.leagues)) {
      const l = asObject(league);
      leagues.push({ id: String(l.id ?? ""), name: String(l.name ?? ""), country });
    }
  }
  return { countries, leagues };
}

/** Compétitions dont le pays ou le nom évoque l'Afrique. */
function africanLeagues(leagues: LeagueRef[]): { label: string; league: LeagueRef }[] {
  const found: { label: string; league: LeagueRef }[] = [];
  for (const league of leagues) {
    const haystack = `${league.country} ${league.name}`;
    for (const { label, pattern } of AFRICAN_PATTERNS) {
      if (pattern.test(haystack)) {
        found.push({ label, league });
        break;
      }
    }
  }
  return found;
}

/**
 * Compétitions de référence, par ordre de préférence.
 *
 * La correspondance EXIGE le pays : chercher « Premier League » seul ramenait
 * le premier résultat par ordre alphabétique — c'est-à-dire une Premier League
 * africaine ou sud-américaine, pas la compétition visée. Une compétition mal
 * choisie fausse silencieusement tout l'audit : c'est exactement le genre
 * d'erreur que la sonde doit rendre impossible.
 */
const REFERENCE_LEAGUES: { country: RegExp; name: RegExp }[] = [
  { country: /^england$/i, name: /^premier league$/i },
  { country: /^spain$/i, name: /^laliga$/i },
  { country: /^france$/i, name: /^ligue 1$/i },
  { country: /^italy$/i, name: /^serie a$/i },
  { country: /^germany$/i, name: /^bundesliga$/i },
];

/**
 * Compétitions africaines prioritaires : le Togo d'abord (public de SOLEIL),
 * puis les championnats nationaux les plus susceptibles d'intéresser.
 */
const AFRICAN_REFERENCE: { country: RegExp; name: RegExp }[] = [
  { country: /^togo$/i, name: /national championship|championnat|premier league/i },
  { country: /^ivory coast$/i, name: /^league 1$/i },
  { country: /^senegal$/i, name: /^league 1$/i },
  { country: /^ghana$/i, name: /^premier league$/i },
  { country: /^nigeria$/i, name: /^premier league$/i },
  { country: /^cameroon$/i, name: /^elite league 1$/i },
  { country: /^mali$/i, name: /^premier league$/i },
];

function pickReferenceLeague(leagues: LeagueRef[]): LeagueRef | null {
  for (const want of REFERENCE_LEAGUES) {
    const hit = leagues.find((l) => want.country.test(l.country) && want.name.test(l.name));
    if (hit) return hit;
  }
  return null;
}

/** Championnat africain de référence, Togo en premier. */
function pickAfricanLeague(leagues: LeagueRef[]): LeagueRef | null {
  for (const want of AFRICAN_REFERENCE) {
    const hit = leagues.find((l) => want.country.test(l.country) && want.name.test(l.name));
    if (hit) return hit;
  }
  // Repli : une compétition continentale plutôt qu'aucune.
  const continental = leagues.find((l) => /caf champions league/i.test(l.name));
  return continental ?? null;
}

// ---------------------------------------------------------------------------
// Lecture des listes de rencontres (formes différentes selon l'endpoint)
// ---------------------------------------------------------------------------

/** Normalise les rencontres de `/matches`, `/league_fixtures`, `/team_matches`. */
function normalizeMatches(raw: unknown): Record<string, unknown>[] {
  const root = asObject(raw);
  const data = asObject(root.data);

  // /matches → data.matches[]
  const direct = asArray(data.matches);
  if (direct.length > 0) return direct.map(asObject);

  // /league_fixtures → data.weeks[].matches[]
  const weeks = asArray(data.weeks);
  if (weeks.length > 0) {
    const all: Record<string, unknown>[] = [];
    for (const week of weeks) all.push(...asArray(asObject(week).matches).map(asObject));
    return all;
  }
  return [];
}

interface MatchSurvey {
  count: number;
  live: number;
  finished: number;
  upcoming: number;
  halftimeFilled: number;
  scoresFilled: number;
  kickoffFilled: number;
  leagueIdFilled: number;
  dates: string[];
  fieldCoverage: { field: string; percent: number }[];
  statusLabels: Record<string, number>;
}

/**
 * Couverture des champs utiles au moteur de prédiction.
 *
 * `fallbackDate` : sur `/matches`, la date vit dans l'enveloppe (`data.date`) et
 * non dans chaque rencontre — sans ce repli, la sonde ne saurait pas dire
 * quelle journée elle a réellement interrogée.
 */
function surveyMatches(
  matches: Record<string, unknown>[],
  fallbackDate?: string,
): MatchSurvey {
  const halftime = fillRate(matches, (m) => {
    const h = at(m, "halftime.home");
    const a = at(m, "halftime.away");
    return h === null || a === null ? undefined : `${h}-${a}`;
  });
  const scores = fillRate(matches, (m) => {
    const h = at(m, "home.score");
    const a = at(m, "away.score");
    return h === null || a === null ? undefined : `${h}-${a}`;
  });
  const kickoff = fillRate(matches, (m) => at(m, "kickoff") ?? at(m, "date"));
  const leagueId = fillRate(matches, (m) => at(m, "league.id"));

  const dates = matches
    .map((m) => String(at(m, "date") ?? ""))
    .filter((d) => d.length > 0)
    .sort();
  if (dates.length === 0 && fallbackDate) dates.push(fallbackDate);

  const states = distribution(matches, (m) => at(m, "status.state") ?? at(m, "status"));

  const isLive = (m: Record<string, unknown>) =>
    at(m, "status.is_live") === true || String(at(m, "status.state")) === "inPlay";
  const isFinished = (m: Record<string, unknown>) =>
    /postGame|finished|FT|AET|PEN/i.test(
      `${String(at(m, "status.state"))} ${String(at(m, "status.status"))} ${String(at(m, "status"))}`,
    );

  return {
    count: matches.length,
    live: matches.filter(isLive).length,
    finished: matches.filter(isFinished).length,
    upcoming: matches.filter((m) => !isLive(m) && !isFinished(m)).length,
    halftimeFilled: halftime.percent,
    scoresFilled: scores.percent,
    kickoffFilled: kickoff.percent,
    leagueIdFilled: leagueId.percent,
    dates,
    fieldCoverage: [
      { field: "id", percent: fillRate(matches, (m) => m.id).percent },
      { field: "league.id", percent: leagueId.percent },
      { field: "league.country", percent: fillRate(matches, (m) => at(m, "league.country")).percent },
      { field: "horaire (kickoff/date)", percent: kickoff.percent },
      { field: "status.state", percent: fillRate(matches, (m) => at(m, "status.state")).percent },
      { field: "home.id", percent: fillRate(matches, (m) => at(m, "home.id")).percent },
      { field: "home.name", percent: fillRate(matches, (m) => at(m, "home.name")).percent },
      { field: "home.score", percent: fillRate(matches, (m) => at(m, "home.score")).percent },
      { field: "halftime.home+away", percent: halftime.percent },
      { field: "week / round", percent: fillRate(matches, (m) => m.week ?? m.round).percent },
    ],
    statusLabels: states,
  };
}

/** Constats communs à toute liste de rencontres. */
function matchSurveyAnswers(title: string, survey: MatchSurvey): string[] {
  const lines = [
    `${title} : ${survey.count} rencontre(s) — ${survey.live} en direct, ${survey.finished} terminée(s), ${survey.upcoming} à venir.`,
  ];
  if (survey.dates.length > 0) {
    lines.push(
      `Dates couvertes par la réponse : ${survey.dates[0]} → ${survey.dates[survey.dates.length - 1]}.`,
    );
  }
  lines.push(
    `Score final présent sur ${survey.scoresFilled} % des rencontres · score à la mi-temps sur ${survey.halftimeFilled} %.`,
  );
  if (survey.count > 0) {
    const weak = survey.fieldCoverage.filter((f) => f.percent < 100);
    lines.push(
      weak.length === 0
        ? "Tous les champs attendus sont renseignés à 100 %."
        : `Champs incomplets : ${weak.map((f) => `${f.field} ${f.percent} %`).join(" · ")}.`,
    );
    lines.push(
      `États rencontrés : ${Object.entries(survey.statusLabels)
        .slice(0, 8)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ")}.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Lecture de `/live_match_details` — la vérification décisive
// ---------------------------------------------------------------------------

interface DetailsSurvey {
  statsLabels: string[];
  statsCount: number;
  eventsCount: number;
  eventTypes: Record<string, number>;
  eventsWithMinute: number;
  hasHalftimeSplit: boolean;
  keys: string[];
  xg: { present: boolean; evidence: string[]; paths: string[] };
  filled: Record<string, boolean>;
}

function surveyDetails(raw: unknown): DetailsSurvey {
  const data = asObject(asObject(raw).data);
  const stats = asArray(data.stats);
  const events = asArray(data.events);

  const labels = [...new Set(stats.map((s) => String(asObject(s).label ?? "")))]
    .filter((l) => l.length > 0)
    .sort();

  const eventsWithMinute = events.filter((e) => {
    const t = asObject(e).time;
    return t !== null && t !== undefined && String(t).length > 0;
  }).length;

  const header = asObject(data.header);

  // Double vérification : l'énumération des libellés est la preuve la plus
  // directe pour ce fournisseur (les statistiques arrivent en `{label,…}`).
  // On relève la VALEUR, pas seulement le libellé : « xG présent » sans
  // chiffre à l'appui ne serait pas une preuve.
  const xgEntries = stats
    .map(asObject)
    .filter((stat) => /expected[_ ]?goals?|\bxg\b/i.test(String(stat.label ?? "")))
    .map((stat) => `${String(stat.label)} : domicile ${String(stat.home)} / extérieur ${String(stat.away)}`);
  const xg = detectXg(raw);

  return {
    statsLabels: labels,
    statsCount: stats.length,
    eventsCount: events.length,
    eventTypes: distribution(events, (e) => e.type),
    eventsWithMinute,
    hasHalftimeSplit:
      /halftime|half_time/i.test(JSON.stringify(data.header ?? {})) ||
      /1st half|first half|première mi-temps/i.test(JSON.stringify(data.stats ?? [])),
    keys: Object.keys(data).sort(),
    xg: xgEntries.length > 0
      ? { present: true, paths: xg.paths, evidence: xgEntries }
      : xg,
    filled: {
      header: Object.keys(header).length > 0,
      stats: stats.length > 0,
      events: events.length > 0,
      venue: Boolean(data.venue),
      referee: Boolean(data.referee),
      tv_channels: Array.isArray(data.tv_channels) && data.tv_channels.length > 0,
      player_of_the_match: Boolean(data.player_of_the_match),
      csb_url: Boolean(data.csb_url),
    },
  };
}

function detailsAnswers(title: string, s: DetailsSurvey): string[] {
  const lines: string[] = [];

  if (s.statsCount === 0) {
    lines.push(`${title} : AUCUNE statistique renvoyée (stats vide).`);
  } else {
    lines.push(
      `${title} : ${s.statsCount} statistique(s) renvoyée(s) — ${s.statsLabels.length} libellé(s) distinct(s) :`,
    );
    lines.push(`   ${s.statsLabels.join(" · ")}`);
  }

  lines.push(
    s.xg.present
      ? `xG : PRÉSENT — ${s.xg.evidence.slice(0, 4).join(" · ")}`
      : `xG : ABSENT de cette réponse (aucune clé ni libellé « xG / expected goals »).`,
  );

  if (s.eventsCount === 0) {
    lines.push("Événements : aucun renvoyé (match peut-être sans événement ou pas encore commencé).");
  } else {
    lines.push(
      `Événements : ${s.eventsCount}, dont ${s.eventsWithMinute} portent une minute (${Math.round(
        (s.eventsWithMinute / s.eventsCount) * 100,
      )} %) · types : ${Object.entries(s.eventTypes)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ")}.`,
    );
  }

  const absent = Object.entries(s.filled)
    .filter(([, present]) => !present)
    .map(([key]) => key);
  lines.push(
    `Champs présents : ${Object.entries(s.filled)
      .filter(([, present]) => present)
      .map(([key]) => key)
      .join(", ") || "aucun"}${absent.length > 0 ? ` · absents : ${absent.join(", ")}` : ""}.`,
  );

  return lines;
}

// ---------------------------------------------------------------------------
// Lecture de `/league_standings`
// ---------------------------------------------------------------------------

interface StandingsSurvey {
  availableSeasons: string[];
  season: string | null;
  groups: number;
  rows: number;
  rowFields: string[];
  formFilled: number;
  homeRows: number;
  awayRows: number;
  stale: boolean | null;
}

function surveyStandings(raw: unknown): StandingsSurvey {
  const data = asObject(asObject(raw).data);
  const standings = asArray(data.standings);
  const firstTable = asArray(asObject(standings[0]).table).map(asObject);
  const homeRows = asArray(asObject(asArray(data.home_standings)[0]).table).length;
  const awayRows = asArray(asObject(asArray(data.away_standings)[0]).table).length;

  return {
    availableSeasons: asArray(data.available_seasons).map(String),
    season: data.season ? String(data.season) : null,
    groups: standings.length,
    rows: firstTable.length,
    rowFields: firstTable.length > 0 ? Object.keys(firstTable[0]).sort() : [],
    formFilled: fillRate(firstTable, (r) => r.form).percent,
    homeRows,
    awayRows,
    stale: typeof data.stale === "boolean" ? data.stale : null,
  };
}

function standingsAnswers(title: string, s: StandingsSurvey): string[] {
  const lines: string[] = [];
  if (s.rows === 0) {
    lines.push(`${title} : AUCUNE ligne de classement renvoyée.`);
  } else {
    lines.push(
      `${title} : ${s.rows} équipe(s) classée(s), ${s.groups} groupe(s) — champs par ligne : ${s.rowFields.join(", ")}.`,
    );
    lines.push(
      `Forme (5 derniers résultats) renseignée sur ${s.formFilled} % des lignes · classement domicile : ${s.homeRows} ligne(s) · classement extérieur : ${s.awayRows} ligne(s).`,
    );
  }
  lines.push(
    s.availableSeasons.length > 0
      ? `Saisons réellement disponibles : ${s.availableSeasons.join(", ")} (${s.availableSeasons.length}).`
      : "Aucune liste de saisons disponibles renvoyée : profondeur historique à établir autrement.",
  );
  if (s.stale !== null) lines.push(`Drapeau « stale » : ${s.stale ? "OUI (données en retard)" : "non"}.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Plan de sonde
// ---------------------------------------------------------------------------

export const LFA_STEPS: ProbeStep[] = [
  {
    key: "leagues",
    question:
      "L'authentification fonctionne-t-elle, combien de compétitions sont couvertes, et lesquelles sont africaines ?",
    endpoint: "leagues",
    params: () => ({ lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 86_400,
  },
  {
    key: "matches_today",
    question:
      "Les rencontres du jour sont-elles accessibles en un appel, avec score, horaire et statut ? (endpoint de la page « Matchs du jour »)",
    endpoint: "matches",
    params: (ctx) => ({ date: ctx.today, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 60,
  },
  {
    key: "matches_finished",
    question:
      "Une journée écoulée livre-t-elle les scores terminaux et les scores à la mi-temps ? (base de l'historique)",
    endpoint: "matches",
    params: (ctx) => ({ date: ctx.lastSaturday, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 86_400,
  },
  {
    key: "matches_future",
    question: "Le calendrier s'étend-il au-delà du jour même (programmation à l'avance) ?",
    endpoint: "matches",
    params: (ctx) => ({ date: ctx.nextSaturday, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
  },
  {
    key: "details_active",
    question:
      "Quelles statistiques de match sont réellement fournies — et contiennent-elles l'expected goals ?",
    endpoint: "live_match_details",
    params: (ctx) => ({ match_id: ctx.slots.matchId, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 60,
    skipIf: (ctx) => (ctx.slots.matchId ? null : "Aucun identifiant de match disponible."),
  },
  {
    key: "details_finished",
    question:
      "Les statistiques et événements restent-ils disponibles après la fin du match ? (condition de constitution de l'historique)",
    endpoint: "live_match_details",
    params: (ctx) => ({ match_id: ctx.slots.finishedMatchId, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) =>
      ctx.slots.matchKind === "finished"
        ? "Le match testé à l'étape précédente était déjà terminé : la question est déjà tranchée."
        : ctx.slots.finishedMatchId
          ? null
          : "Aucun match terminé identifié.",
  },
  {
    key: "standings",
    question:
      "Le classement est-il complet (points, joués, buts, différence, forme) et quel historique de saisons est réellement conservé ?",
    endpoint: "league_standings",
    params: (ctx) => ({ league_id: ctx.slots.leagueId, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.slots.leagueId ? null : "Aucune compétition de référence identifiée."),
  },
  {
    key: "league_fixtures",
    question:
      "Le calendrier complet d'une compétition est-il récupérable en un appel ? (coût d'un import de référence)",
    endpoint: "league_fixtures",
    params: (ctx) => ({ league_id: ctx.slots.leagueId, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.slots.leagueId ? null : "Aucune compétition de référence identifiée."),
  },
  {
    key: "league_fixtures_old",
    question: "Une saison antérieure est-elle réellement servie ? (profondeur d'historique)",
    endpoint: "league_fixtures",
    params: (ctx) => ({ league_id: ctx.slots.leagueId, season: ctx.slots.oldSeason, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 86_400,
    skipIf: (ctx) =>
      ctx.slots.leagueId
        ? ctx.slots.oldSeason
          ? null
          : "Aucune saison antérieure annoncée par le classement."
        : "Aucune compétition de référence identifiée.",
  },
  {
    key: "team_matches",
    question:
      "Les rencontres d'une équipe sur une saison sont-elles récupérables (forme, domicile/extérieur, buts pour/contre) ?",
    endpoint: "team_matches",
    params: (ctx) => ({ team_id: ctx.slots.teamId, lang: "en" }),
    cost: 1,
    required: true,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.slots.teamId ? null : "Aucun identifiant d'équipe disponible."),
  },
  {
    key: "team_standings",
    question: "Le classement filtré sur une équipe est-il disponible ?",
    endpoint: "team_standings",
    params: (ctx) => ({ team_id: ctx.slots.teamId, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.slots.teamId ? null : "Aucun identifiant d'équipe disponible."),
  },
  {
    key: "h2h",
    question:
      "Les confrontations directes et la forme récente des deux équipes sont-elles fournies ?",
    endpoint: "h2h",
    params: (ctx) => ({ match_id: ctx.slots.matchId, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) => (ctx.slots.matchId ? null : "Aucun identifiant de match disponible."),
  },
  {
    key: "african_standings",
    question:
      "Une compétition africaine dispose-t-elle d'un classement réel ? (enjeu direct pour le public de SOLEIL)",
    endpoint: "league_standings",
    params: (ctx) => ({ league_id: ctx.slots.africanLeagueId, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) =>
      ctx.slots.africanLeagueId ? null : "Aucune compétition africaine détectée dans /leagues.",
  },
  {
    key: "african_fixtures",
    question: "Une compétition africaine dispose-t-elle d'un calendrier réel ?",
    endpoint: "league_fixtures",
    params: (ctx) => ({ league_id: ctx.slots.africanLeagueId, lang: "en" }),
    cost: 1,
    required: false,
    ttlSeconds: 3600,
    skipIf: (ctx) =>
      ctx.slots.africanLeagueId ? null : "Aucune compétition africaine détectée dans /leagues.",
  },
];

// ---------------------------------------------------------------------------
// Lecture des réponses, étape par étape
// ---------------------------------------------------------------------------

function analyseLfa(key: string, raw: unknown): StepAnalysis {
  const root = asObject(raw);

  switch (key) {
    case "leagues": {
      const { countries, leagues } = flattenLeagues(root.data);
      const african = africanLeagues(leagues);
      const uniqueCountries = [...new Set(countries)].sort();

      const answers = [
        `Authentification : ${
          root.success === true ? "fonctionnelle" : "ÉCHEC — vérifier la clé"
        } · crédits restants annoncés : ${String(root.credits_remaining ?? "(non communiqué)")}.`,
        `Compétitions : ${uniqueCountries.length} pays, ${leagues.length} ligues listées.`,
        african.length > 0
          ? `Compétitions africaines détectées (${african.length}) : ${african
              .slice(0, 12)
              .map(({ league }) => `${league.country} — ${league.name}`)
              .join(" · ")}.`
          : "AUCUNE compétition africaine dans la liste renvoyée : la couverture Afrique est nulle sur cet abonnement.",
      ];

      return {
        answers,
        evidence: {
          totalCountries: uniqueCountries.length,
          countries: uniqueCountries,
          leagues: leagues.slice(0, 120),
          africanLeagues: african.slice(0, 20).map(({ league }) => league),
          fieldCoverage: surveyFields(leagues.slice(0, 3), 3),
        },
      };
    }

    case "matches_today":
    case "matches_finished":
    case "matches_future": {
      const matches = normalizeMatches(raw);
      const envelopeDate = asObject(root.data).date;
      const survey = surveyMatches(
        matches,
        envelopeDate === undefined || envelopeDate === null ? undefined : String(envelopeDate),
      );
      const titles: Record<string, string> = {
        matches_today: "Rencontres du jour",
        matches_finished: "Journée écoulée (dernier samedi)",
        matches_future: "Samedi suivant",
      };
      return {
        answers: matchSurveyAnswers(titles[key] ?? key, survey),
        evidence: { survey, sample: matches.slice(0, 3) },
      };
    }

    case "details_active":
    case "details_finished": {
      const survey = surveyDetails(raw);
      const title =
        key === "details_active" ? "Détails du match testé" : "Détails du match terminé";
      return { answers: detailsAnswers(title, survey), evidence: { survey } };
    }

    case "standings":
    case "african_standings": {
      const survey = surveyStandings(raw);
      const title = key === "standings" ? "Classement de référence" : "Classement africain";
      return { answers: standingsAnswers(title, survey), evidence: { survey } };
    }

    case "league_fixtures":
    case "league_fixtures_old":
    case "african_fixtures": {
      const matches = normalizeMatches(raw);
      const survey = surveyMatches(matches);
      const data = asObject(root.data);
      const seasons = asArray(data.available_seasons).map(String);
      const title =
        key === "league_fixtures"
          ? "Calendrier de la saison courante"
          : key === "league_fixtures_old"
            ? `Calendrier de la saison ${String(data.season ?? "antérieure")}`
            : "Calendrier africain";

      const answers = matchSurveyAnswers(title, survey);
      if (survey.count > 0) {
        answers.push(
          `Coût d'une ingestion complète de cette compétition-saison : 1 crédit (calendrier) + ${survey.count} crédits (détail match par match) = ${survey.count + 1} crédits au maximum.`,
        );
      }
      answers.push(
        seasons.length > 0
          ? `Saisons annoncées par le fournisseur pour cette compétition : ${seasons.join(", ")}.`
          : "Aucune liste de saisons annoncée dans cette réponse.",
      );
      return {
        answers,
        evidence: { survey, season: data.season ?? null, availableSeasons: seasons, weeks: asArray(data.weeks).length },
      };
    }

    case "team_matches": {
      const matches = normalizeMatches(raw);
      const survey = surveyMatches(matches);
      const data = asObject(root.data);

      // Bilan lisible directement dérivable des données renvoyées.
      let wins = 0;
      let draws = 0;
      let losses = 0;
      let homeGames = 0;
      let played = 0;
      const teamId = String(data.team_id ?? "");
      for (const match of matches) {
        const home = asObject(match.home);
        const away = asObject(match.away);

        // Un match non joué porte `score: null`. Le convertir en nombre donne 0,
        // ce qui transformerait silencieusement chaque rencontre à venir en
        // 0-0 — soit 40 « nuls » inventés sur une seule équipe. On écarte donc
        // explicitement l'absence de score avant toute conversion.
        if (home.score === null || home.score === undefined || home.score === "") continue;
        if (away.score === null || away.score === undefined || away.score === "") continue;

        const hs = Number(home.score);
        const as_ = Number(away.score);
        if (!Number.isFinite(hs) || !Number.isFinite(as_)) continue;
        played += 1;
        const isHome = String(home.id) === teamId;
        if (isHome) homeGames += 1;
        const own = isHome ? hs : as_;
        const other = isHome ? as_ : hs;
        if (own > other) wins += 1;
        else if (own === other) draws += 1;
        else losses += 1;
      }

      const answers = matchSurveyAnswers("Rencontres de l'équipe (saison courante)", survey);
      answers.push(
        played > 0
          ? `Bilan calculable depuis la réponse : ${wins} V / ${draws} N / ${losses} D sur ${played} rencontre(s) réellement jouée(s) — dont ${homeGames} à domicile. La répartition domicile/extérieur et les buts pour/contre sont donc dérivables sans appel supplémentaire.`
          : "Aucune rencontre jouée dans la réponse : bilan non calculable.",
      );
      const seasons = asArray(data.available_seasons).map(String);
      if (seasons.length > 0) answers.push(`Saisons disponibles pour cette équipe : ${seasons.join(", ")}.`);

      return {
        answers,
        evidence: {
          survey,
          record: { wins, draws, losses, homeGames, played },
          availableSeasons: seasons,
          sample: matches.slice(0, 3),
        },
      };
    }

    case "team_standings": {
      const survey = surveyStandings(raw);
      return {
        answers: standingsAnswers("Classement de l'équipe", survey),
        evidence: { survey },
      };
    }

    case "h2h": {
      const data = asObject(root.data);
      const h2h = asArray(data.h2h);
      const homeForm = asArray(data.home_form);
      const awayForm = asArray(data.away_form);
      const summary = data.h2h_summary ?? null;

      const answers = [
        `Confrontations directes : ${h2h.length} rencontre(s) renvoyée(s)${
          h2h.length > 0 ? ` (la plus récente : ${String(asObject(h2h[0]).date ?? "?")})` : ""
        }.`,
        `Forme récente fournie avec la réponse : ${homeForm.length} rencontre(s) pour l'équipe à domicile, ${awayForm.length} pour l'équipe à l'extérieur — la forme est donc obtenue sans appel dédié.`,
        summary
          ? `Synthèse des confrontations fournie par le fournisseur : ${JSON.stringify(summary)}.`
          : "Aucune synthèse agrégée (h2h_summary) renvoyée.",
      ];
      return {
        answers,
        evidence: { h2hCount: h2h.length, homeFormCount: homeForm.length, awayFormCount: awayForm.length, summary, sample: h2h.slice(0, 3) },
      };
    }

    default:
      return { answers: [], evidence: { fields: surveyFields(root, 4).slice(0, 60) } };
  }
}

// ---------------------------------------------------------------------------
// Alimentation du contexte — les identifiants opaques (type « lfa-… ») ne
// peuvent pas être devinés : ils doivent provenir d'une réponse réelle.
// ---------------------------------------------------------------------------

function hydrateLfa(key: string, raw: unknown, ctx: ProbeContext): void {
  const data = asObject(asObject(raw).data);

  if (key === "leagues") {
    const { leagues } = flattenLeagues(data);
    const reference = pickReferenceLeague(leagues);
    if (reference && !ctx.slots.leagueId) {
      ctx.slots.leagueId = reference.id;
      ctx.slots.leagueLabel = `${reference.country} — ${reference.name}`;
    }
    const chosen = pickAfricanLeague(leagues);
    if (chosen && !ctx.slots.africanLeagueId) {
      ctx.slots.africanLeagueId = chosen.id;
      ctx.slots.africanLeagueLabel = `${chosen.country} — ${chosen.name}`;
    }
    return;
  }

  if (key === "matches_today") {
    const matches = normalizeMatches(raw);
    const live = matches.find((m) => at(m, "status.is_live") === true);
    const finished = matches.find((m) =>
      /postGame|finished|FT|AET|PEN/i.test(String(at(m, "status.state") ?? at(m, "status"))),
    );
    const chosen = live ?? finished ?? matches.find((m) => at(m, "home.score") !== null) ?? matches[0];
    if (chosen && !ctx.slots.matchId) {
      ctx.slots.matchId = String(at(chosen, "id") ?? "");
      ctx.slots.matchKind = live
        ? "live"
        : finished
          ? "finished"
          : String(at(chosen, "status.state") ?? "inconnu");
      ctx.slots.leagueIdFromMatch = String(at(chosen, "league.id") ?? "");
      if (!ctx.slots.teamId) ctx.slots.teamId = String(at(chosen, "home.id") ?? "");
    }
    return;
  }

  if (key === "matches_finished") {
    const matches = normalizeMatches(raw);
    const finished = matches.find((m) => {
      const hs = at(m, "home.score");
      const as_ = at(m, "away.score");
      return hs !== null && hs !== undefined && as_ !== null && as_ !== undefined;
    });
    if (finished) {
      ctx.slots.finishedMatchId = String(at(finished, "id") ?? "");
      if (!ctx.slots.teamId) ctx.slots.teamId = String(at(finished, "home.id") ?? "");
      if (!ctx.slots.leagueIdFromMatch) {
        ctx.slots.leagueIdFromMatch = String(at(finished, "league.id") ?? "");
      }
    }
    return;
  }

  if (key === "standings" || key === "league_fixtures") {
    // Le classement livre des identifiants d'équipes réels : sans cela, les
    // étapes « rencontres d'équipe » seraient sautées faute d'identifiant.
    if (!ctx.slots.teamId) {
      const firstRow = asObject(asArray(asObject(asArray(data.standings)[0]).table)[0]);
      const teamId = at(firstRow, "team.id");
      if (teamId) {
        ctx.slots.teamId = String(teamId);
        ctx.slots.teamLabel = String(at(firstRow, "team.name") ?? "");
      }
    }
    const seasons = asArray(data.available_seasons).map(String);
    // La saison courante est la première annoncée ; la précédente sert à
    // vérifier que l'historique existe réellement.
    if (seasonIndexIsSafe(seasons) && !ctx.slots.oldSeason) ctx.slots.oldSeason = seasons[1];
  }
}

/** Deux saisons au minimum sont nécessaires pour tester l'historique. */
function seasonIndexIsSafe(seasons: string[]): boolean {
  return seasons.length >= 2;
}

export const LFA_PROFILE: ProbeProfile = {
  label: "LiveFootballApi — audit ciblé (14 étapes, 14 crédits au maximum)",
  steps: LFA_STEPS,
  // 2 req/s soutenues sur le palier d'entrée : 700 ms entre deux appels laisse
  // une marge franche et évite un 429 qui consommerait un crédit pour rien.
  minIntervalMs: 700,
  analyse: (key, raw) => analyseLfa(key, raw),
  hydrate: hydrateLfa,
};

// ---------------------------------------------------------------------------
// Contexte initial : identifiants connus d'avance, s'il y en a
// ---------------------------------------------------------------------------

export function hydrateFromEnv(ctx: ProbeContext): void {
  const leagueId = process.env.SOLEIL_LFA_LEAGUE_ID;
  if (leagueId) ctx.slots.leagueId = leagueId;
  const africanLeagueId = process.env.SOLEIL_LFA_AFRICAN_LEAGUE_ID;
  if (africanLeagueId) ctx.slots.africanLeagueId = africanLeagueId;
  const teamId = process.env.SOLEIL_LFA_TEAM_ID;
  if (teamId) ctx.slots.teamId = teamId;
  const matchId = process.env.SOLEIL_LFA_MATCH_ID;
  if (matchId) ctx.slots.matchId = matchId;
  // Saison à interroger explicitement : permet de vérifier qu'une saison
  // annoncée par le fournisseur est réellement servie.
  const season = process.env.SOLEIL_LFA_SEASON;
  if (season) ctx.slots.oldSeason = season;
}
