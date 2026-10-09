/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Enrichissement xG (Payant, tracé, par étapes)
 * ============================================================================
 * Scénario validé : « C — Premier League complète + LaLiga partielle ».
 *
 *   · Premier League 2024/2025  : saison complète
 *   · LaLiga 2024/2025          : 8 dernières journées seulement
 *
 * §20 — Règles appliquées :
 *   · le coût estimé et le solde restant sont affichés AVANT toute dépense ;
 *   · clé 1 uniquement — les clés 2 à 18 ne sont ni utilisées ni sollicitées ;
 *   · cache d'abord : une rencontre déjà en cache ne coûte rien ;
 *   · écriture incrémentale : un arrêt intempestif ne fait pas perdre la dépense ;
 *   · arrêt automatique si le xG est absent de l'historique (cf. §6 du rapport
 *     d'étape : l'audit §22 l'a confirmé sur des matchs récents, pas sur 2024/2025).
 *
 * Ce script n'écrit AUCUNE donnée inventée : une rencontre sans xG est
 * enregistrée avec `null`.
 *
 * Usage : npm run backtest:enrich -- --confirm
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ApiFootballLiveClient } from "../../src/server/data/providers/apiFootballLive/client";
import {
  getCompetitionFixtures,
  getMatch,
  type NormalizedMatch,
} from "../../src/server/data/providers/apiFootballLive/adapter";
import { resolvePreset } from "../../src/server/data/providers/apiFootballLive/presets";
import type { NormalizedFixture } from "../../src/server/data/providers/types";
import { matchSources } from "../lib/source-matching";
import { loadCompetition, featuresPath, type BacktestMatch, type XgRecord } from "./dataset";
import { prisma } from "../../src/lib/prisma";

/** Identifiants fournisseur. */
const LEAGUES: Record<string, string> = {
  E0: "2kwbbcootiqqgmrzs6o5inle5",
  SP1: "34pl8szyvrbwcmfkuocjm3r6t",
};

const SEASON = "2024/2025";
/** Dernières journées retenues pour la compétition partielle. */
const TAIL_MATCHDAYS = 8;
/** Pause entre appels : le fournisseur limite à 2 req/s par IP. */
const CALL_DELAY_MS = 600;
/** Contrôle de sûreté avant l'engagement complet. */
const PROBE_MATCHES = 3;

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convertit un match du backtest au contrat « source » utilisé par l'appariement. */
function asFixture(match: BacktestMatch): NormalizedFixture {
  return {
    externalId: match.id,
    sourceRef: `fdcouk:${match.competition}`,
    competition: { code: match.competition, name: match.competition, country: "" },
    utcDate: match.date,
    status: match.homeGoals !== null ? "finished" : "scheduled",
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    homeScore: match.homeGoals,
    awayScore: match.awayGoals,
    halfTimeHomeScore: match.halfTimeHomeGoals,
    halfTimeAwayScore: match.halfTimeAwayGoals,
    homeXg: match.homeXg,
    awayXg: match.awayXg,
    homeShots: match.homeShots,
    awayShots: match.awayShots,
    homeShotsOnTarget: match.homeShotsOnTarget,
    awayShotsOnTarget: match.awayShotsOnTarget,
    homeCorners: match.homeCorners,
    awayCorners: match.awayCorners,
    homeYellowCards: match.homeYellowCards,
    awayYellowCards: match.awayYellowCards,
    // Cette source de backtest ne publie pas les cartons rouges.
    homeRedCards: null,
    awayRedCards: null,
    venue: null,
    referee: null,
  };
}

interface Target {
  competition: string;
  match: BacktestMatch;
}

function loadFeatures(competition: string): Map<string, XgRecord> {
  const path = featuresPath(competition, SEASON);
  if (!existsSync(path)) return new Map();
  const payload = JSON.parse(readFileSync(path, "utf8")) as { records: XgRecord[] };
  return new Map(payload.records.map((r) => [r.matchId, r]));
}

function saveFeatures(competition: string, records: Map<string, XgRecord>) {
  const path = featuresPath(competition, SEASON);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    competition,
    season: SEASON,
    source: "live-football-api",
    endpoint: "live_match_details",
    costPerMatch: 1,
    updatedAt: new Date().toISOString(),
    records: [...records.values()].sort((a, b) => a.matchId.localeCompare(b.matchId)),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

async function main() {
  if (!argFlag("--confirm")) {
    console.error("Refus d'exécuter sans --confirm : cette commande dépense des crédits.");
    console.error("Usage : npm run backtest:enrich -- --confirm");
    process.exitCode = 1;
    return;
  }

  // --- 1. Solde réel et périmètre, affichés AVANT toute dépense (§20) ---
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const spentToday = await prisma.apiCallLog.aggregate({
    _sum: { cost: true },
    where: { createdAt: { gte: startOfDay } },
  });
  const usedToday = spentToday._sum.cost ?? 0;

  const e0 = await loadCompetition("E0", [SEASON]);
  const sp1 = await loadCompetition("SP1", [SEASON]);
  const ordered = [...sp1].sort((a, b) => a.date.getTime() - b.date.getTime());
  const perMatchday = Math.max(1, Math.round(ordered.length / 38));
  const sp1Tail = ordered.slice(-(TAIL_MATCHDAYS * perMatchday));

  const targets: Target[] = [
    ...e0.map((match) => ({ competition: "E0", match })),
    ...sp1Tail.map((match) => ({ competition: "SP1", match })),
  ];

  const alreadyDone = new Map<string, Map<string, XgRecord>>();
  for (const competition of ["E0", "SP1"]) alreadyDone.set(competition, loadFeatures(competition));
  const remaining = targets.filter((t) => !alreadyDone.get(t.competition)!.has(t.match.id));

  console.log("☀️  SOLEIL — enrichissement xG (phase 11, scénario C)");
  console.log("═".repeat(78));
  console.log(`Saison              : ${SEASON}`);
  console.log(`Premier League      : ${e0.length} rencontres (saison complète)`);
  console.log(`LaLiga              : ${sp1Tail.length} rencontres (${TAIL_MATCHDAYS} dernières journées sur ${sp1.length})`);
  console.log(`Rencontres à payer  : ${remaining.length} (1 crédit chacune)`);
  console.log(`Appels de cadrage   : 2 (/league_fixtures, 1 crédit par compétition)`);
  console.log(`Coût total estimé   : ${remaining.length + 2} crédits`);
  console.log(`Déjà consommés      : ${usedToday} crédits aujourd'hui`);
  console.log(`Clé active          : clé 1 uniquement — clés 2 à 18 en réserve`);
  console.log("═".repeat(78));

  const client = new ApiFootballLiveClient(resolvePreset("live-football-api"), {
    // Plafond strict : la dépense totale de cette exécution.
    globalDailyBudget: usedToday + remaining.length + 2,
  });
  await client.init();

  const balance = (raw: unknown): number | null => {
    if (!raw || typeof raw !== "object") return null;
    const value = (raw as Record<string, unknown>).credits_remaining;
    return typeof value === "number" ? value : null;
  };

  // --- 2. Cadrage : identifiants fournisseur pour chaque rencontre ---
  const matchesByCompetition = new Map<string, { lfaId: string; target: Target }[]>();
  let creditsSpent = 0;

  for (const competition of ["E0", "SP1"]) {
    const fixtures = await getCompetitionFixtures(client, LEAGUES[competition]!, SEASON);
    creditsSpent += fixtures.creditsSpent;
    const lfaMatches: NormalizedMatch[] = fixtures.data.matches;
    console.log(
      `\n■ ${competition} — ${lfaMatches.length} rencontres côté fournisseur (${fixtures.creditsSpent} crédit · solde ${balance(fixtures.raw) ?? "?"})`,
    );

    const competitionTargets = targets.filter((t) => t.competition === competition);
    const sources = competitionTargets.map((t) => asFixture(t.match));
    const outcome = matchSources(sources, lfaMatches, competition);
    const byExternalId = new Map(competitionTargets.map((t) => [t.match.id, t]));

    const mapped: { lfaId: string; target: Target }[] = [];
    for (const canonical of outcome.matched) {
      const externalId = canonical.fdcouk?.externalId;
      if (!externalId || !canonical.lfa) continue;
      const target = byExternalId.get(externalId);
      if (!target) continue;
      mapped.push({ lfaId: canonical.lfa.providerId, target });
    }

    matchesByCompetition.set(competition, mapped);
    console.log(`   appariées avec certitude : ${mapped.length}/${competitionTargets.length}`);
    if (mapped.length < competitionTargets.length) {
      console.log(
        `   ⚠️  ${competitionTargets.length - mapped.length} rencontres sans correspondance certaine — elles resteront SANS xG (jamais fusionnées sur une ressemblance)`,
      );
    }
  }

  // --- 3. Contrôle de sûreté : le xG existe-t-il sur une saison passée ? ---
  console.log("\n" + "─".repeat(78));
  console.log(`CONTRÔLE — ${PROBE_MATCHES} rencontres de ${SEASON} avant engagement complet`);
  const probePool = matchesByCompetition.get("E0") ?? [];
  const probe = probePool.slice(0, PROBE_MATCHES);
  let probeWithXg = 0;

  for (const item of probe) {
    await sleep(CALL_DELAY_MS);
    const details = await getMatch(client, item.lfaId);
    creditsSpent += details.creditsSpent;
    const homeXg = details.data.stats.home.values.xg?.value ?? null;
    const awayXg = details.data.stats.away.values.xg?.value ?? null;
    if (homeXg !== null && awayXg !== null) probeWithXg += 1;
    console.log(
      `   ${item.target.match.homeTeamName} - ${item.target.match.awayTeamName} : xG ${homeXg ?? "absent"} / ${awayXg ?? "absent"} (solde ${balance(details.raw) ?? "?"})`,
    );
  }

  if (probeWithXg < 2) {
    console.log("\n❌ ARRÊT : le xG n'est pas publié sur l'historique. Engagement complet ANNULÉ.");
    console.log(`   Crédits dépensés pour le constat : ${creditsSpent}`);
    await prisma.$disconnect();
    return;
  }
  console.log(`\n✅ xG présent sur ${probeWithXg}/${probe.length} rencontres — engagement complet autorisé.`);

  // --- 4. Enrichissement complet, écriture incrémentale ---
  const recordsByCompetition = alreadyDone;
  let done = 0;
  let failures = 0;

  for (const competition of ["E0", "SP1"]) {
    const items = matchesByCompetition.get(competition) ?? [];
    const records = recordsByCompetition.get(competition)!;

    for (const item of items) {
      if (records.has(item.target.match.id)) continue;

      await sleep(CALL_DELAY_MS);
      try {
        const details = await getMatch(client, item.lfaId);
        creditsSpent += details.creditsSpent;
        records.set(item.target.match.id, {
          matchId: item.target.match.id,
          homeXg: details.data.stats.home.values.xg?.value ?? null,
          awayXg: details.data.stats.away.values.xg?.value ?? null,
          source: "live-football-api",
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        failures += 1;
        console.error(`   ✗ ${item.target.match.id} : ${(error as Error).message}`);
        if (failures > 10) {
          console.error("Trop d'échecs consécutifs — arrêt pour ne pas gaspiller de crédits.");
          break;
        }
        continue;
      }

      done += 1;
      if (done % 20 === 0) {
        saveFeatures(competition, records);
        const covered = [...records.values()].filter((r) => r.homeXg !== null && r.awayXg !== null).length;
        console.log(
          `   ${competition} : ${done} enrichies · ${covered} avec xG · solde ${balance(null) ?? ""}${done % 100 === 0 ? "" : ""}`,
        );
      }
    }
    saveFeatures(competition, records);
  }

  // --- 5. Bilan ---
  console.log("\n" + "═".repeat(78));
  console.log("BILAN DE L'ENRICHISSEMENT");
  for (const competition of ["E0", "SP1"]) {
    const records = recordsByCompetition.get(competition)!;
    const values = [...records.values()];
    const covered = values.filter((r) => r.homeXg !== null && r.awayXg !== null).length;
    console.log(
      `   ${competition} : ${values.length} rencontres enregistrées · ${covered} avec xG des deux côtés (${values.length ? Math.round((covered / values.length) * 100) : 0} %)`,
    );
    console.log(`        fichier : ${featuresPath(competition, SEASON)}`);
  }
  console.log(`   Crédits dépensés dans cette exécution : ${creditsSpent}`);
  console.log(`   Échecs : ${failures}`);
  console.log("   Rappel : ces données sont en cache — les relire coûtera 0 crédit.");

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("\n❌ Enrichissement interrompu :", error);
  process.exitCode = 1;
});
