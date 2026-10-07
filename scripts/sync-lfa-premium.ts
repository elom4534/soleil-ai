/**
 * SOLEIL — Import premium (Live Football API)
 *
 * Usage :
 *   npx tsx scripts/sync-lfa-premium.ts [--stats=90] [--context] [--logos] [--all]
 *
 * Source PRIORITAIRE des données récentes (mission 21). Aucune donnée
 * historique existante n'est supprimée : uniquement de l'UPSERT.
 */

import fs from "node:fs";
import path from "node:path";

// Chargement du .env (mêmes règles que les autres scripts).
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { prisma } from "@/lib/prisma";
import {
  LFA_LEAGUES,
  syncLfaLeague,
  enrichRecentStats,
  refreshUpcomingContext,
  discoverUpcoming,
  syncTeamLogos,
} from "@/server/data/lfaPremium";

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const statsDays = Number(args.find((a) => a.startsWith("--stats="))?.split("=")[1] ?? 45);
  const statsLimit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 90);

  console.log("═══ SOLEIL — synchronisation premium (Live Football API) ═══\n");

  let inserted = 0;
  let updated = 0;
  if (all || args.includes("--sync") || (!args.some((a) => a.startsWith("--")))) {
  console.log("1. Saisons courantes des compétitions prioritaires…");
  for (const code of Object.keys(LFA_LEAGUES)) {
    const s = await syncLfaLeague(code);
    inserted += s.inserted;
    updated += s.updated;
    console.log(
      `   ${code.padEnd(5)} reçus=${String(s.received).padStart(4)} · créés=${String(s.inserted).padStart(4)} · maj=${String(s.updated).padStart(4)}${s.errors.length ? " · erreurs=" + s.errors.length : ""}`,
    );
  }
  console.log(`   → ${inserted} création(s), ${updated} mise(s) à jour\n`);
  }

  if (all || args.includes("--discover")) {
    console.log("2. Découverte des jours à venir…");
    const disc = await discoverUpcoming(3);
    console.log(`   ${disc.reduce((a, s) => a + s.inserted + s.updated, 0)} match(s) traités\n`);
  }

  if (all || args.includes("--stats")) {
  console.log("3. Statistiques détaillées des matchs récents…");
  const stats = await enrichRecentStats(statsDays, statsLimit);
  console.log(`   candidats=${stats.candidates} · enrichis=${stats.enriched} · crédits dépensés=${stats.creditsSpent}\n`);
  }

  if (all || args.includes("--context")) {
    console.log("4. Contexte des matchs à venir (H2H, blessures, compositions)…");
    const ctx = await refreshUpcomingContext(5, 18);
    console.log(`   matchs=${ctx.matches} · h2h=${ctx.withH2h} · blessures=${ctx.withInjuries}\n`);
  }

  if (all || args.includes("--logos")) {
    console.log("5. Logos et identité des équipes…");
    const runs = Number(args.find((a) => a.startsWith("--logos="))?.split("=")[1] ?? 1);
    let done = 0;
    let missing = 0;
    for (let i = 0; i < runs; i++) {
      const logos = await syncTeamLogos(200);
      done += logos.updated;
      missing += logos.missing;
      if (logos.scanned === 0) break;
    }
    console.log(`   logos attribués=${done} · introuvables=${missing}\n`);
  }

  // Contrôle qualité de mission : doublons, fraîcheur.
  const total = await prisma.match.count();
  const teams = await prisma.team.count();
  const withLogo = await prisma.team.count({ where: { crest: { not: null } } });
  const live = await prisma.matchLiveData.count();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const recent = await prisma.match.count({ where: { status: "FINISHED", utcDate: { gte: since } } });
  const upcoming = await prisma.match.count({ where: { status: "SCHEDULED", utcDate: { gte: new Date() } } });
  console.log("═══ État final ═══");
  console.log(`Matchs: ${total} · récents(30j): ${recent} · à venir: ${upcoming}`);
  console.log(`Équipes: ${teams} · avec logo: ${withLogo} (${Math.round((withLogo / teams) * 100)}%)`);
  console.log(`MatchLiveData (stats détaillées): ${live}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Échec :", e.message);
  process.exit(1);
});
