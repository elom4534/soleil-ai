/**
 * ============================================================================
 * SOLEIL — Normalisation des réponses LiveFootballApi
 * ============================================================================
 * Le fournisseur est propre, mais il a trois défauts réels constatés pendant
 * l'audit du 29/09/2026 — et une normalisation qui les ignore produit des
 * données fausses sans jamais lever d'erreur :
 *
 *   1. Les statistiques arrivent en `{ label, home, away }` où les VALEURS sont
 *      des CHAÎNES : « 62 % », « 1.84 », « 0,36 ». Les convertir sans précaution
 *      transforme une absence en zéro.
 *   2. Certains libellés contiennent des fautes du fournisseur
 *      (« Ppda Opppostition Passes »). Une correspondance par libellé exact
 *      casse au premier correctif : la correspondance doit être tolérante.
 *   3. Deux formats de statut coexistent : `status: { state: "postGame" }` sur
 *      les endpoints de matchs, `status: "FT"` sur ceux d'équipes et de
 *      compétitions.
 *
 * Règle absolue : **une donnée absente reste absente**. `null`, jamais 0.
 */

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

/** Vocabulaire canonique des statistiques de match. */
export type StatKey =
  | "xg"
  | "xgSetPieces"
  | "shotsTotal"
  | "shotsOnTarget"
  | "shotsOffTarget"
  | "shotsBlocked"
  | "bigChancesMissed"
  | "possession"
  | "passesTotal"
  | "passesAccurate"
  | "passAccuracy"
  | "corners"
  | "crosses"
  | "crossesAccurate"
  | "fouls"
  | "offsides"
  | "yellowCards"
  | "redCards"
  | "secondYellow"
  | "directRed"
  | "duelsWon"
  | "aerialDuelsWon"
  | "clearances"
  | "interceptions"
  | "tacklesWon"
  | "dribblesWon"
  | "touchesInBox"
  | "hitWoodwork"
  | "throwIns"
  | "goalKicks"
  | "ppdaDefensiveActions"
  | "ppdaOppositionPasses"
  | "runningDistance";

/**
 * Correspondances libellé → clé canonique.
 *
 * L'ORDRE COMPTE : les motifs sont testés dans cet ordre, du plus spécifique au
 * plus général. « Second Yellow Card » doit être reconnu avant « Yellow Cards »,
 * sinon il serait compté comme un carton jaune ordinaire.
 *
 * Les motifs sont volontairement tolérants (`op+p?o?sition` couvre à la fois
 * « opposition » et la faute « Opppostition »).
 */
const STAT_PATTERNS: { key: StatKey; pattern: RegExp }[] = [
  { key: "xgSetPieces", pattern: /xg\s*(from\s*)?set\s*pieces?|set\s*pieces?\s*xg/i },
  { key: "xg", pattern: /^expected\s*goals?\s*(\(xg\))?$|^xg$/i },
  { key: "secondYellow", pattern: /second\s*yellow/i },
  { key: "directRed", pattern: /direct\s*red/i },
  { key: "yellowCards", pattern: /^yellow\s*cards?$/i },
  { key: "redCards", pattern: /^red\s*cards?$/i },
  { key: "shotsOnTarget", pattern: /shots?\s*on\s*target/i },
  { key: "shotsOffTarget", pattern: /shots?\s*off\s*target/i },
  { key: "shotsBlocked", pattern: /blocked\s*shots?/i },
  { key: "shotsTotal", pattern: /^(total\s*)?shots?$/i },
  { key: "bigChancesMissed", pattern: /big\s*chances?/i },
  { key: "possession", pattern: /^possession/i },
  { key: "passAccuracy", pattern: /pass(ing)?\s*accuracy/i },
  { key: "passesAccurate", pattern: /successful\s*passes/i },
  { key: "passesTotal", pattern: /^total\s*passes$/i },
  { key: "corners", pattern: /^corners?$/i },
  { key: "crossesAccurate", pattern: /successful\s*crosses/i },
  { key: "crosses", pattern: /^crosses$/i },
  { key: "fouls", pattern: /^fouls$/i },
  { key: "offsides", pattern: /^offsides?$/i },
  { key: "duelsWon", pattern: /^duels\s*won$/i },
  { key: "aerialDuelsWon", pattern: /aerial\s*duels/i },
  { key: "clearances", pattern: /^clearances$/i },
  { key: "interceptions", pattern: /^interceptions$/i },
  { key: "tacklesWon", pattern: /successful\s*tackles|^tackles$/i },
  { key: "dribblesWon", pattern: /successful\s*dribbles|^dribbles$/i },
  { key: "touchesInBox", pattern: /touches?\s*in\s*(the\s*)?opposition\s*box/i },
  { key: "hitWoodwork", pattern: /hit\s*woodwork|woodwork/i },
  { key: "throwIns", pattern: /throw[\s-]*ins/i },
  { key: "goalKicks", pattern: /goal\s*kicks?/i },
  // « Ppda Opppostition Passes » (sic) : le fournisseur écrit « Opppostition ».
  // On reconnaît donc les deux statistiques PPDA à leurs jetons distinctifs —
  // « defensive » et « pass » — et non à leur orthographe, qui bougera.
  { key: "ppdaDefensiveActions", pattern: /ppda.*defensive/i },
  { key: "ppdaOppositionPasses", pattern: /ppda.*pass/i },
  // Libellé observé sur 4 rencontres lors de la comparaison du 29/09/2026.
  // Mappé pour ne pas perdre la donnée en silence ; NON utilisé par le modèle.
  { key: "runningDistance", pattern: /running\s*distance/i },
];

/** Reconnaît une clé canonique à partir d'un libellé brut du fournisseur. */
export function mapStatLabel(label: string): StatKey | null {
  const clean = label.trim();
  for (const { key, pattern } of STAT_PATTERNS) {
    if (pattern.test(clean)) return key;
  }
  return null;
}

/** Nature d'une valeur de statistique, pour ne pas comparer des choux et des carottes. */
export type StatUnit = "count" | "percent" | "unknown";

export interface StatNumber {
  value: number | null;
  unit: StatUnit;
  raw: string;
}

/**
 * Convertit une valeur textuelle du fournisseur en nombre.
 *
 * `"62 %"` → 62 (%) · `"1.84"` → 1.84 · `"0,36"` → 0.36 · `""`/`null` → null.
 *
 * Aucune absence n'est convertie en zéro : c'est la garantie qu'une statistique
 * manquante reste manquante.
 */
export function parseStatValue(raw: unknown): StatNumber {
  if (raw === null || raw === undefined) return { value: null, unit: "unknown", raw: "" };
  const text = String(raw).trim();
  if (text === "" || text === "-" || text === "—" || /^n\/?a$/i.test(text)) {
    return { value: null, unit: "unknown", raw: text };
  }

  const percent = /%/.test(text);
  // Virgule décimale française ou anglaise : « 0,36 » comme « 0.36 ».
  const normalized = text.replace(/[%\s]/g, "").replace(",", ".");
  const value = Number(normalized);

  if (!Number.isFinite(value)) return { value: null, unit: "unknown", raw: text };
  return { value, unit: percent ? "percent" : "count", raw: text };
}

export interface NormalizedTeamStats {
  /** Statistiques par clé canonique, uniquement celles réellement fournies. */
  values: Partial<Record<StatKey, StatNumber>>;
  /** Libellés du fournisseur restés non reconnus — traçabilité, jamais ignorés en silence. */
  unmappedLabels: string[];
}

export interface NormalizedMatchStats {
  home: NormalizedTeamStats;
  away: NormalizedTeamStats;
}

/** Normalise le bloc `stats` d'une réponse `/live_match_details`. */
export function normalizeStats(statsBlock: unknown): NormalizedMatchStats {
  const entries = Array.isArray(statsBlock) ? statsBlock : [];
  const home: NormalizedTeamStats = { values: {}, unmappedLabels: [] };
  const away: NormalizedTeamStats = { values: {}, unmappedLabels: [] };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const label = String(row.label ?? "");
    if (label === "") continue;

    const key = mapStatLabel(label);
    if (!key) {
      // Un libellé inconnu est conservé : il signale une statistique que le
      // fournisseur a ajoutée sans que l'adaptateur la connaisse.
      home.unmappedLabels.push(label);
      continue;
    }

    home.values[key] = parseStatValue(row.home);
    away.values[key] = parseStatValue(row.away);
  }

  return { home, away };
}

// ---------------------------------------------------------------------------
// Statut
// ---------------------------------------------------------------------------

export type NormalizedStatus =
  | "scheduled"
  | "live"
  | "half-time"
  | "finished"
  | "postponed"
  | "cancelled"
  | "unknown";

/**
 * Ramène les DEUX formats de statut du fournisseur à un seul vocabulaire.
 *
 * Les endpoints de matchs renvoient `{ status: "live", state: "inPlay" }`,
 * ceux d'équipes et de compétitions renvoient `status: "FT"`. Un adaptateur qui
 * suppose une seule forme classe silencieusement tous les matchs terminés en
 * « inconnu » — et le moteur croit alors qu'aucun match n'est joué.
 */
export function normalizeStatus(statusBlock: unknown): NormalizedStatus {
  const text = collectStatusText(statusBlock).toLowerCase();
  if (text === "") return "unknown";

  if (/\b(postponed|reporté|abandoned|abandonné|suspended)\b/.test(text)) return "postponed";
  if (/\b(cancelled|canceled|annulé)\b/.test(text)) return "cancelled";
  if (/\b(half[\s-]?time|halftime|ht)\b/.test(text) && !/postgame/.test(text)) return "half-time";
  if (/\b(ft|aet|pen|postgame|finished|match finished|ended)\b/.test(text)) return "finished";
  if (/\b(inplay|live|1h|2h|et)\b/.test(text)) return "live";
  if (/\b(pregame|scheduled|notstarted|ns|tbd|time to be defined)\b/.test(text)) return "scheduled";
  return "unknown";
}

function collectStatusText(block: unknown): string {
  if (block === null || block === undefined) return "";
  if (typeof block === "string") return block;
  if (typeof block !== "object") return "";
  const obj = block as Record<string, unknown>;
  return [obj.status, obj.state, obj.display, obj.long, obj.short]
    .filter((v) => typeof v === "string")
    .join(" ");
}

// ---------------------------------------------------------------------------
// Rencontres
// ---------------------------------------------------------------------------

export interface NormalizedTeamRef {
  providerId: string;
  name: string;
  logo: string | null;
  score: number | null;
}

export interface NormalizedMatch {
  providerId: string;
  /** Date au format AAAA-MM-JJ. */
  date: string | null;
  kickoff: string | null;
  competition: { providerId: string; name: string; country: string | null };
  season: string | null;
  round: string | null;
  status: NormalizedStatus;
  home: NormalizedTeamRef;
  away: NormalizedTeamRef;
  halftime: { home: number | null; away: number | null };
  /** Score final dérivé du statut : absent si le match n'est pas terminé. */
  finalScore: { home: number; away: number } | null;
}

/** Convertit une valeur de score en nombre, ou `null` — jamais 0 par défaut. */
export function parseScore(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function teamRef(raw: unknown): NormalizedTeamRef {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    providerId: obj.id === undefined || obj.id === null ? "" : String(obj.id),
    name: String(obj.name ?? ""),
    logo: typeof obj.logo === "string" && obj.logo !== "" ? obj.logo : null,
    score: parseScore(obj.score),
  };
}

/**
 * Normalise une rencontre, quelle que soit sa provenance.
 *
 * Les rencontres arrivent sous trois formes selon l'endpoint : `/matches` porte
 * `date` + `kickoff`, `/league_fixtures` porte `date` + `kickoff`, et
 * `/team_matches` porte un `date` complet « 2025-08-17 14:00:00 ». Toutes
 * ressortent ici sous la même forme.
 */
export function normalizeMatch(raw: unknown): NormalizedMatch {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const league = obj.league && typeof obj.league === "object" ? (obj.league as Record<string, unknown>) : {};

  const rawDate = typeof obj.date === "string" ? obj.date : null;
  const date = rawDate ? rawDate.slice(0, 10) : null;
  const kickoff =
    typeof obj.kickoff === "string" && obj.kickoff !== ""
      ? obj.kickoff
      : rawDate && rawDate.length > 10
        ? rawDate.slice(11, 16)
        : null;

  const status = normalizeStatus(obj.status);
  const home = teamRef(obj.home);
  const away = teamRef(obj.away);
  const halftimeRaw = obj.halftime && typeof obj.halftime === "object" ? (obj.halftime as Record<string, unknown>) : {};

  // Le score final n'est retenu que si le match est réellement terminé : un
  // score présent sur un match en cours n'est pas un résultat.
  const finalScore =
    status === "finished" && home.score !== null && away.score !== null
      ? { home: home.score, away: away.score }
      : null;

  return {
    providerId: obj.id === undefined || obj.id === null ? "" : String(obj.id),
    date,
    kickoff,
    competition: {
      providerId: league.id === undefined || league.id === null ? "" : String(league.id),
      name: String(league.name ?? ""),
      country: typeof league.country === "string" && league.country !== "" ? league.country : null,
    },
    season: typeof obj.season === "string" ? obj.season : null,
    round:
      typeof obj.week === "string" ? obj.week : typeof obj.round === "string" ? obj.round : null,
    status,
    home,
    away,
    halftime: { home: parseScore(halftimeRaw.home), away: parseScore(halftimeRaw.away) },
    finalScore,
  };
}

/** Normalise les rencontres des trois formes possibles de réponse. */
export function normalizeMatchList(payload: unknown): NormalizedMatch[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};

  const direct = Array.isArray(data.matches) ? data.matches : [];
  if (direct.length > 0) return direct.map((m) => normalizeMatch(withDay(m, data))).filter(hasIdentity);

  const weeks = Array.isArray(data.weeks) ? data.weeks : [];
  const out: NormalizedMatch[] = [];
  for (const week of weeks) {
    const weekObj = week && typeof week === "object" ? (week as Record<string, unknown>) : {};
    const matches = Array.isArray(weekObj.matches) ? weekObj.matches : [];
    for (const match of matches) out.push(normalizeMatch(match));
  }
  return out.filter(hasIdentity);
}

/**
 * `/matches` publie la date de la journée une seule fois, au niveau de la
 * réponse (`data.date`), et l'heure de chaque rencontre (`kickoff`) sans date.
 * Sans cette reprise, toute rencontre serait écartée (date absente).
 */
function withDay(match: unknown, data: Record<string, unknown>): unknown {
  if (!match || typeof match !== "object") return match;
  const obj = match as Record<string, unknown>;
  if (typeof obj.date === "string" && obj.date !== "") return obj;
  return typeof data.date === "string" ? { ...obj, date: data.date } : obj;
}

/** Une rencontre sans identifiant ou sans équipes n'est pas exploitable. */
function hasIdentity(match: NormalizedMatch): boolean {
  return match.providerId !== "" && match.home.providerId !== "" && match.away.providerId !== "";
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  minute: number | null;
  type: string;
  side: "home" | "away" | null;
  playerName: string | null;
  scoreAfter: string | null;
}

/** Normalise la chronologie d'un match. */
export function normalizeEvents(eventsBlock: unknown): NormalizedEvent[] {
  const events = Array.isArray(eventsBlock) ? eventsBlock : [];
  return events.map((raw) => {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const detail = obj.detail && typeof obj.detail === "object" ? (obj.detail as Record<string, unknown>) : {};
    const player = detail.player && typeof detail.player === "object" ? (detail.player as Record<string, unknown>) : {};
    const minuteRaw = obj.time ?? detail.time;
    const minute = parseMinute(minuteRaw);

    const sideRaw = String(obj.side ?? "");
    return {
      minute: Number.isFinite(minute as number) ? (minute as number) : null,
      type: String(obj.type ?? "").toLowerCase(),
      side: sideRaw === "home" || sideRaw === "away" ? sideRaw : null,
      playerName: player.name ? String(player.name) : null,
      scoreAfter: detail.score ? String(detail.score) : null,
    };
  });
}

/**
 * Convertit une minute d'événement en nombre.
 *
 * « 45+2 » désigne la 45e minute (2 minutes d'arrêts de jeu), pas la 452e :
 * concaténer les chiffres classait le but en seconde mi-temps et déformait
 * toutes les séries par période. On retient donc la minute de base.
 */
export function parseMinute(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  const match = text.match(/^\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reconstitue les buts par mi-temps à partir des minutes des événements.
 *
 * Le fournisseur ne fournit AUCUN agrégat par mi-temps. La seule voie honnête
 * est de dériver : un but marqué à la 23e minute est un but de première
 * mi-temps. Les buts dont la minute est inconnue sont exclus — jamais comptés
 * au hasard dans une période.
 */
export function goalsByHalf(events: NormalizedEvent[]): {
  firstHalf: { home: number; away: number; known: boolean };
  secondHalf: { home: number; away: number; known: boolean };
} {
  const first = { home: 0, away: 0, known: true };
  const second = { home: 0, away: 0, known: true };

  for (const event of events) {
    if (event.type !== "goal" && event.type !== "own_goal") continue;
    if (event.minute === null || event.side === null) continue;
    // Les arrêts de jeu de première période (45+n) restent en première période.
    const target = event.minute <= 45 ? first : second;
    if (event.side === "home") target.home += 1;
    else target.away += 1;
  }

  return { firstHalf: first, secondHalf: second };
}
