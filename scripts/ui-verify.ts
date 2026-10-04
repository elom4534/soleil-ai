/**
 * ============================================================================
 * SOLEIL — §17 Phase 14 : vérification « ce qui est affiché = le moteur »
 * ============================================================================
 * Récupère la fiche match réellement servie par l'application, puis vérifie
 * que chaque probabilité affichée correspond **exactement** à la valeur
 * produite par le moteur — même arrondi, aucun recalcul, aucune
 * transformation supplémentaire côté interface.
 *
 * La comparaison passe par `getMatchCenter` + `toDisplay`, c'est-à-dire
 * exactement la chaîne de fonctions qu'utilise la page `matchs/[id]`.
 *
 * Vérifie aussi l'honnêteté de l'affichage :
 *   • §7  — soit les xG du modèle, soit la phrase exacte d'indisponibilité ;
 *   • §10 — soit les marchés de mi-temps, soit l'indisponibilité déclarée ;
 *   • §12 — aucune promesse interdite sur la page.
 *
 * 🔒 Lecture seule, réseau local uniquement, aucun crédit consommé.
 *
 * Usage :
 *   npx tsx scripts/ui-verify.ts --base http://localhost:3100 --matches 4
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getMatchCenter } from "../src/server/predictions/queries";
import { toDisplay } from "../src/server/predictions/presenter";
import { pct, num } from "../src/lib/utils";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = arg("--base") ?? "http://localhost:3000";
const COUNT = Number(arg("--matches") ?? 4);

const FORBIDDEN = [
  "Prédiction garantie",
  "garantie",
  "garanti",
  "99 % sûr",
  "99% sûr",
  "IA infaillible",
  "Meilleur modèle mondial",
  "infaillible",
];

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

async function main() {
  const rows = await prisma.match.findMany({
    where: { predictions: { some: { status: { in: ["SETTLED", "PUBLISHED"] } } } },
    select: { id: true, status: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
    orderBy: { utcDate: "desc" },
    take: 200,
  });

  // On cherche trois profils : avec xG, sans xG, et rencontre terminée.
  const sample: typeof rows = [];
  const seen = new Set<string>();
  const buckets: Record<string, string[]> = { xg: [], noXg: [], finished: [] };
  for (const row of rows) {
    const data = await getMatchCenter(row.id);
    const view = toDisplay(data?.prediction ?? null);
    if (!view) continue;
    buckets[view.models.some((m) => m.name === "xg" && m.applicable) ? "xg" : "noXg"].push(row.id);
    if (row.status === "FINISHED") buckets.finished.push(row.id);
  }
  for (const key of ["xg", "noXg", "finished"]) {
    const id = buckets[key]!.find((x) => !seen.has(x));
    if (!id) continue;
    seen.add(id);
    const row = rows.find((r) => r.id === id)!;
    sample.push(row);
  }
  for (const row of rows) {
    if (sample.length >= COUNT) break;
    if (!seen.has(row.id)) {
      seen.add(row.id);
      sample.push(row);
    }
  }

  let totalChecks = 0;
  let totalFailures = 0;

  console.log(`\nSOLEIL — vérification d'affichage (${BASE})`);
  console.log(`Échantillon : ${sample.length} rencontre(s)\n`);

  for (const row of sample) {
    const data = await getMatchCenter(row.id);
    const view = toDisplay(data?.prediction ?? null);
    const title = `${row.homeTeam.name} – ${row.awayTeam.name}`;

    if (!view) {
      console.log(`  · ${title} — aucune prédiction publiée (hors périmètre)`);
      continue;
    }

    const checks: Check[] = [];
    let html = "";
    let status = 0;
    try {
      const res = await fetch(`${BASE}/matchs/${row.id}`);
      status = res.status;
      html = await res.text();
    } catch (error) {
      console.log(`  ✖ ${title} — requête impossible : ${(error as Error).message}`);
      totalFailures += 1;
      continue;
    }
    const has = (needle: string) => html.includes(needle);

    checks.push({ label: "HTTP 200", ok: status === 200, detail: `code ${status}` });

    // --- 1X2 : chaque probabilité affichée doit être la valeur du moteur ---
    // La fiche match affiche une décimale ; la carte de match affiche l'entier.
    // Les deux précisions sont acceptées, aucune autre valeur ne l'est.
    const displayed = [
      ["1", view.outcomes.home],
      ["X", view.outcomes.draw],
      ["2", view.outcomes.away],
    ] as const;
    for (const [label, value] of displayed) {
      const precise = pct(value, 1);
      const rounded = pct(value);
      const ok = has(precise) || has(rounded);
      checks.push({ label: `1X2 ${label} = ${precise}`, ok, detail: ok ? precise : `${precise} absent` });
    }
    // Somme des trois probabilités AFFICHÉES : 100 % à l'arrondi près.
    const shownSum = displayed.reduce((sum, [, v]) => sum + Number(pct(v, 1).replace("%", "")), 0);
    checks.push({
      label: `Σ 1X2 affiché = ${shownSum.toFixed(1)} %`,
      ok: Math.abs(shownSum - 100) <= 0.3,
      detail: `écart ${(shownSum - 100).toFixed(1)} pt`,
    });

    // --- Over / Under : deux lignes vérifiées au minimum ---
    for (const line of view.totalGoals.slice(0, 2)) {
      checks.push({
        label: `O/U ${line.line} — Over ${pct(line.over, 1)} / Under ${pct(line.under, 1)}`,
        ok: has(pct(line.over, 1)) && has(pct(line.under, 1)),
        detail: `${pct(line.over, 1)} · ${pct(line.under, 1)}`,
      });
    }

    // --- BTTS ---
    checks.push({
      label: `BTTS Oui = ${pct(view.btts.yes, 1)}`,
      ok: has(pct(view.btts.yes, 1)) || has(pct(view.btts.yes)),
      detail: pct(view.btts.yes, 1),
    });

    // --- Scores exacts : ≥ 5 scores et la probabilité du premier ---
    checks.push({
      label: `Score le plus probable ${view.exactScore.mostLikely.score}`,
      ok: has(view.exactScore.mostLikely.score),
      detail: view.exactScore.mostLikely.score,
    });
    checks.push({
      label: `Au moins 5 scores exacts affichés`,
      ok: view.exactScore.top.slice(0, 5).every((s) => has(s.score)),
      detail: `${view.exactScore.top.length} scores`,
    });

    // --- Buts attendus ---
    checks.push({
      label: `Buts attendus = ${num(view.expectedGoals.total)}`,
      ok: has(num(view.expectedGoals.total)),
      detail: num(view.expectedGoals.total),
    });

    // --- §7 xG : valeurs réelles OU phrase exacte d'indisponibilité ---
    const xg = view.models.find((m) => m.name === "xg");
    if (xg?.applicable && xg.expectedGoals) {
      const home = num(xg.expectedGoals.home);
      const away = num(xg.expectedGoals.away);
      checks.push({
        label: `§7 xG affichés (${home} / ${away})`,
        ok: has(home) && has(away),
        detail: `${home} · ${away}`,
      });
    } else {
      checks.push({
        label: "§7 xG indisponible — mention exacte",
        ok: has("xG indisponible pour cette rencontre"),
        detail: "« xG indisponible pour cette rencontre »",
      });
    }

    // --- §10 mi-temps : marchés réels OU indisponibilité déclarée ---
    const halfLines = view.halfTime.firstHalf.overUnder;
    const hasHalfMarkets = halfLines.length > 0 && halfLines.every((l) => has(pct(l.over, 1)));
    const hasHalfPhrase = has("Marché indisponible");
    checks.push({
      label: "§10 mi-temps — marchés ou indisponibilité déclarée",
      ok: hasHalfPhrase || hasHalfMarkets,
      detail: hasHalfPhrase ? "« Marché indisponible — données historiques insuffisantes. »" : `${halfLines.length} lignes`,
    });

    // --- §8 état des données en trois niveaux ---
    const stateLabel = has("Données complètes")
      ? "Données complètes"
      : has("Données partielles")
        ? "Données partielles"
        : has("Données insuffisantes")
          ? "Données insuffisantes"
          : null;
    checks.push({ label: "§8 état des données lisible", ok: stateLabel !== null, detail: stateLabel ?? "aucun" });

    // --- §6 mention de cohérence ---
    checks.push({
      label: "§6 contrôle de cohérence visible",
      ok: has("Cohérence des marchés vérifiée") || has("Incohérence détectée entre marchés"),
      detail: has("Cohérence des marchés vérifiée") ? "cohérence vérifiée" : "incohérence signalée",
    });

    // --- §12 aucune promesse interdite ---
    const found = FORBIDDEN.filter((f) => html.includes(f));
    checks.push({
      label: "§12 aucune promesse interdite",
      ok: found.length === 0,
      detail: found.length === 0 ? "aucune" : found.join(", "),
    });

    const failures = checks.filter((c) => !c.ok);
    totalChecks += checks.length;
    totalFailures += failures.length;

    const xgBranch =
      xg?.applicable && xg.expectedGoals
        ? `xG ${num(xg.expectedGoals.home)} / ${num(xg.expectedGoals.away)}`
        : "xG indisponible";
    const htBranch = hasHalfPhrase ? "mi-temps indisponible" : `mi-temps ${halfLines.length} lignes`;
    console.log(
      failures.length === 0
        ? `  ✔ ${title} — ${checks.length} contrôles OK (${xgBranch}, ${htBranch})`
        : `  ✖ ${title} — ${failures.length}/${checks.length} échec(s)`,
    );
    for (const f of failures) console.log(`      · ${f.label} — ${f.detail}`);
  }

  console.log(
    `\nRésultat : ${totalChecks - totalFailures} / ${totalChecks} contrôles réussis` +
      ` (${totalFailures} échec${totalFailures > 1 ? "s" : ""}).\n`,
  );

  await prisma.$disconnect();
  process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
