import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/** Affiche l'identifiant de la prédiction publiée la plus confiante (usage CLI). */
async function main() {
  const p = await prisma.prediction.findFirst({
    where: { status: { in: ["SETTLED", "PUBLISHED"] } },
    orderBy: { confidenceScore: "desc" },
    select: { matchId: true, confidenceScore: true },
  });
  console.log(p?.matchId ?? "");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
