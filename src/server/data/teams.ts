/**
 * ============================================================================
 * SOLEIL — Identité des équipes & rapprochement inter-sources
 * ============================================================================
 * Les sources n'écrivent pas les noms d'équipes de la même façon
 * (« Man United » / « Manchester United »). Nous normalisons puis appliquons
 * une table d'alias explicite, et enfin une similarité de jetons contrôlée.
 * Règle : en cas de doute, on ne fusionne PAS (§34 : jamais d'invention).
 */

/** Normalise un nom d'équipe pour comparaison : minuscules, sans accent, sans bruit. */
export function normalizeTeamName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|ac|sc|afc|cfc|as|ss|ssc|sv|vfl|vfb|tsg|bsc|us|ud|rc|cd|club|de|futbol|football|calcio|sport|sporting|atletico|atl|real|rcd|sl|fk|sk|bk|if|ff)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Alias explicites reliant les libellés de football-data.co.uk aux libellés
 * usuels utilisés par les autres fournisseurs. Toute entrée est vérifiable.
 */
const ALIASES: Record<string, string> = {
  "man united": "manchester united",
  "man city": "manchester city",
  "newcastle": "newcastle united",
  "nottm forest": "nottingham forest",
  "sheffield utd": "sheffield united",
  "west brom": "west bromwich albion",
  "west ham": "west ham united",
  "wolves": "wolverhampton wanderers",
  "tottenham": "tottenham hotspur",
  "leeds": "leeds united",
  "brighton": "brighton hove albion",
  "qpr": "queens park rangers",
  "psg": "paris saint germain",
  "paris sg": "paris saint germain",
  "marseille": "olympique marseille",
  "lyon": "olympique lyonnais",
  "lille": "losc lille",
  "st etienne": "saint etienne",
  "monchengladbach": "borussia monchengladbach",
  "m gladbach": "borussia monchengladbach",
  "bayern munich": "bayern munchen",
  "dortmund": "borussia dortmund",
  "leverkusen": "bayer leverkusen",
  "frankfurt": "eintracht frankfurt",
  "wolfsburg": "vfl wolfsburg",
  "inter": "inter milan",
  "internazionale": "inter milan",
  "milan": "ac milan",
  "roma": "as roma",
  "lazio": "ss lazio",
  "juventus": "juventus",
  "napoli": "ssc napoli",
  "atletico madrid": "atletico madrid",
  "athletic bilbao": "athletic club",
  "real betis": "betis",
  "real sociedad": "sociedad",
  "sp Lisbon": "sporting lisbon",
  "sporting cp": "sporting lisbon",
  "porto": "fc porto",
  "benfica": "sl benfica",
  "sp braga": "sc braga",
  "feyenoord": "feyenoord",
  "ajax": "afc ajax",
  "psv": "psv eindhoven",
  "az alkmaar": "az",
};

export function canonicalTeamKey(raw: string): string {
  const n = normalizeTeamName(raw);
  return ALIASES[n] ?? n;
}

/** Génère un identifiant stable à partir du nom canonique. */
export function teamSlug(raw: string): string {
  return canonicalTeamKey(raw).replace(/\s+/g, "-");
}

/** Similarité de Jaccard sur les jetons, renforcée par un test de préfixe. */
export function teamNameSimilarity(a: string, b: string): number {
  const A = new Set(canonicalTeamKey(a).split(" ").filter(Boolean));
  const B = new Set(canonicalTeamKey(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const jaccard = inter / (A.size + B.size - inter);
  // Bonus si l'un est préfixe de l'autre (« lyon » vs « lyonnais »).
  const sa = [...A].join(" ");
  const sb = [...B].join(" ");
  const prefix = sa.startsWith(sb) || sb.startsWith(sa) ? 0.2 : 0;
  return Math.min(1, jaccard + prefix);
}

/**
 * Rapproche un nom d'équipe d'une liste connue.
 * @param threshold seuil de confiance minimal (0.72 par défaut).
 * @returns l'identifiant correspondant, ou `null` si aucun rapprochement sûr.
 */
export function resolveTeamId(
  raw: string,
  known: { id: string; name: string; shortName?: string | null; tla?: string | null }[],
  threshold = 0.72,
): string | null {
  const key = canonicalTeamKey(raw);

  // 1 — Correspondance canonique exacte
  for (const t of known) {
    if (canonicalTeamKey(t.name) === key) return t.id;
    if (t.shortName && canonicalTeamKey(t.shortName) === key) return t.id;
  }

  // 2 — Similarité de jetons
  let best: { id: string; score: number } | null = null;
  for (const t of known) {
    const candidates = [t.name, t.shortName ?? "", t.tla ?? ""];
    const score = Math.max(...candidates.map((c) => (c ? teamNameSimilarity(raw, c) : 0)));
    if (score > (best?.score ?? 0)) best = { id: t.id, score };
  }

  return best && best.score >= threshold ? best.id : null;
}
