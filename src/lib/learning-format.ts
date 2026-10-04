/**
 * Libellés français des états du registre de versions (§7 Phase 15).
 * Fonction pure, sans dépendance serveur : utilisable par les pages comme par
 * les tests.
 */

export type VersionStatusLabel = "CANDIDATE" | "ACTIVE" | "ROLLED_BACK" | "ARCHIVED";

const LABELS: Record<string, string> = {
  CANDIDATE: "Candidate",
  ACTIVE: "En production",
  ROLLED_BACK: "Retirée",
  ARCHIVED: "Archivée",
};

export function sortieHumaine(status: string): string {
  return LABELS[status] ?? status;
}
