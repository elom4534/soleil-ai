/**
 * ============================================================================
 * SOLEIL — SONDE FOURNISSEUR (runner générique)
 * ============================================================================
 * Objectif unique : déterminer les capacités RÉELLES de l'abonnement avec le
 * minimum de crédits consommés. La sonde :
 *
 *   · n'écrit dans AUCUNE table métier (aucune synchronisation) ;
 *   · n'émet aucun appel si le plafond de crédits est insuffisant ;
 *   · saute toute étape dont les identifiants manquent, plutôt que de dépenser
 *     un crédit pour rien ;
 *   · s'arrête immédiatement sur problème d'authentification, de quota ou de
 *     plafond ;
 *   · respecte le débit autorisé entre deux appels (pas de 429 inutile) ;
 *   · vérifie le coût réel annoncé par le fournisseur (delta de crédits).
 *
 * Chaque fournisseur apporte son « profil » (plan + lecture des réponses) :
 *   · `probe-lfa.ts`        — LiveFootballApi (fournisseur retenu)
 *   · `probe-apisports.ts`  — API-Football / API-SPORTS (conservé pour comparaison)
 *
 * Usage :
 *   npm run probe:dry                          → plan complet, aucun appel
 *   npm run probe -- --budget 25               → audit réel, plafond 25 crédits
 *   npm run probe -- --provider api-football --budget 10
 *   npm run probe -- --base-url https://… --auth header --header-name X-API-Key
 *
 * Options : --provider --budget --dry-run --base-url --auth --header-name
 *           --param-name --data-path --league --team --profile
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  ApiFootballLiveClient,
  ApiFootballLiveError,
} from "../src/server/data/providers/apiFootballLive/client";
import { readKeysFromEnv } from "../src/server/data/providers/apiFootballLive/credentials";
import { prisma } from "../src/lib/prisma";
import {
  buildCustomPreset,
  resolvePreset,
  type ProviderPreset,
} from "../src/server/data/providers/apiFootballLive/presets";
import {
  asObject,
  lastSaturday,
  nextSaturday,
  type Args,
  type ProbeContext,
  type ProbeProfile,
} from "./probe-kit";
import { LFA_PROFILE, hydrateFromEnv } from "./probe-lfa";
import { API_SPORTS_PROFILE } from "./probe-apisports";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(): Args & { profile?: string; only?: string[] } {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const provider = get("--provider") ?? "live-football-api";

  return {
    provider,
    // 25 crédits : plafond explicitement autorisé par l'utilisateur pour l'audit.
    budget: Number(get("--budget") ?? 25),
    dryRun: argv.includes("--dry-run"),
    league: Number(get("--league") ?? 39),
    team: get("--team"),
    baseUrl: get("--base-url"),
    authStyle: (get("--auth") as "header" | "query") ?? "header",
    headerName: get("--header-name"),
    queryParam: get("--param-name"),
    dataPath: (get("--data-path") ?? "response").split("."),
    profile: get("--profile"),
    only: get("--only")?.split(",").map((k) => k.trim()),
  };
}

/** Associe une empreinte fournisseur au plan de sonde correspondant. */
function pickProfile(preset: ProviderPreset, requested?: string): ProbeProfile {
  if (requested === "live-football-api" || requested === "lfa") return LFA_PROFILE;
  if (requested === "api-football" || requested === "apisports") return API_SPORTS_PROFILE;

  if (preset.id === "live-football-api" || /live-football-api\.com/.test(preset.baseUrl)) {
    return LFA_PROFILE;
  }
  return API_SPORTS_PROFILE;
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

interface StepResult {
  key: string;
  question: string;
  endpoint: string;
  params: Record<string, string | number | undefined>;
  cost: number;
  required: boolean;
  status: "success" | "empty" | "skipped" | "failed";
  creditsSpent: number;
  creditsRemaining: number | null;
  fromCache: boolean;
  itemCount: number | null;
  durationMs: number;
  error?: string;
  answers: string[];
  evidence?: Record<string, unknown>;
  raw?: unknown;
}

/** Compte les éléments utiles d'une charge déjà extraite. */
function countItems(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return data === null || data === undefined ? 0 : 1;
  const obj = asObject(data);
  const containers = [
    "matches",
    "weeks",
    "leagues",
    "h2h",
    "standings",
    "teams",
    "players",
    "squad",
    "webhooks",
    "injuries",
    "officials",
    "data",
  ];
  for (const key of containers) {
    const value = obj[key];
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") {
      const inner = asObject(value).data;
      if (Array.isArray(inner)) return inner.length;
    }
  }
  return Object.keys(obj).length > 0 ? 1 : 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs();

  const preset: ProviderPreset = args.baseUrl
    ? buildCustomPreset({
        baseUrl: args.baseUrl,
        authStyle: args.authStyle,
        authHeader: args.headerName ?? undefined,
        authParam: args.queryParam ?? undefined,
        dataPath: args.dataPath,
      })
    : resolvePreset(args.provider);

  const profile = pickProfile(preset, args.profile);
  const keys = readKeysFromEnv();

  const now = new Date();
  const ctx: ProbeContext = {
    today: now.toISOString().slice(0, 10),
    yesterday: new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10),
    lastSaturday: lastSaturday(now),
    nextSaturday: nextSaturday(now),
    league: args.league,
    season: now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1,
    slots: {},
  };
  hydrateFromEnv(ctx);

  // Un audit ciblé (--only) ne fait pas tourner les étapes qui découvrent les
  // identifiants : ils doivent alors venir de l'environnement, sans quoi toutes
  // les étapes seraient sautées faute d'identifiant.
  const missingTarget = args.only?.length
    ? ["leagueId", "africanLeagueId", "teamId"].filter((slot) => !ctx.slots[slot])
    : [];
  if (missingTarget.length > 0) {
    console.log(
      `\n⚠️  Audit ciblé : identifiant(s) à fournir via l'environnement — ${missingTarget
        .map((s) => `SOLEIL_LFA_${s.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`)
        .join(", ")}.`,
    );
  }

  console.log("☀️  SOLEIL — sonde fournisseur");
  console.log("═".repeat(74));
  console.log(`Fournisseur         : ${preset.displayName}`);
  console.log(`URL de base         : ${preset.baseUrl}`);
  console.log(
    `Authentification    : ${
      preset.authStyle === "header" ? `en-tête ${preset.authHeader}` : `paramètre ${preset.authParam}`
    }`,
  );
  console.log(`Plan de sonde       : ${profile.label}`);
  console.log(`Clés détectées      : ${keys.length}${keys.length > 1 ? " (rotation séquentielle)" : ""}`);
  console.log(`Plafond autorisé    : ${args.budget} crédits`);
  console.log(`Mode                : ${args.dryRun ? "SIMULATION — aucune requête émise" : "RÉEL — des crédits seront consommés"}`);
  console.log(`Débit imposé        : ${profile.minIntervalMs} ms entre deux appels`);
  console.log("═".repeat(74));

  const planned = args.only
    ? profile.steps.filter((step) => args.only?.includes(step.key))
    : profile.steps;

  if (planned.length === 0) {
    console.error(`\n❌ Aucune étape ne correspond à --only ${args.only?.join(",")}.`);
    console.error(`   Étapes disponibles : ${profile.steps.map((s) => s.key).join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  const totalCost = planned.reduce((sum, step) => sum + step.cost, 0);

  console.log(`\n📋 Plan : ${planned.length} étapes, ${totalCost} crédits au maximum\n`);
  for (const [index, step] of planned.entries()) {
    const skip = step.skipIf?.(ctx);
    const note = !skip
      ? ""
      : args.dryRun
        ? "  ⟳ conditionnelle — dépend d'un identifiant fourni par une étape précédente"
        : `  ⏭️  ${skip}`;
    console.log(
      `${String(index + 1).padStart(2)}. [${step.cost} crédit] /${step.endpoint}${step.required ? " (indispensable)" : ""}${note}`,
    );
    console.log(`    ${step.question}`);
  }

  if (args.dryRun) {
    console.log(`\n✅ Simulation terminée. Coût maximal de l'audit réel : ${totalCost} crédits.`);
    if (keys.length === 0) {
      console.log("\n⚠️  Aucune clé détectée. Renseignez dans .env :");
      console.log('   API_FOOTBALL_LIVE_KEYS="cle1,cle2,cle3"     (plusieurs clés)');
      console.log('   API_FOOTBALL_LIVE_KEY_1="cle1"              (numérotation libre)');
    }
    console.log("   Relancez sans --dry-run pour exécuter la sonde.");
    return;
  }

  // La journalisation des appels (ApiCallLog) et le suivi de consommation par
  // clé (ApiCredential) passent par la base : sans elle, la sonde serait
  // aveugle. On préfère un refus explicite à une erreur obscure en cours de route.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    console.error(
      "\n❌ Base de données injoignable : la sonde est refusée pour ne pas perdre la trace des crédits consommés.\n" +
        `   Cause : ${(error as Error).message.split("\n")[0]}\n` +
        "   Démarrez la base locale : bash scripts/dev-db.sh\n",
    );
    process.exitCode = 1;
    return;
  }

  if (keys.length === 0) {
    console.error(
      "\n❌ Aucune clé détectée : la sonde réelle est refusée.\n\n" +
        "Renseignez l'une des variables suivantes dans .env :\n" +
        '   API_FOOTBALL_LIVE_KEYS="cle1,cle2,cle3"     (plusieurs clés)\n' +
        '   API_FOOTBALL_LIVE_KEY_1="cle1"              (numérotation libre)\n',
    );
    process.exitCode = 1;
    return;
  }

  if (totalCost > args.budget) {
    console.error(
      `\n⛔ Refus : le plan coûte au plus ${totalCost} crédits mais le plafond est fixé à ${args.budget}.\n` +
        `   Relancez avec --budget ${totalCost} si vous acceptez cette dépense.`,
    );
    process.exitCode = 1;
    return;
  }

  // Le client porte ses propres refus (plafond, rotation, déduplication).
  const client = new ApiFootballLiveClient(preset, { globalDailyBudget: args.budget });
  await client.init();

  console.log("\n🔑 État des clés :");
  console.log(await client.credentials.report());

  const results: StepResult[] = [];
  let lastCallAt = 0;

  console.log("\n" + "─".repeat(74));
  for (const step of planned) {
    const skipReason = step.skipIf?.(ctx);
    if (skipReason) {
      results.push({
        key: step.key,
        question: step.question,
        endpoint: step.endpoint,
        params: {},
        cost: 0,
        required: step.required,
        status: "skipped",
        creditsSpent: 0,
        creditsRemaining: null,
        fromCache: false,
        itemCount: null,
        durationMs: 0,
        error: skipReason,
        answers: [`⏭️  Étape non exécutée — ${skipReason}`],
      });
      console.log(`⏭️  ${step.key} — ${skipReason}`);
      continue;
    }

    const params = step.params(ctx);

    // Respect du débit autorisé : aucun crédit gaspillé en 429.
    const waitFor = profile.minIntervalMs - (Date.now() - lastCallAt);
    if (waitFor > 0) await sleep(waitFor);

    const startedAt = Date.now();
    lastCallAt = Date.now();

    try {
      const result = await client.call(step.endpoint, {
        params,
        ttlSeconds: step.ttlSeconds ?? 3600,
        cost: step.cost,
      });

      const body = asObject(result.raw);
      const creditsRemaining =
        typeof body.credits_remaining === "number" ? body.credits_remaining : null;

      // Certains fournisseurs répondent 200 avec un échec dans le corps.
      if (body.success === false) {
        const message = String(body.message ?? "réponse en échec");
        results.push({
          key: step.key,
          question: step.question,
          endpoint: step.endpoint,
          params,
          cost: step.cost,
          required: step.required,
          status: "failed",
          creditsSpent: result.creditsSpent,
          creditsRemaining,
          fromCache: false,
          itemCount: null,
          durationMs: Date.now() - startedAt,
          error: message,
          answers: [`❌ ${message}`],
        });
        console.log(`❌ ${step.key} — ${message}`);
        if (step.required) {
          console.log("\n   ⛔ Arrêt de la sonde : les crédits restants sont préservés.");
          break;
        }
        continue;
      }

      const analysis = profile.analyse(step.key, result.raw, ctx);
      const items = countItems(result.data);
      const status: StepResult["status"] =
        items === 0 ? "empty" : items === null ? "success" : "success";

      results.push({
        key: step.key,
        question: step.question,
        endpoint: step.endpoint,
        params,
        cost: step.cost,
        required: step.required,
        status,
        creditsSpent: result.creditsSpent,
        creditsRemaining,
        fromCache: result.fromCache,
        itemCount: items,
        durationMs: Date.now() - startedAt,
        answers: analysis.answers,
        evidence: analysis.evidence,
        raw: result.raw,
      });

      profile.hydrate(step.key, result.raw, ctx);

      console.log(
        `✅ ${step.key} — ${items ?? "?"} élément(s) · ${result.creditsSpent} crédit(s) · ${
          Date.now() - startedAt
        } ms${creditsRemaining !== null ? ` · crédits restants : ${creditsRemaining}` : ""}`,
      );
      for (const answer of analysis.answers) console.log(`      ${answer}`);
    } catch (error) {
      const e = error as ApiFootballLiveError;
      const message = e?.message ?? String(error);
      results.push({
        key: step.key,
        question: step.question,
        endpoint: step.endpoint,
        params,
        cost: step.cost,
        required: step.required,
        status: "failed",
        creditsSpent: 0,
        creditsRemaining: null,
        fromCache: false,
        itemCount: null,
        durationMs: Date.now() - startedAt,
        error: message,
        answers: [`❌ ${message}`],
      });
      console.log(`❌ ${step.key} — ${message}`);

      // Inutile de continuer : soit la clé est refusée, soit le quota est
      // atteint, soit le plafond est épuisé. Continuer dépenserait à vide.
      if (step.required && ["unauthorized", "no-credentials", "budget-exceeded"].includes(e?.kind)) {
        console.log("\n   ⛔ Arrêt de la sonde : les crédits restants sont préservés.");
        break;
      }
    }
  }

  console.log("─".repeat(74));

  // --- Vérification du coût réel annoncé par le fournisseur ---
  const decoded: number[] = [];
  for (const step of results) {
    const declared = step.raw ? asObject(step.raw).credits_remaining : undefined;
    if (typeof declared === "number") decoded.push(declared);
  }
  const first = decoded[0] ?? null;
  const last = decoded[decoded.length - 1] ?? null;
  const observedDelta = first !== null && last !== null ? first - last : null;
  const callsMade = results.filter((r) => r.creditsSpent > 0 || r.creditsRemaining !== null).length;
  const expectedDelta = callsMade > 0 ? callsMade - 1 : 0;

  const spent = results.reduce((sum, r) => sum + r.creditsSpent, 0);
  console.log(`\n💳 Crédits décomptés par SOLEIL : ${spent}`);
  if (observedDelta !== null) {
    console.log(
      `💳 Crédits réellement décomptés par le fournisseur : ${observedDelta} (entre le 1er et le dernier appel, ${callsMade} appels émis).`,
    );
    console.log(
      observedDelta === expectedDelta
        ? "✅ Le coût annoncé par la documentation correspond au décompte réel."
        : `⚠️  Écart de décompte : ${observedDelta} observés pour ${expectedDelta} attendus. À vérifier avant toute synchronisation.`,
    );
  } else {
    console.log("⚠️  Aucun solde de crédits communiqué dans les réponses : coût réel non vérifiable.");
  }

  console.log(`\n🔑 État des clés après sonde :`);
  console.log(await client.credentials.report());

  // --- Rapport ---
  const report = {
    generatedAt: new Date().toISOString(),
    provider: {
      id: preset.id,
      displayName: preset.displayName,
      baseUrl: preset.baseUrl,
      authStyle: preset.authStyle,
      authHeader: preset.authHeader ?? null,
      authParam: preset.authParam ?? null,
      creditPerCall: preset.creditPerCall,
      docsUrl: preset.docsUrl ?? null,
    },
    plan: {
      label: profile.label,
      steps: planned.map((step) => ({
        key: step.key,
        endpoint: step.endpoint,
        question: step.question,
        cost: step.cost,
        required: step.required,
      })),
      maxCost: totalCost,
    },
    budget: { declared: args.budget, spentBySoleil: spent },
    creditVerification: {
      callCount: callsMade,
      firstBalance: first,
      lastBalance: last,
      observedDelta,
      expectedDelta,
      conforms: observedDelta === null ? null : observedDelta === expectedDelta,
    },
    keysDetected: keys.length,
    context: { ...ctx, slots: ctx.slots },
    steps: results.map((step) => {
      const { raw, ...rest } = step;
      void raw;
      return rest;
    }),
    rawSamples: Object.fromEntries(
      results.filter((r) => r.raw).map((r) => [r.key, truncate(r.raw, 3)]),
    ),
  };

  mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = `reports/probe-${stamp}.json`;
  const mdPath = `reports/probe-${stamp}.md`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report));

  console.log(`\n📄 Rapport lisible : ${mdPath}`);
  console.log(`📦 Données brutes  : ${jsonPath}`);
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

/** Tronque récursivement une réponse pour n'en garder qu'un échantillon. */
function truncate(node: unknown, maxItems: number, depth = 6): unknown {
  if (depth <= 0) return "…";
  if (Array.isArray(node)) return node.slice(0, maxItems).map((n) => truncate(n, maxItems, depth - 1));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, truncate(v, maxItems, depth - 1)]),
    );
  }
  return node;
}

function renderMarkdown(report: Record<string, unknown>): string {
  const provider = report.provider as Record<string, unknown>;
  const steps = report.steps as Record<string, unknown>[];
  const budget = report.budget as Record<string, unknown>;
  const verification = report.creditVerification as Record<string, unknown>;
  const context = report.context as Record<string, unknown>;

  const lines: string[] = [];
  lines.push("# Sonde fournisseur — constats bruts");
  lines.push("");
  lines.push(`**Généré le** ${new Date(String(report.generatedAt)).toLocaleString("fr-FR")}`);
  lines.push(`**Fournisseur** ${String(provider.displayName)} — \`${String(provider.baseUrl)}\``);
  lines.push(`**Coût unitaire déclaré** ${String(provider.creditPerCall)} crédit par appel`);
  lines.push(
    `**Crédits** ${String(budget.spentBySoleil)} décomptés par SOLEIL / plafond autorisé ${String(budget.declared)}`,
  );
  lines.push("");

  lines.push("## Vérification du décompte de crédits");
  lines.push("");
  if (verification.observedDelta === null) {
    lines.push("Le fournisseur ne communique aucun solde : le coût réel n'est pas vérifiable.");
  } else {
    lines.push(
      `- Solde annoncé au 1er appel : **${String(verification.firstBalance)}**`,
    );
    lines.push(`- Solde annoncé au dernier appel : **${String(verification.lastBalance)}**`);
    lines.push(`- Crédits réellement décomptés : **${String(verification.observedDelta)}**`);
    lines.push(`- Appels émis : ${String(verification.callCount)}`);
    lines.push(
      `- Concordance avec la documentation : ${
        verification.conforms === true ? "✅ conforme" : "⚠️ écart à examiner"
      }`,
    );
  }
  lines.push("");

  lines.push("## Étapes exécutées");
  lines.push("");
  lines.push("| Étape | Endpoint | Statut | Éléments | Crédits |");
  lines.push("|-------|----------|--------|---------:|--------:|");
  for (const step of steps) {
    const label =
      step.status === "success"
        ? "✅ accessible"
        : step.status === "empty"
          ? "⚠️ accessible, sans données"
          : step.status === "skipped"
            ? "⏭️ non exécutée"
            : "❌ échec";
    lines.push(
      `| \`${String(step.key)}\` | \`/${String(step.endpoint)}\` | ${label} | ${
        step.itemCount === null ? "—" : String(step.itemCount)
      } | ${String(step.creditsSpent)} |`,
    );
  }
  lines.push("");

  lines.push("## Constats étape par étape");
  lines.push("");
  for (const step of steps) {
    lines.push(`### ${String(step.key)} — \`/${String(step.endpoint)}\``);
    lines.push("");
    lines.push(`*${String(step.question)}*`);
    lines.push("");
    if (step.error) lines.push(`> ⚠️ ${String(step.error)}`);
    for (const answer of (step.answers as string[]) ?? []) lines.push(`- ${answer}`);
    lines.push("");
  }

  lines.push("## Ce qui a été sondé exactement");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(context, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(
    "Ces identifiants sont réels : ils proviennent des réponses et permettent de rejouer une vérification ciblée sans redécouverte (donc sans dépense inutile).",
  );

  return lines.join("\n");
}

main()
  .catch((error) => {
    console.error("\n❌ Sonde interrompue :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
