/**
 * ============================================================================
 * SOLEIL — Règle de fraîcheur des prédictions (automatisation)
 * ============================================================================
 * Une prédiction sur un match encore `SCHEDULED` n'est pas éternellement
 * valable : le contexte historique qui l'a produite peut avoir été enrichi
 * après sa génération (import d'historique, statistiques), et une prédiction
 * peut simplement avoir trop d'âge pour un match à venir.
 *
 * Cette règle décide **si** un recalcul est légitime, et **pour quel motif**.
 * Elle ne touche ni au moteur, ni aux formules : elle ne fait que comparer
 * des dates. Deux motifs, tracés tels quels :
 *
 *   · `context enriched`  — des données utilisables par le contexte sont
 *     arrivées après la génération de la prédiction ;
 *   · `stale prediction`  — la prédiction dépasse l'âge maximal toléré sur
 *     un match encore à jouer (recalcul borné : après rafraîchissement, la
 *     prédiction redevient récente — aucune boucle possible).
 *
 * Une prédiction `SETTLED` n'entre jamais ici : elle est protégée en amont
 * (§22) et dans `generateAndPersist`.
 */

/** Âge maximal d'une prédiction sur un match à venir : 24 heures. */
export const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type RefreshReason = "context enriched" | "stale prediction";

/**
 * Décision pure (aucune base, aucun effet de bord) : la prédiction doit-elle
 * être recalculée, et pour quel motif ?
 *
 * @param generatedAt  date de génération de la prédiction existante
 * @param contextUpdatedAt  dernière mise à jour des données du contexte
 *   (matchs antérieurs des deux équipes, données live, match lui-même)
 * @param now  date courante
 */
export function refreshReason(
  generatedAt: Date,
  contextUpdatedAt: Date | null,
  now: Date,
  maxAgeMs: number = STALE_MAX_AGE_MS,
): RefreshReason | null {
  // 1. Contexte enrichi : des données utilisables sont arrivées après coup.
  if (contextUpdatedAt && contextUpdatedAt.getTime() > generatedAt.getTime()) {
    return "context enriched";
  }
  // 2. Péremption : trop ancienne pour un match encore à jouer.
  if (now.getTime() - generatedAt.getTime() > maxAgeMs) {
    return "stale prediction";
  }
  // 3. Rien n'a changé, elle est encore jeune : ne pas toucher (§11).
  return null;
}
