/**
 * Petit compteur d'état de la base — utilisé par `start-app.sh` pour savoir si
 * le réimport est nécessaire. Aucune écriture, aucun réseau.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const rows = await prisma.$queryRawUnsafe<{ m: number; p: number }[]>(
    'select (select count(*) from "Match")::int as m, (select count(*) from "Prediction")::int as p',
  );
  console.log(JSON.stringify(rows[0]));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("ERREUR " + String((error as Error).message).slice(0, 160));
  process.exit(1);
});
