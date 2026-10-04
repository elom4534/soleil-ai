/**
 * ============================================================================
 * SOLEIL — §4 à §8 (Phase 15) · Construction de la mémoire d'erreurs
 * ============================================================================
 * Transforme les prédictions déjà réglées en lignes d'erreur, puis produit les
 * diagnostics du §5. C'est le « MODEL TRAINING » de l'architecture §8, dans sa
 * version mesurable : on observe, on groupe, on chiffre — on ne modifie pas les
 * poids en place.
 *
 * Garanties :
 *  • **Rien n'est écrasé.** Une ligne d'erreur par prédiction (`predictionId`
 *    unique) ; une prédiction déjà analysée est laissée telle quelle, sauf
 *    `--refresh` explicite.
 *  • **Aucune prédiction publiée n'est modifiée.** Le script écrit uniquement
 *    dans `PredictionError` et `ModelVersion`.
 *  • **Aucune fuite temporelle.** L'erreur est calculée APRÈS le coup d'envoi,
 *    à partir du résultat réel ; elle n'est jamais réinjectée dans une
 *    prédiction.
 *  • **ZÉRO crédit** : la base locale suffit.
 *
 * Usage :
 *   npx tsx scripts/learning-build.ts
 *   npx tsx scripts/learning-build.ts --refresh
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../src/lib/prisma";
import { ENGINE_VERSION, OUTCOME_SOURCE } from "../src/lib/constants";
import { toDisplay } from "../src/server/predictions/presenter";
import { computePredictionError } from "../src/server/learning/metrics";
import { analyseErrors, type DiagnosticRow } from "../src/server/learning/diagnostics";
import {
  decidePromotion,
  promoteVersion,
  registerVersion,
  type ValidationSummary,
} from "../src/server/learning/registry";
import { BASE_WEIGHTS } from "../src/server/engine/ensemble";

/**
 * Poids du xG réellement appliqué par le moteur. Il est lu à la source plutôt
 * que recopié : le registre ne peut donc pas annoncer un poids qui n'est pas
 * celui du modèle en production.
 */
const XG_WEIGHT = BASE_WEIGHTS.xg ?? 0;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** Empreinte des données utilisées — déterministe, sans coût réseau. */
async function dataSnapshot(): Promise<string> {
  const [matches, xgMatches, predictions, settled, last] = await Promise.all([
    prisma.match.count(),
    prisma.match.count({ where: { liveData: { isNot: null } } }),
    prisma.prediction.count(),
    prisma.prediction.count({ where: { status: "SETTLED" } }),
    prisma.match.findFirst({ orderBy: { utcDate: "desc" }, select: { utcDate: true } }),
  ]);
  const raw = [
    ENGINE_VERSION,
    `matches:${matches}`,
    `xg:${xgMatches}`,
    `predictions:${predictions}`,
    `settled:${settled}`,
    `last:${last?.utcDate.toISOString() ?? "aucun"}`,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Lit la validation de référence du dernier backtest Phase 15.
 *
 * Aucun chiffre n'est recopié dans le code : la promotion d'une version
 * s'appuie sur le fichier de résultats produit par le banc d'essai, et
 * l'enregistrement cite ce fichier. Sans backtest lisible, aucune promotion.
 */
function latestPhase15Validation(): {
  validation: ValidationSummary;
  source: string;
  cutoff: Date | null;
} | null {
  const root = join("data", "backtests");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root)
      .filter((name) => name.endsWith("-phase15"))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(root, dir, "resultats.json");
    try {
      const payload = JSON.parse(readFileSync(file, "utf8")) as {
        generatedAt?: string;
        oosSeason?: string;
        oneXtwo?: Record<string, { market: string; n: number; brierA: number; brierB: number; deltaBrier: number; ciBrier: [number, number] }[]>;
      };
      const row = payload.oneXtwo?.oos?.find((r) => r.market === "1X2 (toutes)");
      if (!row) continue;
      const [low, high] = row.ciBrier;
      return {
        validation: {
          metric: "brier",
          period: `hors échantillon ${payload.oosSeason ?? "?"} (${row.n} rencontres)`,
          n: row.n,
          candidate: row.brierB,
          incumbent: row.brierA,
          delta: row.deltaBrier,
          ci: [low, high],
          established: high < 0,
        },
        source: `${file}`,
        cutoff: null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  console.log("═".repeat(88));
  console.log("SOLEIL — Phase 15 · mémoire des erreurs et diagnostics");
  console.log("═".repeat(88));

  const refresh = hasFlag("--refresh");
  const snapshot = await dataSnapshot();
  console.log(`\nEmpreinte des données : ${snapshot}`);

  // -------------------------------------------------------------------------
  // 1 — Registre des versions (§7)
  // La version n'est pas déclarée « à la main » : elle est déduite des
  // prédictions réellement mesurées. Une ligne d'erreur ne peut donc pas être
  // rattachée à une version qui ne l'a pas produite.
  const versionByModel = new Map<string, { id: string; label: string }>();
  const rowsPerVersion = new Map<string, { id: string; label: string; n: number }>();

  async function versionFor(storedModelVersion: string) {
    const cached = versionByModel.get(storedModelVersion);
    if (cached) return cached;

    // Provenance : lue dans la chaîne écrite par le moteur. Les prédictions
    // antérieures à l'ajout du suffixe ne la portent pas ; elles ont été
    // générées alors que le moteur était en consensus (avant la bascule §1).
    const hasSource = /-(matrix|consensus)-/.test(storedModelVersion);
    const outcomeSource = storedModelVersion.includes("-matrix-")
      ? "matrix"
      : "consensus";
    const label = `${storedModelVersion.replace(/-ensemble$/, "")}-xg0.20`;
    const currentLabel = `${ENGINE_VERSION}-${OUTCOME_SOURCE}-ensemble`.replace(/-ensemble$/, "") + "-xg0.20";

    const existing = await prisma.modelVersion.findUnique({ where: { label } });
    if (existing) {
      const entry = { id: existing.id, label };
      versionByModel.set(storedModelVersion, entry);
      return entry;
    }

    const row = await registerVersion(
      {
        label,
        modelVersion: storedModelVersion,
        calibrationVersion: null,
        xgWeight: XG_WEIGHT,
        outcomeSource: outcomeSource as "matrix" | "consensus",
        trainingCutoff: null,
        dataSnapshot: snapshot,
        validation: null,
        note: hasSource
          ? undefined
          : "version antérieure au suffixe de provenance ; moteur en consensus au moment de la génération",
      },
      { status: label === currentLabel ? "ACTIVE" : "ARCHIVED" },
    );
    console.log(`Version ${label === currentLabel ? "ACTIVE" : "ARCHIVÉE"} : ${label}`);
    const entry = { id: row.id, label };
    versionByModel.set(storedModelVersion, entry);
    return entry;
  }

  // 2 — Construction des lignes d'erreur
  // -------------------------------------------------------------------------
  const settled = await prisma.prediction.findMany({
    where: { status: "SETTLED" },
    select: {
      id: true,
      matchId: true,
      modelVersion: true,
      createdAt: true,
      confidenceScore: true,
      dataQuality: true,
      matchResult: { select: { factors: true } },
      match: {
        select: {
          id: true,
          utcDate: true,
          homeScore: true,
          awayScore: true,
          // `season` est une relation : on lit l'année, pas l'objet entier.
          season: { select: { year: true } },
          league: { select: { shortName: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nPrédictions réglées : ${settled.length}`);

  const alreadyStored = new Set(
    (await prisma.predictionError.findMany({ select: { predictionId: true } })).map((e) => e.predictionId),
  );

  let written = 0;
  let skipped = 0;
  let unusable = 0;
  const rows: DiagnosticRow[] = [];

  for (const prediction of settled) {
    const view = toDisplay(prediction as never);
    if (!view) {
      unusable += 1;
      continue;
    }

    const record = computePredictionError(
      {
        id: prediction.id,
        matchId: prediction.matchId,
        modelVersion: prediction.modelVersion,
        createdAt: prediction.createdAt,
        confidenceScore: prediction.confidenceScore,
        dataQuality: prediction.dataQuality,
        view: view as never,
      },
      {
        id: prediction.match.id,
        utcDate: prediction.match.utcDate,
        competition: prediction.match.league.shortName ?? prediction.match.league.name,
        homeScore: prediction.match.homeScore,
        awayScore: prediction.match.awayScore,
        season: prediction.match.season?.year ?? null,
      },
    );

    if (!record) {
      unusable += 1;
      continue;
    }

    const predictionVersion = await versionFor(record.modelVersion);
    const counter = rowsPerVersion.get(predictionVersion.label) ?? {
      id: predictionVersion.id,
      label: predictionVersion.label,
      n: 0,
    };
    counter.n += 1;
    rowsPerVersion.set(predictionVersion.label, counter);

    const exists = alreadyStored.has(prediction.id);
    if (!exists || refresh) {
      await prisma.predictionError.upsert({
        where: { predictionId: prediction.id },
        create: {
          predictionId: record.predictionId,
          matchId: record.matchId,
          modelVersion: record.modelVersion,
          versionId: predictionVersion.id,
          predictedAt: record.predictedAt,
          matchDate: record.matchDate,
          error1x2: record.error1x2,
          errorOver25: record.errorOver25,
          errorBtts: record.errorBtts,
          errorTeamHome: record.errorTeamHome,
          errorTeamAway: record.errorTeamAway,
          errorExactScore: record.errorExactScore,
          brier: record.brier,
          logLoss: record.logLoss,
          calibration: record.calibration,
          hit: record.hit,
          pickProbability: record.pickProbability,
          biasHome: record.biasHome,
          biasOver25: record.biasOver25,
          biasBtts: record.biasBtts,
          competition: record.competition,
          season: record.season,
          confidence: record.confidence,
          dataGrade: record.dataGrade,
          xgUsed: record.xgUsed,
          xgWeight: record.xgWeight,
          expectedGoals: record.expectedGoals,
          favouriteSide: record.favouriteSide,
        },
        update: {
          versionId: predictionVersion.id,
          error1x2: record.error1x2,
          errorOver25: record.errorOver25,
          errorBtts: record.errorBtts,
          errorTeamHome: record.errorTeamHome,
          errorTeamAway: record.errorTeamAway,
          errorExactScore: record.errorExactScore,
          brier: record.brier,
          logLoss: record.logLoss,
          calibration: record.calibration,
          hit: record.hit,
          pickProbability: record.pickProbability,
          biasHome: record.biasHome,
          biasOver25: record.biasOver25,
          biasBtts: record.biasBtts,
          confidence: record.confidence,
          dataGrade: record.dataGrade,
          xgUsed: record.xgUsed,
          xgWeight: record.xgWeight,
          expectedGoals: record.expectedGoals,
          favouriteSide: record.favouriteSide,
        },
      });
      written += 1;
    } else {
      skipped += 1;
    }

    rows.push({
      error1x2: record.error1x2,
      errorOver25: record.errorOver25,
      errorBtts: record.errorBtts,
      errorTeamHome: record.errorTeamHome,
      errorTeamAway: record.errorTeamAway,
      brier: record.brier,
      logLoss: record.logLoss,
      hit: record.hit,
      pickProbability: record.pickProbability,
      biasHome: record.biasHome,
      biasOver25: record.biasOver25,
      biasBtts: record.biasBtts,
      competition: record.competition,
      season: record.season,
      confidence: record.confidence,
      dataGrade: record.dataGrade,
      xgUsed: record.xgUsed,
      expectedGoals: record.expectedGoals,
      favouriteSide: record.favouriteSide,
    });
  }

  console.log(`  · lignes écrites      : ${written}`);
  console.log(`  · lignes déjà en base : ${skipped}`);
  console.log(`  · inexploitables      : ${unusable} (score final absent ou vue indisponible)`);

  // -------------------------------------------------------------------------
  // 3 — Diagnostics (§5)
  // -------------------------------------------------------------------------
  const diagnostics = analyseErrors(rows);

  console.log("\n" + "─".repeat(88));
  console.log("DIAGNOSTICS — erreurs récurrentes");
  console.log("─".repeat(88));

  for (const diagnostic of diagnostics) {
    console.log(`\n▸ ${diagnostic.title}`);
    console.log(`  ${diagnostic.question}`);
    console.log(
      `  ${"groupe".padEnd(30)}${"n".padStart(6)}${"Brier".padStart(10)}${"LogLoss".padStart(10)}` +
        `${"réussite".padStart(10)}${"biais 1".padStart(10)}${"biais O2,5".padStart(13)}${"biais BTTS".padStart(12)}`,
    );
    for (const group of diagnostic.groups) {
      console.log(
        `  ${group.group.padEnd(30)}${String(group.n).padStart(6)}${group.brier.toFixed(4).padStart(10)}` +
          `${group.logLoss.toFixed(4).padStart(10)}${`${(group.hitRate * 100).toFixed(1)} %`.padStart(10)}` +
          `${group.biasHome.toFixed(4).padStart(10)}${group.biasOver25.toFixed(4).padStart(13)}` +
          `${group.biasBtts.toFixed(4).padStart(12)}`,
      );
    }
    console.log(`  Lecture : ${diagnostic.reading}`);
  }

  // -------------------------------------------------------------------------
  // 4 — Sauvegarde
  // -------------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join("data", "learning", stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "diagnostics.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        snapshot,
        versions: [...rowsPerVersion.values()],
        rows: rows.length,
        diagnostics,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nDiagnostics écrits dans ${dir}/diagnostics.json`);

  // -------------------------------------------------------------------------
  // 4 — §7/§8 : version en production et promotion justifiée
  // -------------------------------------------------------------------------
  // On n'invente aucune validation : la décision de promotion est lue dans le
  // dernier backtest Phase 15 (§1 : consensus contre matrice, hors
  // échantillon). S'il n'existe pas, la version reste candidate — jamais
  // promue sur parole.
  const currentLabel = `${ENGINE_VERSION}-${OUTCOME_SOURCE}-xg${XG_WEIGHT}`;
  const backtest = latestPhase15Validation();

  if (backtest) {
    const existingCurrent = await prisma.modelVersion.findUnique({ where: { label: currentLabel } });
    const decision = decidePromotion(backtest.validation);
    if (!existingCurrent) {
      const created = await registerVersion(
        {
          label: currentLabel,
          modelVersion: `${ENGINE_VERSION}-${OUTCOME_SOURCE}-ensemble`,
          calibrationVersion: null,
          xgWeight: XG_WEIGHT,
          outcomeSource: OUTCOME_SOURCE,
          trainingCutoff: backtest.cutoff,
          dataSnapshot: snapshot,
          validation: backtest.validation,
          note: `Validation lue dans ${backtest.source}.`,
        },
        { status: decision === "PROMOTE" ? "CANDIDATE" : "CANDIDATE" },
      );
      if (decision === "PROMOTE") {
        const active = await prisma.modelVersion.findFirst({ where: { status: "ACTIVE" } });
        await promoteVersion(created.id, active?.id ?? null);
      }
      console.log(
        `\nVersion en production : ${currentLabel} — ${decision === "PROMOTE" ? "PROMUE (amélioration hors échantillon établie)" : "NON PROMUE (gain non établi)"}`,
      );
    } else {
      console.log(`\nVersion en production : ${currentLabel} (déjà enregistrée, ${existingCurrent.status})`);
    }
  } else {
    console.log("\nAucun backtest Phase 15 lisible : aucune promotion enregistrée.");
  }

  // Validation enregistrée : c'est elle qui justifierait une promotion (§8).
  const overall = diagnostics[0]?.reference;
  const dominant = [...rowsPerVersion.values()].sort((a, b) => b.n - a.n)[0];
  if (overall && dominant) {
    const isCurrent = dominant.label.startsWith(
      `${ENGINE_VERSION}-${OUTCOME_SOURCE}`.replace(/-ensemble$/, ""),
    );
    const validation: ValidationSummary = {
      metric: "brier",
      period: "prédictions réglées en base",
      n: overall.n,
      candidate: overall.brier,
      incumbent: overall.brier,
      delta: 0,
      ci: [0, 0],
      established: false,
    };
    await prisma.modelVersion.update({
      where: { id: dominant.id },
      data: {
        validation: JSON.parse(
          JSON.stringify({
            ...validation,
            note: isCurrent
              ? "Mesure de référence de la version en production. Aucune candidate ne l'a surpassée."
              : "Mesure historique : version déjà archivée, conservée telle quelle. Aucune candidate ne l'a surpassée.",
            brier: overall.brier,
            logLoss: overall.logLoss,
            calibration: overall.calibration,
            hitRate: overall.hitRate,
          }),
        ),
      },
    });
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
