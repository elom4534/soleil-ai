/**
 * ============================================================================
 * SOLEIL — Vérifications de LECTURE après restauration de l'historique
 * ============================================================================
 * Lecture seule : aucun écrit, aucune modification du moteur, des modèles ou
 * des services de prédiction. Appelle uniquement `buildMatchContext` (service
 * existant) pour vérifier l'exploitabilité des rencontres par la prédiction.
 *
 * Usage : node_modules/.bin/tsx scripts/verify-history.ts
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { buildMatchContext } from "../src/server/predictions/context";

async function main() {
  const [matchesTotal, matchesFinished, matchesScheduled, leagues, teams] = await Promise.all([
    prisma.match.count(),
    prisma.match.count({ where: { status: "FINISHED" } }),
    prisma.match.count({ where: { status: "SCHEDULED" } }),
    prisma.league.count(),
    prisma.team.count(),
  ]);

  console.log("── BLOC DE VÉRIFICATION ──");
  console.log(`MATCHES_TOTAL=${matchesTotal}`);
  console.log(`MATCHES_FINISHED=${matchesFinished}`);
  console.log(`MATCHES_SCHEDULED=${matchesScheduled}`);
  console.log(`LEAGUES=${leagues}`);
  console.log(`TEAMS=${teams}`);

  console.log("\n── HISTORIQUE PAR COMPÉTITION ──");
  for (const code of ["SP1", "E0"]) {
    const league = await prisma.league.findFirst({ where: { externalId: `code:${code}` } });
    if (!league) {
      console.log(`${code} : compétition absente`);
      continue;
    }
    const finished = await prisma.match.count({ where: { leagueId: league.id, status: "FINISHED" } });
    const scheduled = await prisma.match.count({ where: { leagueId: league.id, status: "SCHEDULED" } });
    const first = await prisma.match.findFirst({
      where: { leagueId: league.id, status: "FINISHED" },
      orderBy: { utcDate: "asc" },
      select: { utcDate: true },
    });
    const last = await prisma.match.findFirst({
      where: { leagueId: league.id, status: "FINISHED" },
      orderBy: { utcDate: "desc" },
      select: { utcDate: true },
    });
    console.log(
      `${code} (${league.name}) : ${finished} terminé(s), ${scheduled} programmé(s) · ` +
        `historique ${first?.utcDate.toISOString().slice(0, 10) ?? "?"} → ${last?.utcDate.toISOString().slice(0, 10) ?? "?"}`,
    );
  }

  console.log("\n── TEST PRÉDICTION · match historique de LaLiga (SP1) ──");
  const historical = await prisma.match.findFirst({
    where: { league: { externalId: "code:SP1" }, status: "FINISHED" },
    orderBy: { utcDate: "desc" },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!historical) {
    console.log("Aucun match historique SP1 trouvé.");
  } else {
    const result = await buildMatchContext(historical.id, new Date(historical.utcDate.getTime() - 1000));
    console.log(`match : ${historical.homeTeam.name} – ${historical.awayTeam.name} (${historical.utcDate.toISOString().slice(0, 10)})`);
    if (result.context) {
      console.log("EXPLOITABLE=oui — contexte de prédiction construit");
    } else {
      console.log(`EXPLOITABLE=non — ${result.reason ?? "motif inconnu"}`);
    }
  }

  console.log("\n── TEST PRÉDICTION · match programmé (SP1) ──");
  const scheduled = await prisma.match.findFirst({
    where: { league: { externalId: "code:SP1" }, status: "SCHEDULED" },
    orderBy: { utcDate: "asc" },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!scheduled) {
    console.log("Aucun match programmé SP1 trouvé.");
  } else {
    const result = await buildMatchContext(scheduled.id);
    console.log(`match : ${scheduled.homeTeam.name} – ${scheduled.awayTeam.name} (${scheduled.utcDate.toISOString().slice(0, 10)})`);
    if (result.context) {
      console.log(`TEST=OK — contexte construit (${result.reason ?? "sans réserve"})`);
    } else {
      console.log(`TEST=BLOQUÉ — ${result.reason ?? "motif inconnu"}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERREUR " + String((e as Error).message).slice(0, 300));
  process.exit(1);
});
