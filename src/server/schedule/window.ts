/**
 * ============================================================================
 * SOLEIL — Phase 16 · §7, §8, §18, §29 · Calendrier : journées et sûreté
 * ============================================================================
 * Ce module ne décide **pas** ce qui est affichable : cette décision existe
 * déjà, en un seul endroit, dans `@/server/predictions/upcoming`
 * (`toPublicStatus` + `listUpcomingPredictions`, livrés en Phase 15). La règle
 * de la Phase 16 est explicite : **inspecter et réutiliser, ne rien recréer**
 * (§4). Ce fichier apporte donc uniquement ce qui manquait :
 *
 *   · **§7** — quelles journées il est légitime de demander au fournisseur
 *     (aujourd'hui, demain, les jours suivants), sans jamais se limiter à un
 *     seul jour ;
 *   · **§8** — les conversions de temps : tout passe par un horodatage
 *     (millisecondes UTC). Aucun filtre ne compare des chaînes de caractères ;
 *   · **§18** — les libellés de journée (« Aujourd'hui », « Demain », « 3
 *     octobre ») calculés sur des bornes UTC, donc identiques côté serveur et
 *     côté navigateur ;
 *   · **§29** — l'assertion de sûreté du flux public, réutilisable par les
 *     tests et par la couche d'affichage : *aucune rencontre affichée ne peut
 *     être déjà commencée.*
 */

import { toPublicStatus, type PublicMatchStatus } from "@/server/predictions/upcoming";

// Réexport assumé : une seule implémentation, deux points d'entrée lisibles.
export { toPublicStatus };
export type { PublicMatchStatus };

/** Le flux public n'accepte qu'un statut (§9). */
export const PUBLIC_DISPLAY_STATUSES: readonly PublicMatchStatus[] = ["UPCOMING"];

/* -------------------------------------------------------------------------- */
/* §8 — Temps : horodatage normalisé, jamais une chaîne                        */
/* -------------------------------------------------------------------------- */

/**
 * Convertit une valeur quelconque en millisecondes UTC.
 *
 * Renvoie `null` — jamais `NaN`, jamais une date « par défaut » — si la valeur
 * est illisible. Une rencontre dont l'heure n'est pas exploitable n'est ni
 * importée, ni affichée : deviner reviendrait à inventer une donnée (§13).
 */
export function toTimestamp(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

/** Vrai si l'horodatage est strictement postérieur à `now`. */
export function isFuture(value: Date | string | number | null | undefined, now: Date): boolean {
  const time = toTimestamp(value);
  if (time === null) return false;
  return time > now.getTime();
}

/** Journée UTC au format `YYYY-MM-DD`. */
export function utcDayKey(instant: Date | string | number): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  return date.toISOString().slice(0, 10);
}

/** Bornes d'une journée UTC, en millisecondes. */
export function utcDayBounds(dayKey: string): { startMs: number; endMs: number } {
  const start = Date.parse(`${dayKey}T00:00:00.000Z`);
  return { startMs: start, endMs: start + 86_400_000 - 1 };
}

/* -------------------------------------------------------------------------- */
/* §7, §18 — Fenêtres d'import et libellés                                     */
/* -------------------------------------------------------------------------- */

export interface ImportWindow {
  /** Journée visée par l'appel fournisseur, `YYYY-MM-DD` (UTC). */
  date: string;
  /** Premier instant de la journée (ms UTC). */
  startMs: number;
  /** Dernier instant de la journée (ms UTC). */
  endMs: number;
  /** Décalage en jours par rapport à aujourd'hui (0 = aujourd'hui). */
  offsetDays: number;
  /** Libellé français, pour l'affichage (§18). */
  label: string;
}

/** Libellé lisible d'une journée relative à aujourd'hui (§18). */
export function dayLabel(offsetDays: number, startMs: number): string {
  if (offsetDays === 0) return "Aujourd'hui";
  if (offsetDays === 1) return "Demain";
  if (offsetDays === -1) return "Hier";
  return new Date(startMs).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/**
 * Journées à demander au fournisseur.
 *
 * §7 exige de ne pas se contenter de « demain » : on couvre aujourd'hui, demain
 * puis les jours suivants. La profondeur est un paramètre **explicite** — le
 * coût d'un import dépend directement de ce nombre, il ne doit jamais être
 * caché dans le code.
 */
export function importWindows(
  now: Date,
  options: { daysAhead?: number; includeToday?: boolean } = {},
): ImportWindow[] {
  const { daysAhead = 3, includeToday = true } = options;
  const base = Date.parse(`${utcDayKey(now)}T00:00:00.000Z`);
  const windows: ImportWindow[] = [];

  for (let offset = includeToday ? 0 : 1; offset <= daysAhead; offset += 1) {
    const startMs = base + offset * 86_400_000;
    const { endMs } = utcDayBounds(utcDayKey(new Date(startMs)));
    windows.push({
      date: utcDayKey(new Date(startMs)),
      startMs,
      endMs,
      offsetDays: offset,
      label: dayLabel(offset, startMs),
    });
  }

  return windows;
}

/* -------------------------------------------------------------------------- */
/* §29 — Test critique : rien de déjà commencé dans le flux public             */
/* -------------------------------------------------------------------------- */

export interface DisplayableLike {
  status: string | null | undefined;
  utcDate: Date | string | number | null | undefined;
  prediction?: { status?: string | null; modelVersion?: string | null } | null;
}

export interface SafetyViolation {
  index: number;
  code: "STATUT" | "DATE_INVALIDE" | "DEJA_COMMENCE" | "SANS_PREDICTION" | "NON_PUBLIEE" | "SANS_VERSION";
  detail: string;
}

/**
 * Vérifie les quatre invariants du §29 sur une liste **destinée à l'affichage** :
 *
 *   1. `start_time` strictement postérieure à l'instant de référence ;
 *   2. statut public `UPCOMING` ;
 *   3. prédiction présente ;
 *   4. version de modèle présente (une prédiction non versionnée n'est pas
 *      traçable, donc pas publiable).
 *
 * Renvoie la liste des violations — **vide** vaut conformité. Cette fonction ne
 * corrige rien : si elle signale quelque chose, l'affichage doit être bloqué,
 * jamais rafistolé.
 */
export function assertNoStartedMatchInFeed(feed: DisplayableLike[], now: Date): SafetyViolation[] {
  const violations: SafetyViolation[] = [];

  feed.forEach((match, index) => {
    const status = toPublicStatus(match.status as never);
    if (status !== "UPCOMING") {
      violations.push({ index, code: "STATUT", detail: `statut public ${status} (${String(match.status)})` });
    }

    const kickoff = toTimestamp(match.utcDate);
    if (kickoff === null) {
      violations.push({ index, code: "DATE_INVALIDE", detail: "coup d'envoi illisible" });
    } else if (kickoff <= now.getTime()) {
      violations.push({
        index,
        code: "DEJA_COMMENCE",
        detail: `coup d'envoi ${new Date(kickoff).toISOString()} ≤ référence ${now.toISOString()}`,
      });
    }

    if (!match.prediction) {
      violations.push({ index, code: "SANS_PREDICTION", detail: "aucune prédiction" });
    } else {
      if (match.prediction.status !== "PUBLISHED") {
        violations.push({ index, code: "NON_PUBLIEE", detail: String(match.prediction.status) });
      }
      if (!match.prediction.modelVersion || match.prediction.modelVersion.trim() === "") {
        violations.push({ index, code: "SANS_VERSION", detail: "modelVersion absente" });
      }
    }
  });

  return violations;
}
