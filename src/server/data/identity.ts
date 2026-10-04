/**
 * ============================================================================
 * SOLEIL — Phase 16 · §10 et §17 · Identité des équipes et des rencontres
 * ============================================================================
 * Deux problèmes distincts, une seule racine : **un nom n'est pas un
 * identifiant**.
 *
 *   · Deux sources écrivent la même équipe différemment (« Ath Madrid »,
 *     « Atl. Madrid », « Celta » / « Celta Vigo »). Fusionner sur le nom
 *     fabrique de fausses identités ; ne jamais fusionner en fabrique de
 *     fausses équipes. La seule réponse honnête est un **identifiant
 *     fournisseur**, conservé tel quel.
 *
 *   · La même rencontre peut être rapportée plusieurs fois (deux
 *     synchronisations, deux sources). Créer deux prédictions pour une seule
 *     rencontre fausse toutes les mesures d'apprentissage.
 *
 * Ce module est **pur** : aucune base, aucun réseau. Il produit les clés que
 * l'ingestion écrira, et décide ce qui peut être fusionné.
 */

import { canonicalTeamKey } from "./teams";

/* -------------------------------------------------------------------------- */
/* §17 — Identité des équipes                                                   */
/* -------------------------------------------------------------------------- */

/** Estampille d'un identifiant fournisseur, telle qu'elle sera stockée. */
export const PROVIDER_REF_SEPARATOR = ":";

/**
 * Construit une référence fournisseur stable : `lfa:<id opaque>`.
 *
 * Renvoie `null` si l'identifiant est absent ou vide : un identifiant manquant
 * ne doit **jamais** être remplacé par le nom, sinon la déduplication se
 * rabattrait silencieusement sur une comparaison de chaînes.
 */
export function providerRef(provider: string, providerId: string | null | undefined): string | null {
  const id = (providerId ?? "").trim();
  if (!id) return null;
  return `${provider.trim().toLowerCase()}${PROVIDER_REF_SEPARATOR}${id}`;
}

export interface TeamIdentityInput {
  /** Identifiant fournisseur de l'équipe (opaque, ex. `9vh2u1p4…`). */
  providerId?: string | null;
  /** Nom tel que fourni par la source — conservé sans réécriture. */
  providerName: string;
  /** Nom canonique interne, si l'équipe est déjà connue. */
  canonicalName?: string | null;
  /** Pays fourni par la source. Jamais déduit du nom (§15). */
  country?: string | null;
  /** Logo fourni par la source. Jamais construit (§15). */
  logo?: string | null;
}

export interface TeamIdentity {
  providerRef: string | null;
  /** Nom à écrire dans `Team.name` : le nom fournisseur, non réécrit. */
  name: string;
  country: string | null;
  crest: string | null;
  /** Vrai si l'identité repose sur un identifiant fournisseur (donc fiable). */
  strongIdentity: boolean;
}

/**
 * Prépare l'identité d'une équipe pour la persistance.
 *
 * Le nom fournisseur est conservé **tel quel** : c'est lui qui sera affiché à
 * l'utilisateur, et c'est la seule écriture vérifiable. Le nom canonique sert
 * au rapprochement, jamais à réécrire ce que la source a publié.
 */
export function buildTeamIdentity(input: TeamIdentityInput, provider: string): TeamIdentity {
  const ref = providerRef(provider, input.providerId);
  const name = input.providerName.trim();
  return {
    providerRef: ref,
    name,
    country: input.country?.trim() || null,
    crest: input.logo?.trim() || null,
    // Sans identifiant fournisseur, l'identité reste faible : le rapprochement
    // par nom ne doit pas être présenté comme une certitude.
    strongIdentity: ref !== null,
  };
}

/**
 * Clé de rapprochement « relâchée » : mêmes règles que la clé canonique, mais
 * l'apostrophe est **supprimée** au lieu de devenir un espace.
 *
 * Pourquoi cette variante existe : les sources historiques écrivent
 * « Nott'm Forest », le calendrier écrit « Nottingham Forest ». La clé
 * canonique de la première donne « nott-m-forest » — la table d'alias, qui
 * contient bien « nottm forest », ne peut donc jamais s'appliquer. Sans cette
 * clé, l'équipe serait dupliquée, perdrait son historique et aucune prédiction
 * ne serait possible pour ses rencontres (§12).
 *
 * La fonction reste une **comparaison de chaînes déterministe** : aucune
 * similarité floue, aucun seuil — soit les clés sont égales, soit elles ne le
 * sont pas.
 */
export function relaxedTeamKey(name: string): string {
  return canonicalTeamKey(name.replace(/['\u2019\u02bc`]/g, ""));
}

/* -------------------------------------------------------------------------- */
/* §10 — Déduplication des rencontres                                          */
/* -------------------------------------------------------------------------- */

/**
 * Clé stable d'une rencontre côté fournisseur : `provider:matchId`.
 * Renvoie `null` si l'identifiant manque — on ne substitue jamais une clé
 * approximative à une clé absente.
 */
export function providerMatchKey(provider: string, providerId: string | null | undefined): string | null {
  return providerRef(provider, providerId);
}

/**
 * Clé de secours, utilisée **uniquement** quand aucun identifiant fournisseur
 * n'est disponible (§10). Trois composants, tous obligatoires :
 *
 *   compétition · équipe domicile · équipe extérieur · **fenêtre de date**
 *
 * La fenêtre tolère ± 1 jour : une rencontre peut basculer d'un jour à l'autre
 * selon le fuseau de la source. La tolérance est **bornée** (3 clés au
 * maximum), jamais ouverte.
 */
export interface FallbackKeyInput {
  competition: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Journée UTC de la rencontre, `YYYY-MM-DD`. */
  dayKey: string;
}

export function fallbackMatchKeys(input: FallbackKeyInput): string[] {
  // `Date.parse` accepte des formes surprenantes (« 3 octobre » devient une
  // date valide en 2001). On exige donc explicitement la forme `AAAA-MM-JJ`
  // avant de calculer quoi que ce soit : une clé de secours approximative sur
  // une date illisible créerait de faux doublons.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dayKey)) return [];
  const base = Date.parse(`${input.dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return [];
  const prefix = `${input.competition}|${input.homeTeamId}|${input.awayTeamId}`;
  return [-1, 0, 1].map((offset) => `${prefix}|${new Date(base + offset * 86_400_000).toISOString().slice(0, 10)}`);
}

/**
 * Décide ce qu'il faut faire d'une rencontre reçue.
 *
 *   · `key` non nul  → identifiant fournisseur connu : la rencontre est
 *     **reconnue** et sera mise à jour (idempotence §11).
 *   · `key` nul mais clé de secours trouvée → reconnue aussi, mais signalée
 *     `approximate: true` : la fusion repose sur une heuristique, elle doit
 *     rester visible dans les comptes rendus.
 *   · rien → `create` : nouvelle rencontre.
 */
export type MatchDecision =
  | { action: "update"; reason: "IDENTIFIANT_FOURNISSEUR"; matchedKey: string; approximate: false }
  | { action: "update"; reason: "CLE_DE_SECOURS"; matchedKey: string; approximate: true }
  | { action: "create"; reason: "NOUVELLE_RENCONTRE"; matchedKey: null; approximate: false };

export function decideMatch(input: {
  providerKey: string | null;
  existingByProviderKey: boolean;
  fallbackKeys: string[];
  existingFallbackKeys: Set<string>;
}): MatchDecision {
  if (input.providerKey && input.existingByProviderKey) {
    return {
      action: "update",
      reason: "IDENTIFIANT_FOURNISSEUR",
      matchedKey: input.providerKey,
      approximate: false,
    };
  }

  const matched = input.fallbackKeys.find((key) => input.existingFallbackKeys.has(key));
  if (matched) {
    return { action: "update", reason: "CLE_DE_SECOURS", matchedKey: matched, approximate: true };
  }

  return { action: "create", reason: "NOUVELLE_RENCONTRE", matchedKey: null, approximate: false };
}

/* -------------------------------------------------------------------------- */
/* §31 — Séparation test / production                                          */
/* -------------------------------------------------------------------------- */

/**
 * Préfixe réservé aux rencontres fabriquées pour les tests. Une rencontre dont
 * l'identifiant fournisseur porte ce préfixe **ne peut pas** être affichée :
 * `evaluateForDisplay` la refuse avec la raison `MASQUE_POUR_TEST`.
 */
export const TEST_FIXTURE_PREFIX = "test:";

export function isTestFixture(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(TEST_FIXTURE_PREFIX);
}
