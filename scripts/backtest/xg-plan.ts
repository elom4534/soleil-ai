/**
 * ============================================================================
 * SOLEIL — PHASE 11 · Chiffrage de l'enrichissement xG
 * ============================================================================
 * §20 — « Avant chaque nouvelle série d'appels : afficher le coût estimé et
 * les crédits restants. »
 *
 * Le xG n'existe que chez LiveFootballApi, à 1 crédit par rencontre. Ce script
 * ne dépense RIEN : il lit les datasets déjà sur disque, simule chaque scénario
 * d'enrichissement et affiche :
 *   · le nombre exact de crédits nécessaires ;
 *   · le nombre exact de rencontres de test réellement exploitables ;
 *   · les crédits restants sur la clé 1 et la marge qui reste.
 *
 * Usage : npm run backtest:plan
 */

import "dotenv/config";

import { COMPETITIONS, loadCompetition, type BacktestMatch } from "./dataset";
import { teamHistory } from "./context";

/** Solde relevé sur la réponse du fournisseur (0 crédit dépensé pour le lire). */
const KNOWN_BALANCE = 464;

const SEASONS = [
  "2022/2023", "2023/2024", "2024/2025", "2025/2026",
];

interface Design {
  id: string;
  label: string;
  /** Matchs à enrichir : (compétition, saison) ou (compétition, saison, N dernières journées). */
  enrich: { competition: string; season: string; tailMatchdays?: number }[];
  /** Saisons évaluées ensuite. */
  testSeasons: string[];
  note: string;
}

const DESIGNS: Design[] = [
  {
    id: "P1",
    label: "Premier League seule — 2024/2025 enrichie",
    enrich: [{ competition: "E0", season: "2024/2025" }],
    testSeasons: ["2025/2026"],
    note: "Une seule compétition : le gain ne peut pas être vérifié sur un second championnat.",
  },
  {
    id: "P2",
    label: "Premier League + LaLiga — 2024/2025 enrichies",
    enrich: [
      { competition: "E0", season: "2024/2025" },
      { competition: "SP1", season: "2024/2025" },
    ],
    testSeasons: ["2025/2026"],
    note: "Protocole complet : deux championnats, fenêtres pleines (jusqu'à 38 matchs).",
  },
  {
    id: "P3",
    label: "Premier League complète + LaLiga (8 dernières journées)",
    enrich: [
      { competition: "E0", season: "2024/2025" },
      { competition: "SP1", season: "2024/2025", tailMatchdays: 8 },
    ],
    testSeasons: ["2025/2026"],
    note: "Deuxième championnat partiel : fenêtres courtes (≈8 matchs) sur LaLiga.",
  },
  {
    id: "P4",
    label: "Premier League — deux saisons (2023/2024 + 2024/2025)",
    enrich: [
      { competition: "E0", season: "2023/2024" },
      { competition: "E0", season: "2024/2025" },
    ],
    testSeasons: ["2025/2026"],
    note: "Test de stabilité temporelle sur un championnat unique, historique plus profond.",
  },
];

function matchdays(season: string): number {
  void season;
  return 38;
}

/** Rencontres enrichies par un scénario (identifiants distincts). */
function enrichmentSet(design: Design, data: Map<string, BacktestMatch[]>): Set<string> {
  const set = new Set<string>();
  for (const item of design.enrich) {
    const matches = data.get(item.competition) ?? [];
    const inSeason = matches
      .filter((m) => m.season === item.season)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    if (inSeason.length === 0) continue;

    if (item.tailMatchdays === undefined) {
      for (const m of inSeason) set.add(m.id);
    } else {
      // Rang de la rencontre dans la saison, puis on garde la fin.
      const perMatchday = Math.max(1, Math.round(inSeason.length / matchdays(item.season)));
      const keep = item.tailMatchdays * perMatchday;
      for (const m of inSeason.slice(-keep)) set.add(m.id);
    }
  }
  return set;
}

/**
 * Rencontres de test exploitables : celles dont les DEUX équipes disposent
 * d'assez de rencontres antérieures déjà enrichies en xG.
 */
function evaluate(
  design: Design,
  data: Map<string, BacktestMatch[]>,
  enriched: Set<string>,
): { competition: string; matches: number; at3: number; at10: number; at20: number }[] {
  const out: { competition: string; matches: number; at3: number; at10: number; at20: number }[] = [];

  for (const competition of new Set(design.enrich.map((e) => e.competition))) {
    const all = data.get(competition) ?? [];
    const tests = all.filter((m) => design.testSeasons.includes(m.season));
    const counts = { matches: tests.length, at3: 0, at10: 0, at20: 0 };

    for (const match of tests) {
      const xgCount = (teamId: string) =>
        teamHistory(all, teamId, match.date, 40).filter((m) => enriched.has(m.id)).length;
      const minimum = Math.min(xgCount(match.homeTeamId), xgCount(match.awayTeamId));
      if (minimum >= 3) counts.at3 += 1;
      if (minimum >= 10) counts.at10 += 1;
      if (minimum >= 20) counts.at20 += 1;
    }
    out.push({ competition, ...counts });
  }
  return out;
}

async function main() {
  const competitions = Object.keys(COMPETITIONS);
  const data = new Map<string, BacktestMatch[]>();

  console.log("☀️  SOLEIL — chiffrage de l'enrichissement xG (aucun crédit dépensé)");
  console.log("═".repeat(78));
  console.log(`Solde clé 1 : ${KNOWN_BALANCE} crédits · clé 1 uniquement (clés 2 à 18 en réserve)`);
  console.log(`Coût unitaire : 1 crédit par rencontre (/live_match_details)`);
  console.log("═".repeat(78));

  for (const competition of competitions) {
    const matches = await loadCompetition(competition, SEASONS);
    data.set(competition, matches);
    console.log(`   ${competition} : ${matches.length} rencontres (${SEASONS[0]} → ${SEASONS.at(-1)})`);
  }

  for (const design of DESIGNS) {
    const enriched = enrichmentSet(design, data);
    const credits = enriched.size;
    const remaining = KNOWN_BALANCE - credits;
    const evaluation = evaluate(design, data, enriched);

    console.log("\n" + "─".repeat(78));
    console.log(`■ ${design.id} — ${design.label}`);
    console.log(`   Coût estimé     : ${credits} crédits`);
    console.log(
      `   Après dépense   : ${remaining >= 0 ? `${remaining} crédits restants` : `DÉPASSEMENT de ${-remaining} crédits`}`,
    );
    for (const row of evaluation) {
      console.log(
        `   ${row.competition} — ${row.matches} rencontres de test · exploitables : ${row.at3} (fenêtre ≥3), ${row.at10} (≥10), ${row.at20} (≥20)`,
      );
    }
    console.log(`   Note            : ${design.note}`);
  }

  console.log("\n" + "═".repeat(78));
  console.log("Rappel : chaque scénario est rejouable depuis le cache une fois payé.");
}

main().catch((error) => {
  console.error("❌ Chiffrage interrompu :", error);
  process.exitCode = 1;
});
