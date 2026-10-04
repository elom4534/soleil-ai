#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * SOLEIL — Phase 16 · §5 et §33 · Alimentation d'une journée (appel encadré)
 * ============================================================================
 * Ce script est le **seul** endroit du projet qui demande un crédit pour
 * obtenir un calendrier. Il est donc bâti autour d'un principe : annoncer avant
 * de dépenser, et refuser de dépenser sans confirmation chiffrée.
 *
 * Déroulé :
 *
 *   1. **Annonce** — endpoint, nombre d'appels, coût, clé, données attendues,
 *      raison. Rien n'est émis à ce stade.
 *   2. **Confirmation** — `--confirm-cost <n>` doit correspondre exactement au
 *      coût annoncé. Un chiffre différent arrête tout (§34).
 *   3. **Appel unique** — plafond dur à 1 crédit, journalisé.
 *   4. **Identification** — les compétitions reçues sont listées avec leur
 *      identifiant fournisseur ; E0/SP1 sont reconnus par nom **et** pays, et
 *      l'identifiant retenu est écrit dans `.env` (`LFA_LEAGUE_MAP`).
 *   5. **Ingestion hors ligne** — immédiatement après, la même donnée est lue
 *      depuis le cache : normalisation, déduplication, persistance,
 *      identités/logos, prédictions. Coût : 0 crédit supplémentaire.
 *
 * Usage :
 *   npx tsx scripts/ingest-upcoming.ts --date 2026-10-03                 # annonce seule
 *   npx tsx scripts/ingest-upcoming.ts --date 2026-10-03 --confirm-cost 1 # exécute
 *   npx tsx scripts/ingest-upcoming.ts --date 2026-10-03 --cache-only     # relit, 0 crédit
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { ApiFootballLiveClient } from "../src/server/data/providers/apiFootballLive/client";
import { getMatches } from "../src/server/data/providers/apiFootballLive/adapter";
import { resolvePreset, PROVIDER_PRESETS } from "../src/server/data/providers/apiFootballLive/presets";
import { runUpcomingPipeline } from "../src/server/data/upcoming-pipeline";
import { networkAllowed, networkRefusalReason } from "../src/server/schedule/jobs";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};

/** §1 — coût unitaire d'un appel `/matches` selon la documentation du fournisseur. */
const CREDIT_PER_CALL = 1;
const PROVIDER = "live-football-api";

/** Compétitions visées, avec leur identité attendue (nom **et** pays). */
const TARGETS = [
  { code: "E0", country: "england", names: ["premier league"], label: "Premier League (Angleterre)" },
  { code: "SP1", country: "spain", names: ["laliga", "la liga", "laliga ea sports", "primera division"], label: "LaLiga (Espagne)" },
];

function log(line = ""): void {
  console.log(line);
}

function header(title: string): void {
  log(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  const date = valueOf("--date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    log("Usage : npx tsx scripts/ingest-upcoming.ts --date AAAA-MM-JJ [--confirm-cost N] [--cache-only]");
    process.exitCode = 1;
    return;
  }

  const cacheOnly = has("--cache-only");
  const confirmed = valueOf("--confirm-cost");

  // §34 / décision utilisateur « clé 1 uniquement » : le portefeuille de clés
  // est restreint en mémoire à la seule clé 1. Aucune autre clé ne peut donc
  // être sollicitée, même si la première est refusée — le script s'arrête et
  // le rapporte au lieu de continuer sur une clé non autorisée.
  const keyCount = restrictPoolToFirstKey();
  log(`\n  Portefeuille restreint pour cette exécution : ${keyCount} clé(s) active(s) — aucune rotation possible.`);

  /* ------------------------------------------------------------------ */
  /* 1 — Annonce (§5) : rien n'est émis tant que le coût n'est pas validé */
  /* ------------------------------------------------------------------ */
  header("ANNONCE — aucune requête n'est émise à ce stade");
  log(`  ENDPOINT        GET https://live-football-api.com/api/v1/matches?date=${date}&lang=en`);
  log(`  NOMBRE D'APPELS 1`);
  log(`  COÛT ESTIMÉ     ${CREDIT_PER_CALL} crédit (coût unitaire du fournisseur : 1 crédit/appel)`);
  log(`  CLÉ UTILISÉE    une seule clé par exécution — la première de API_FOOTBALL_LIVE_KEYS (plafond dur : ${CREDIT_PER_CALL} crédit)`);
  log(`  DONNÉES         calendrier du ${date} : identifiants, équipes, logos, compétition, coup d'envoi, statut`);
  log(`  RAISON          alimenter la base en rencontres à venir (E0, SP1) afin de produire des prédictions affichables`);
  log(`  SUITE           identification des identifiants E0/SP1, puis ingestion hors ligne (0 crédit)`);
  log(`  SÉCURITÉ        réseau ordonnanceur : ${networkAllowed() ? "ouvert" : `fermé (${networkRefusalReason()})`}`);

  if (cacheOnly) {
    log("\n→ Mode cache uniquement : aucun appel ne sera émis.");
    await ingestOffline(date);
    return;
  }

  if (confirmed === null) {
    log(`\n→ Rien n'a été émis. Pour exécuter : --confirm-cost ${CREDIT_PER_CALL}`);
    return;
  }

  if (Number(confirmed) !== CREDIT_PER_CALL) {
    log(
      `\n✖ Coût confirmé (${confirmed}) différent du coût annoncé (${CREDIT_PER_CALL}). ` +
        `Aucune requête émise (§34).`,
    );
    process.exitCode = 1;
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 3 — Appel unique                                                     */
  /* ------------------------------------------------------------------ */
  header("APPEL — un seul, plafonné");
  const client = new ApiFootballLiveClient(resolvePreset(PROVIDER), { globalDailyBudget: CREDIT_PER_CALL });

  if (!Object.keys(PROVIDER_PRESETS).includes(PROVIDER)) {
    log(`⚠ Preset « ${PROVIDER} » absent de la liste connue : vérifiez presets.ts.`);
  }

  await client.init();

  const startedAt = Date.now();
  const result = await getMatches(client, date);
  const elapsed = Date.now() - startedAt;

  log(`  statut HTTP     ${result.statusCode}`);
  log(`  durée           ${elapsed} ms`);
  log(`  crédits         ${result.creditsSpent} (depuis cache : ${result.fromCache ? "oui" : "non"})`);
  const balance = readBalance(result.raw);
  if (balance !== null) log(`  solde annoncé   ${balance} crédits`);

  const matches = result.data;
  log(`  rencontres      ${matches.length} reçues (toutes compétitions)`);

  /* ------------------------------------------------------------------ */
  /* 4 — Identification des compétitions visées                           */
  /* ------------------------------------------------------------------ */
  header("IDENTIFICATION DES COMPÉTITIONS");
  const byLeague = new Map<string, { id: string; name: string; country: string; count: number; scheduled: number }>();
  for (const match of matches) {
    const id = match.competition.providerId;
    if (!id) continue;
    const entry = byLeague.get(id) ?? {
      id,
      name: match.competition.name,
      country: match.competition.country ?? "",
      count: 0,
      scheduled: 0,
    };
    entry.count += 1;
    if (match.status === "scheduled") entry.scheduled += 1;
    byLeague.set(id, entry);
  }

  const sorted = [...byLeague.values()].sort((a, b) => a.name.localeCompare(b.name));
  log(`${sorted.length} compétition(s) reçue(s). Les 15 plus représentées :`);
  for (const league of [...sorted].sort((a, b) => b.count - a.count).slice(0, 15)) {
    log(`   · ${league.name} (${league.country || "—"}) — ${league.count} rencontre(s) · id=${league.id}`);
  }

  const resolved: Record<string, string> = {};
  for (const target of TARGETS) {
    const found = sorted.find(
      (league) =>
        league.country.toLowerCase().includes(target.country) &&
        target.names.includes(league.name.trim().toLowerCase()),
    );
    if (found) resolved[target.code] = found.id;
    log(
      `   ${resolved[target.code] ? "✔" : "✖"} ${target.label} → ` +
        (resolved[target.code] ? `id=${resolved[target.code]} · ${found!.count} rencontre(s)` : "non reconnue dans la réponse"),
    );
  }

  if (Object.keys(resolved).length > 0) {
    const map = Object.entries(resolved).map(([code, id]) => `${code}=${id}`).join(",");
    const existing = readEnv("LFA_LEAGUE_MAP");
    if (existing === map) {
      log(`\n   LFA_LEAGUE_MAP déjà à jour : ${map}`);
    } else {
      writeEnv("LFA_LEAGUE_MAP", map);
      log(`\n   LFA_LEAGUE_MAP écrit dans .env : ${map}`);
    }
    // La variable est utilisée dès maintenant par le reste du script.
    process.env.LFA_LEAGUE_MAP = map;
  } else {
    log("\n   Aucune compétition reconnue : la carte n'est pas modifiée, l'ingestion est reportée.");
    await reportCall();
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 5 — Ingestion hors ligne                                             */
  /* ------------------------------------------------------------------ */
  await ingestOffline(date);
  await reportCall();
}

/** Ingestion depuis le cache (0 crédit) — la donnée vient d'être payée. */
async function ingestOffline(date: string): Promise<void> {
  if (!process.env.LFA_LEAGUE_MAP && !readEnv("LFA_LEAGUE_MAP")) {
    log("\n✖ LFA_LEAGUE_MAP absente : impossible de filtrer les compétitions. Rien n'est ingéré.");
    process.exitCode = 1;
    return;
  }

  header("INGESTION (hors ligne — 0 crédit)");
  const report = await runUpcomingPipeline({
    dates: [date],
    competitionCodes: ["E0", "SP1"],
    allowNetwork: false,
    predict: true,
    log: (line) => log(`   ${line}`),
  });

  for (const day of report.days) {
    for (const error of day.errors) log(`   ⚠ ${error}`);
    for (const note of day.notes.slice(0, 10)) log(`   · ${note}`);
  }

  log("");
  log(`  crédits consommés par l'ingestion : ${report.totals.creditsSpent}`);
  log(`  rencontres créées : ${report.totals.inserted} · mises à jour : ${report.totals.updated}`);
  log(
    `  équipes : ${report.totals.teamsMatched} reconnue(s) dans l'historique, ` +
      `${report.totals.teamsCreated} créée(s), ${report.totals.teamsEnriched} enrichie(s) · logos mis en cache : ${report.totals.logosCached}`,
  );
  log(
    `  prédictions : ${report.totals.predictionsGenerated} générée(s), ${report.totals.predictionsPublished} publiée(s), ` +
      `${report.totals.predictionsWithheld} retenue(s), ${report.totals.predictionsSkipped} impossible(s), ` +
      `${report.totals.predictionsAlreadyCurrent} déjà à jour`,
  );
}

async function reportCall(): Promise<void> {
  header("JOURNAL DE L'APPEL");
  const calls = await prisma.apiCallLog.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  const labels = new Map(
    (await prisma.apiCredential.findMany({ select: { id: true, label: true } })).map((row) => [row.id, row.label]),
  );
  for (const call of calls) {
    log(
      `   ${call.createdAt.toISOString()} ${call.provider}/${call.endpoint} · clé ${labels.get(call.credentialId ?? "") ?? "?"} · ` +
        `coût ${call.cost} · HTTP ${call.statusCode ?? "—"} · cache ${call.fromCache ? "oui" : "non"} · solde après ${call.quotaAfter ?? "?"}`,
    );
  }
  const credentials = await prisma.apiCredential.findMany({
    select: { label: true, isActive: true, usedToday: true, usedTotal: true, dailyRemaining: true, lastUsedAt: true },
    orderBy: { label: "asc" },
  });
  log("");
  for (const credential of credentials) {
    if (!credential.usedTotal) continue;
    log(
      `   ${credential.label ?? "(sans étiquette)"} : ${credential.usedToday} aujourd'hui · ${credential.usedTotal} au total · ` +
        `solde annoncé ${credential.dailyRemaining ?? "?"} · dernier usage ${credential.lastUsedAt?.toISOString() ?? "—"}`,
    );
  }
}

/**
 * Restreint `API_FOOTBALL_LIVE_KEYS` à sa première entrée, pour cette
 * exécution seulement. Le fichier `.env` n'est pas modifié : la restriction
 * disparaît à la fin du processus.
 */
function restrictPoolToFirstKey(): number {
  const raw = process.env.API_FOOTBALL_LIVE_KEYS ?? "";
  const keys = raw.split(/[,\n;]+/).map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) return 0;
  process.env.API_FOOTBALL_LIVE_KEYS = keys[0];
  return 1;
}

/** Solde de crédits annoncé dans l'enveloppe de réponse. */
function readBalance(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as { credits_remaining?: unknown }).credits_remaining;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readEnv(key: string): string | null {
  try {
    const content = readFileSync(".env", "utf8");
    const line = content.split("\n").find((row) => row.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, "") : null;
  } catch {
    return null;
  }
}

/** Écrit (ou remplace) une variable dans `.env`, sans toucher au reste. */
function writeEnv(key: string, value: string): void {
  const content = readFileSync(".env", "utf8");
  const lines = content.split("\n");
  const index = lines.findIndex((row) => row.startsWith(`${key}=`));
  const entry = `${key}="${value}"`;
  if (index >= 0) lines[index] = entry;
  else lines.push(entry);
  writeFileSync(".env", lines.join("\n"));
}

main()
  .catch((error) => {
    console.error(`\n✖ ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
