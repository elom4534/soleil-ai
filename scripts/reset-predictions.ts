import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/**
 * Script de maintenance : supprime toutes les prédictions.
 *
 * ⚠️ En production, cette opération viole la règle §22 (une prédiction publiée
 * n'est jamais modifiée rétroactivement). Elle n'existe ici que pour permettre
 * de reconstruire l'historique lors d'un changement de format de persistance
 * pendant le développement. Elle exige le drapeau --confirm.
 */
async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusé : ajoutez --confirm pour autoriser la suppression.");
    process.exitCode = 1;
    return;
  }
  const deleted = await prisma.prediction.deleteMany();
  console.log(`🗑️  ${deleted.count} prédiction(s) supprimée(s).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
