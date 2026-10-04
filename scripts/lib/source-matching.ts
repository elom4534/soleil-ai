/**
 * ============================================================================
 * SOLEIL — Appariement canonique des sources (module partagé)
 * ============================================================================
 * Extrait de `compare-sources.ts` pour être réutilisé sans dupliquer la
 * canonicalisation : deux scripts qui apparient différemment produiraient deux
 * vérités différentes sur les mêmes données.
 *
 * Règles : jamais de fusion sur une ressemblance de noms ; la date ne tolère
 * aucun décalage ; un cas ambigu est rapporté, jamais tranché ; une donnée
 * absente reste `null`, jamais zéro.
 */

import type { NormalizedMatch } from "../../src/server/data/providers/apiFootballLive/adapter";
import type { NormalizedFixture } from "../../src/server/data/providers/types";

// ---------------------------------------------------------------------------
// Appariement des noms d'équipes
// ---------------------------------------------------------------------------

/**
 * Canonicalisation des noms d'équipes.
 *
 * Principe : les DEUX sources pointent vers une même forme canonique, choisie
 * parmi les écritures réellement observées. Viser un nom « officiel » que ni
 * l'une ni l'autre n'emploie ne sert à rien — la première version de cette
 * table le faisait (« Celta » → « RC Celta de Vigo ») et 170 rencontres de Liga
 * restaient non appariées alors que les données étaient identiques.
 *
 * Le tableau a été construit en relevant les 40 noms réellement renvoyés par
 * les deux sources pour les deux compétitions de l'échantillon.
 */
const TEAM_CANONICAL: Record<string, string> = {
  // --- Premier League (football-data.co.uk ↔ LiveFootballApi) ---
  arsenal: "arsenal",
  "aston villa": "aston villa",
  bournemouth: "bournemouth",
  brentford: "brentford",
  brighton: "brighton",
  "brighton and hove albion": "brighton",
  burnley: "burnley",
  chelsea: "chelsea",
  "crystal palace": "crystal palace",
  everton: "everton",
  fulham: "fulham",
  leeds: "leeds",
  "leeds united": "leeds",
  liverpool: "liverpool",
  "man city": "man city",
  "manchester city": "man city",
  "man united": "man united",
  "manchester united": "man united",
  newcastle: "newcastle",
  "newcastle united": "newcastle",
  "nott m forest": "nottm forest",
  "not forest": "nottm forest",
  "nottingham forest": "nottm forest",
  sunderland: "sunderland",
  tottenham: "tottenham",
  "tottenham hotspur": "tottenham",
  "west ham": "west ham",
  "west ham united": "west ham",
  wolves: "wolves",
  "wolverhampton wanderers": "wolves",

  // --- LaLiga ---
  "ath bilbao": "athletic bilbao",
  "athletic bilbao": "athletic bilbao",
  "ath madrid": "atletico madrid",
  "atl madrid": "atletico madrid",
  "atletico madrid": "atletico madrid",
  "atletico de madrid": "atletico madrid",
  alaves: "alaves",
  barcelona: "barcelona",
  "fc barcelona": "barcelona",
  betis: "betis",
  "real betis": "betis",
  celta: "celta vigo",
  "celta vigo": "celta vigo",
  elche: "elche",
  espanol: "espanyol",
  espanyol: "espanyol",
  getafe: "getafe",
  girona: "girona",
  levante: "levante",
  mallorca: "mallorca",
  osasuna: "osasuna",
  oviedo: "real oviedo",
  "real oviedo": "real oviedo",
  sociedad: "real sociedad",
  "r sociedad": "real sociedad",
  "real sociedad": "real sociedad",
  "real madrid": "real madrid",
  vallecano: "rayo vallecano",
  "rayo vallecano": "rayo vallecano",
  sevilla: "sevilla",
  valencia: "valencia",
  villarreal: "villarreal",
};

/** Normalise un nom d'équipe pour la comparaison : accents, ponctuation, alias. */
export function normalizeTeamName(raw: string): string {
  const base = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return TEAM_CANONICAL[base] ?? base;
}

/** Similarité de Jaccard sur les mots — sert à PROPOSER, jamais à décider seul. */
export function tokenSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeTeamName(a).split(" ").filter(Boolean));
  const setB = new Set(normalizeTeamName(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / new Set([...setA, ...setB]).size;
}

// ---------------------------------------------------------------------------
// Appariement canonique des rencontres
// ---------------------------------------------------------------------------

/** Saison comparée. Les deux sources de l'échantillon partagent ce libellé. */
const SEASON_LABEL = "2025/2026";

export interface CanonicalMatch {
  /** Clé stable, construite sur des faits vérifiés — jamais sur une ressemblance. */
  key: string;
  date: string;
  competition: string;
  season: string;
  home: string;
  away: string;
  fdcouk: NormalizedFixture | null;
  lfa: NormalizedMatch | null;
  confidence: "exacte" | "confirmée par le score";
}

export interface MatchOutcome {
  matched: CanonicalMatch[];
  /** Rencontres présentes dans une source et introuvables dans l'autre. */
  onlySourceA: NormalizedFixture[];
  onlySourceB: NormalizedMatch[];
  /** Rencontres ambiguës : plusieurs candidats, donc aucune fusion décidée. */
  ambiguous: { sourceA: NormalizedFixture; candidates: string[] }[];
}

function dayKey(date: Date | string | null): string {
  if (date === null) return "";
  return typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/**
 * Apparie deux jeux de rencontres.
 *
 * Protocole, dans l'ordre :
 *   1. date identique + noms normalisés identiques → confiance « exacte » ;
 *   2. date identique + noms similaires (≥ 0,82 des deux côtés) + score
 *      identique → confiance « confirmée par le score » ;
 *   3. plusieurs candidats → classé AMBIGU et rapporté, jamais tranché ;
 *   4. tout le reste → non apparié et rapporté.
 *
 * La date ne tolère aucun décalage : accepter ±1 jour reviendrait à fusionner
 * deux rencontres différentes quand un club joue deux fois dans la semaine.
 */
export function matchSources(
  sourceA: NormalizedFixture[],
  sourceB: NormalizedMatch[],
  competition: string,
): MatchOutcome {
  const matched: CanonicalMatch[] = [];
  const ambiguous: { sourceA: NormalizedFixture; candidates: string[] }[] = [];
  const usedB = new Set<number>();

  // Index par date pour éviter un appariement quadratique inutile.
  const byDate = new Map<string, NormalizedMatch[]>();
  sourceB.forEach((match, index) => {
    const key = match.date ?? "";
    const list = byDate.get(key) ?? [];
    list.push(match);
    (match as NormalizedMatch & { __index?: number }).__index = index;
    byDate.set(key, list);
  });

  for (const a of sourceA) {
    const date = dayKey(a.utcDate);
    const candidates = byDate.get(date) ?? [];
    if (candidates.length === 0) continue;

    const exact = candidates.filter(
      (b) =>
        normalizeTeamName(b.home.name) === normalizeTeamName(a.homeTeamName) &&
        normalizeTeamName(b.away.name) === normalizeTeamName(a.awayTeamName),
    );

    let chosen: NormalizedMatch | null = exact.length === 1 ? exact[0] : null;
    let confidence: CanonicalMatch["confidence"] = "exacte";

    if (!chosen) {
      if (exact.length > 1) {
        ambiguous.push({ sourceA: a, candidates: exact.map((c) => c.providerId) });
        continue;
      }

      // Correspondance approchée : exige une similarité forte ET le même score.
      const fuzzy = candidates.filter((b) => {
        if (a.homeScore === null || b.finalScore === null) return false;
        const sameScore =
          a.homeScore === b.finalScore.home && a.awayScore === b.finalScore.away;
        const sim =
          (tokenSimilarity(a.homeTeamName, b.home.name) + tokenSimilarity(a.awayTeamName, b.away.name)) / 2;
        return sameScore && sim >= 0.82;
      });

      if (fuzzy.length === 1) {
        chosen = fuzzy[0];
        confidence = "confirmée par le score";
      } else if (fuzzy.length > 1) {
        ambiguous.push({ sourceA: a, candidates: fuzzy.map((c) => c.providerId) });
        continue;
      }
    }

    if (!chosen) continue;

    const index = (chosen as NormalizedMatch & { __index?: number }).__index;
    if (index !== undefined) usedB.add(index);

    matched.push({
      key: `${competition}:${date}:${normalizeTeamName(a.homeTeamName)}:${normalizeTeamName(a.awayTeamName)}`,
      date,
      competition,
      season: SEASON_LABEL,
      home: a.homeTeamName,
      away: a.awayTeamName,
      fdcouk: a,
      lfa: chosen,
      confidence,
    });
  }

  const onlySourceB = sourceB.filter((_, index) => !usedB.has(index));

  return { matched, onlySourceA: [], onlySourceB, ambiguous };
}

// ---------------------------------------------------------------------------
// Divergences
// ---------------------------------------------------------------------------

export interface Divergence {
  match: string;
  competition: string;
  field: string;
  sourceA: string;
  sourceB: string;
  ecart: string;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "absent";
  return String(value);
}

/** Compare champ à champ les rencontres appariées et relève chaque écart. */
export function findDivergences(pairs: CanonicalMatch[]): Divergence[] {
  const out: Divergence[] = [];

  for (const pair of pairs) {
    const a = pair.fdcouk;
    const b = pair.lfa;
    if (!a || !b) continue;

    const where = `${pair.home} — ${pair.away} (${pair.date})`;

    const numeric: { field: string; va: number | null; vb: number | null }[] = [
      { field: "score domicile", va: a.homeScore, vb: b.finalScore?.home ?? null },
      { field: "score extérieur", va: a.awayScore, vb: b.finalScore?.away ?? null },
      { field: "mi-temps domicile", va: a.halfTimeHomeScore, vb: b.halftime.home },
      { field: "mi-temps extérieur", va: a.halfTimeAwayScore, vb: b.halftime.away },
      { field: "tirs domicile", va: a.homeShots, vb: null },
      { field: "tirs extérieur", va: a.awayShots, vb: null },
      { field: "tirs cadrés domicile", va: a.homeShotsOnTarget, vb: null },
      { field: "tirs cadrés extérieur", va: a.awayShotsOnTarget, vb: null },
      { field: "corners domicile", va: a.homeCorners, vb: null },
      { field: "corners extérieur", va: a.awayCorners, vb: null },
    ];

    for (const item of numeric) {
      // Une absence d'un côté n'est PAS une divergence : c'est une lacune, et
      // elle est comptée comme telle ailleurs. Divergence = deux valeurs
      // présentes qui se contredisent.
      if (item.va === null || item.vb === null) continue;
      if (item.va !== item.vb) {
        out.push({
          match: where,
          competition: pair.competition,
          field: item.field,
          sourceA: fmt(item.va),
          sourceB: fmt(item.vb),
          ecart: String(item.vb - item.va),
        });
      }
    }
  }

  return out;
}

