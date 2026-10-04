/**
 * ============================================================================
 * SOLEIL — Outils partagés des sondes fournisseurs
 * ============================================================================
 * Une sonde répond à une seule question : « que contient réellement
 * l'abonnement ? ». Elle ne synchronise rien, ne remplit aucune table métier et
 * ne doit consommer que le strict nécessaire.
 *
 * Ce module ne contient aucune logique propre à un fournisseur : chaque
 * fournisseur fournit son « profil » (plan d'appel + lecture des réponses).
 */

// ---------------------------------------------------------------------------
// Types communs
// ---------------------------------------------------------------------------

export interface Args {
  provider: string;
  budget: number;
  dryRun: boolean;
  league: number;
  team?: string;
  baseUrl?: string;
  authStyle: "header" | "query";
  headerName?: string;
  queryParam?: string;
  dataPath: string[];
}

export interface ProbeContext {
  today: string;
  yesterday: string;
  lastSaturday: string;
  nextSaturday: string;
  league: number;
  season: number;
  /** Identifiants génériques, propres au fournisseur. */
  slots: Record<string, string | undefined>;
  /* --- Héritage API-SPORTS (identifiants numériques) --- */
  fixtureId?: number;
  homeTeamId?: number;
  awayTeamId?: number;
  teamId?: number;
}

export interface ProbeStep {
  /** Identifiant court, utilisé dans le rapport. */
  key: string;
  /** Question à laquelle l'étape répond. */
  question: string;
  /** Endpoint appelé, relatif à l'URL de base. */
  endpoint: string;
  /** Paramètres de requête. `undefined` = paramètre omis. */
  params: (ctx: ProbeContext) => Record<string, string | number | undefined>;
  /** Coût en crédits. */
  cost: number;
  /** Indispensable à la suite de l'audit ? */
  required: boolean;
  /** Durée de mise en cache de la réponse, en secondes. */
  ttlSeconds?: number;
  /** Retourne un motif d'exclusion pour éviter une dépense inutile. */
  skipIf?: (ctx: ProbeContext) => string | null;
}

export interface StepAnalysis {
  /** Constats lisibles, affichés tels quels dans le rapport. */
  answers: string[];
  /** Preuves structurées, pour vérification ultérieure. */
  evidence?: Record<string, unknown>;
}

export interface ProbeProfile {
  /** Nom lisible du plan. */
  label: string;
  /** Plan d'appel, ordonné : les étapes précoces alimentent les suivantes. */
  steps: ProbeStep[];
  /** Délai minimal entre deux appels (limite de débit). */
  minIntervalMs: number;
  /** Lecture d'une réponse brute → constats. */
  analyse: (key: string, raw: unknown, ctx: ProbeContext) => StepAnalysis;
  /** Alimentation du contexte pour les étapes suivantes. */
  hydrate: (key: string, raw: unknown, ctx: ProbeContext) => void;
}

// ---------------------------------------------------------------------------
// Lecture générique des réponses
// ---------------------------------------------------------------------------

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Accès sûr à une valeur imbriquée, par chemin pointé. */
export function at(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    node = Array.isArray(node)
      ? node[Number(segment)]
      : (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Recherche récursive d'une clé correspondant à un motif. */
export function findKeys(raw: unknown, pattern: RegExp, maxDepth = 6, path = ""): string[] {
  if (maxDepth <= 0 || raw === null || typeof raw !== "object") return [];
  const found: string[] = [];
  if (Array.isArray(raw)) {
    if (raw.length > 0) found.push(...findKeys(raw[0], pattern, maxDepth - 1, `${path}[]`));
    return [...new Set(found)];
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (pattern.test(key)) found.push(here);
    found.push(...findKeys(value, pattern, maxDepth - 1, here));
  }
  return [...new Set(found)];
}

/** Inventaire des champs terminaux, avec un exemple de valeur. */
export function surveyFields(raw: unknown, maxDepth = 5): { path: string; sample: string }[] {
  const out: { path: string; sample: string }[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth <= 0 || node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      if (path) out.push({ path, sample: String(node).slice(0, 40) });
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > 0) walk(node[0], `${path}[]`, depth - 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, path ? `${path}.${key}` : key, depth - 1);
    }
  };
  walk(raw, "", maxDepth);
  return out.slice(0, 220);
}

/**
 * Détecte la présence de l'expected goals sous toutes ses formes connues.
 * La détection se fait sur les VALEURS, jamais sur un simple intitulé
 * d'endpoint : un faux positif ferait croire à une donnée qui n'existe pas.
 */
export function detectXg(raw: unknown): {
  present: boolean;
  paths: string[];
  evidence: string[];
} {
  const paths = [
    ...findKeys(raw, /expected[_ ]?goals?/i),
    ...findKeys(raw, /^xg/i),
    ...findKeys(raw, /\bxg[a-z]*/i),
  ];
  const unique = [...new Set(paths)];

  const evidence: string[] = [];

  // Certains fournisseurs nomment la statistique dans une CLÉ (`expected_goals`),
  // d'autres dans une VALEUR de libellé (`{ label: "Expected Goals" }`). Ne
  // chercher que les clés ferait conclure à tort que le xG est absent — c'est
  // précisément l'erreur que cette sonde doit rendre impossible.
  const LABEL_KEYS = /^(label|type|name|stat|metric|title|key|display)$/i;
  const XG_TEXT = /expected[_ ]?goals?|\bxg\b/i;

  const walk = (node: unknown, path: string, depth: number) => {
    if (depth <= 0 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      // 12 éléments : une liste de statistiques est courte, et une statistique
      // décisive peut figurer en dernière position. L'échantillonner à 2
      // revenait à ne pas la voir.
      node.slice(0, 12).forEach((item, i) => walk(item, `${path}[${i}]`, depth - 1));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (
        /expected[_ ]?goals?|^xg/i.test(key) &&
        (typeof value === "number" || typeof value === "string")
      ) {
        evidence.push(`${here} = ${String(value).slice(0, 20)}`);
      }
      if (LABEL_KEYS.test(key) && typeof value === "string" && XG_TEXT.test(value)) {
        evidence.push(`${here} = "${value}" (libellé de statistique)`);
      }
      walk(value, here, depth - 1);
    }
  };
  walk(raw, "", 6);

  return { present: evidence.length > 0, paths: unique, evidence: evidence.slice(0, 12) };
}

/** Cherche la structure du score, dont le score à la mi-temps. */
export function detectScores(raw: unknown): { halftime: boolean; final: boolean; paths: string[] } {
  const paths = findKeys(raw, /halftime|half_time|score|goals/i);
  return {
    halftime: /halftime|half_time/i.test(paths.join(" ")),
    final: paths.some((p) => /fulltime|score|goals/i.test(p)),
    paths: [...new Set(paths)].slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Statistiques descriptives
// ---------------------------------------------------------------------------

/** Pourcentage non nul d'un champ sur un ensemble d'objets. */
export function fillRate(
  items: unknown[],
  getter: (item: Record<string, unknown>) => unknown,
): { filled: number; total: number; percent: number } {
  const total = items.length;
  const filled = items.filter((item) => {
    const value = getter(asObject(item));
    return value !== null && value !== undefined && value !== "";
  }).length;
  return { filled, total, percent: total === 0 ? 0 : Math.round((filled / total) * 100) };
}

/** Répartition des valeurs d'un champ, du plus fréquent au moins fréquent. */
export function distribution(
  items: unknown[],
  getter: (item: Record<string, unknown>) => unknown,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const raw = getter(asObject(item));
    const key = raw === null || raw === undefined ? "(absent)" : String(raw);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

// ---------------------------------------------------------------------------
// Dates utiles au plan de sonde
// ---------------------------------------------------------------------------

/** Dernier samedi écoulé (journée à forte densité de rencontres). */
export function lastSaturday(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const delta = (d.getUTCDay() + 1) % 7 || 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

/** Samedi suivant (preuve que le calendrier s'étend vers l'avant). */
export function nextSaturday(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const delta = (6 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
