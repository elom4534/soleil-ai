/**
 * ============================================================================
 * SOLEIL — Import de l'historique football-data.co.uk (Phase 1, 2026-10-05)
 * ============================================================================
 * Bundesliga (D1), Serie A (I1), Ligue 1 (F1) — saisons 2015/2016 → 2025/2026,
 * à partir des CSV déjà présents dans data/raw/fdcouk/<code>/<CODE>.csv.
 *
 *   data/raw/fdcouk/<code>/<CODE>.csv   (téléchargés s'ils manquent — source
 *     publique et gratuite football-data.co.uk)
 *     → data/normalized/fdcouk/<CODE>/<saison>.json   (artefacts alignés E0/SP1)
 *     → ingestFixtures (pipeline idempotent existant, §4 / §34)
 *
 * 🔒 Aucune modification des modèles IA, formules ou features de prédiction.
 *    Import ADDITIF uniquement : rien n'est supprimé ni écrasé (§34 : les
 *    valeurs existantes sont complétées, jamais remplacées).
 *    Cartons rouges : colonnes CSV (HR/AR) conservées via une passe finale
 *    ciblée sur les seules rencontres importées (aucun code partagé modifié).
 *    Fautes (HF/AF) et cotes : aucune colonne dans le schéma → non importées.
 *
 * Usage : npx tsx scripts/ingest-history-fdcouk.ts [--check]
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { ingestFixtures } from "../src/server/data/ingest";
import { teamSlug } from "../src/server/data/teams";
import type { NormalizedFixture } from "../src/server/data/providers/types";

const DATA_ROOT = "data";
const PROVIDER = "football-data-co-uk";

const COMPETITIONS: { code: string; name: string; country: string }[] = [
  { code: "D1", name: "Bundesliga", country: "Germany" },
  { code: "I1", name: "Serie A", country: "Italy" },
  { code: "F1", name: "Ligue 1", country: "France" },
];

/** Fichiers football-data.co.uk : 2020/2021 est publié sous le code « 2021 ». */
const SEASON_CODES: { season: string; label: string; code: string }[] = [
  { season: "2015-2016", label: "2015/2016", code: "1516" },
  { season: "2016-2017", label: "2016/2017", code: "1617" },
  { season: "2017-2018", label: "2017/2018", code: "1718" },
  { season: "2018-2019", label: "2018/2019", code: "1819" },
  { season: "2019-2020", label: "2019/2020", code: "1920" },
  { season: "2020-2021", label: "2020/2021", code: "2021" },
  { season: "2021-2022", label: "2021/2022", code: "2122" },
  { season: "2022-2023", label: "2022/2023", code: "2223" },
  { season: "2023-2024", label: "2023/2024", code: "2324" },
  { season: "2024-2025", label: "2024/2025", code: "2425" },
  { season: "2025-2026", label: "2025/2026", code: "2526" },
];

interface LocalMatch {
  id: string;
  season: string;
  date: string;
  competition: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  homeGoals: number | null;
  awayGoals: number | null;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  homeXg: number | null;
  awayXg: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  referee: string | null;
  source: string;
}

/** Découpe une ligne CSV en gérant les champs entre guillemets. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Date football-data « jj/mm/aa(aa) » → midi UTC (convention des fichiers E0/SP1). */
function toUtcNoon(dateStr: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(dateStr.trim());
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const month = m[2].padStart(2, "0");
  const day = m[1].padStart(2, "0");
  return `${year}-${month}-${day}T12:00:00.000Z`;
}

/** Télécharge un CSV football-data.co.uk s'il est absent (gratuit, public). */
async function ensureCsv(csvPath: string, seasonCode: string, competition: string): Promise<boolean> {
  if (existsSync(csvPath)) return true;
  const url = `https://www.football-data.co.uk/mmz4281/${seasonCode}/${competition}.csv`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const body = await res.text();
    if (!body.includes("HomeTeam")) return false;
    mkdirSync(join(csvPath, ".."), { recursive: true });
    writeFileSync(csvPath, body, "utf8");
    console.log(`  ↓ CSV téléchargé : ${seasonCode}/${competition}.csv`);
    return true;
  } catch {
    return false;
  }
}

function toFixture(m: LocalMatch): NormalizedFixture {
  const meta = COMPETITIONS.find((c) => c.code === m.competition);
  const finished = m.homeGoals !== null && m.awayGoals !== null;
  return {
    externalId: m.id,
    sourceRef: m.id,
    competition: { code: m.competition, name: meta?.name ?? m.competition, country: meta?.country ?? "" },
    utcDate: new Date(m.date),
    status: finished ? "finished" : "scheduled",
    homeTeamName: m.homeTeamName,
    awayTeamName: m.awayTeamName,
    homeScore: m.homeGoals,
    awayScore: m.awayGoals,
    halfTimeHomeScore: m.halfTimeHomeGoals,
    halfTimeAwayScore: m.halfTimeAwayGoals,
    homeXg: null,
    awayXg: null,
    homeShots: m.homeShots,
    awayShots: m.awayShots,
    homeShotsOnTarget: m.homeShotsOnTarget,
    awayShotsOnTarget: m.awayShotsOnTarget,
    homeCorners: m.homeCorners,
    awayCorners: m.awayCorners,
    homeYellowCards: m.homeYellowCards,
    awayYellowCards: m.awayYellowCards,
    venue: null,
    referee: m.referee,
  };
}

function parseCsv(path: string, competition: string, seasonLabel: string): LocalMatch[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const matches: LocalMatch[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i]);
    const get = (name: string) => cols[idx(name)];
    const dateUtc = toUtcNoon(get("Date") ?? "");
    const homeName = get("HomeTeam") ?? "";
    const awayName = get("AwayTeam") ?? "";
    if (!dateUtc || !homeName || !awayName) continue;

    const homeGoals = num(get("FTHG"));
    const awayGoals = num(get("FTAG"));
    const homeId = `fdcouk:team:${teamSlug(homeName)}`;
    const awayId = `fdcouk:team:${teamSlug(awayName)}`;
    const day = dateUtc.slice(0, 10);

    matches.push({
      id: `fdcouk:${competition}:${seasonLabel}:${day}:${homeId}-${awayId}`,
      season: seasonLabel,
      date: dateUtc,
      competition,
      homeTeamId: homeId,
      homeTeamName: homeName,
      awayTeamId: awayId,
      awayTeamName: awayName,
      homeGoals,
      awayGoals,
      halfTimeHomeGoals: num(get("HTHG")),
      halfTimeAwayGoals: num(get("HTAG")),
      homeXg: null,
      awayXg: null,
      homeShots: num(get("HS")),
      awayShots: num(get("AS")),
      homeShotsOnTarget: num(get("HST")),
      awayShotsOnTarget: num(get("AST")),
      homeCorners: num(get("HC")),
      awayCorners: num(get("AC")),
      homeYellowCards: num(get("HY")),
      awayYellowCards: num(get("AY")),
      homeRedCards: num(get("HR")),
      awayRedCards: num(get("AR")),
      referee: get("Referee") || null,
      source: "football-data.co.uk",
    });
  }
  return matches;
}

async function main() {
  const check = process.argv.includes("--check");

  console.log("═".repeat(78));
  console.log("SOLEIL — HISTORIQUE football-data.co.uk : D1 · I1 · F1 (additif, idempotent)");
  console.log("═".repeat(78));

  let totalReceived = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalMerged = 0;
  let totalTeams = 0;
  const redFixtures: LocalMatch[] = [];

  for (const comp of COMPETITIONS) {
    for (const s of SEASON_CODES) {
      const csvPath = join(DATA_ROOT, "raw", "fdcouk", s.code, `${comp.code}.csv`);
      if (!(await ensureCsv(csvPath, s.code, comp.code))) {
        console.log(`  ${comp.code} ${s.season} : CSV indisponible (${csvPath}) — ignoré`);
        continue;
      }
      const matches = parseCsv(csvPath, comp.code, s.label);
      if (matches.length === 0) {
        console.log(`  ${comp.code} ${s.season} : aucune rencontre lisible — ignoré`);
        continue;
      }

      // Artefact normalisé aligné sur ceux de E0/SP1.
      const outDir = join(DATA_ROOT, "normalized", "fdcouk", comp.code);
      if (!check) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, `${s.season}.json`),
          JSON.stringify({ competition: comp.code, season: s.label, matches }, null, 1),
          "utf8",
        );
      }

      if (check) {
        totalReceived += matches.length;
        console.log(`  [lecture] ${comp.code} ${s.season} : ${matches.length} rencontres`);
        continue;
      }

      const stats = await ingestFixtures({
        provider: PROVIDER,
        competitionCode: comp.code,
        season: s.season,
        fixtures: matches.map(toFixture),
      });

      for (const m of matches) {
        if (m.homeRedCards !== null || m.awayRedCards !== null) redFixtures.push(m);
      }

      totalReceived += stats.received;
      totalInserted += stats.inserted;
      totalUpdated += stats.updated;
      totalMerged += stats.duplicatesMerged;
      totalTeams += stats.teamsCreated;
      console.log(
        `  ${comp.code} ${s.season} · reçues ${String(stats.received).padStart(4)} · ` +
          `insérées ${String(stats.inserted).padStart(4)} · màj ${String(stats.updated).padStart(4)} · ` +
          `fusion doublons ${stats.duplicatesMerged} · équipes +${stats.teamsCreated}` +
          (stats.errors.length > 0 ? ` · ⚠ ${stats.errors.length} avertissement(s)` : ""),
      );
    }
  }

  if (check) {
    console.log(`\nTotal lisible : ${totalReceived} rencontres. Aucune écriture effectuée.`);
    await prisma.$disconnect();
    return;
  }

  // ---------------------------------------------------------------------
  // Cartons rouges : passe finale CIBLÉE sur les seules rencontres de cet
  // import (aucune modification du pipeline partagé). §34 : on ne remplit
  // que les cases vides.
  // ---------------------------------------------------------------------
  let redFilled = 0;
  for (const m of redFixtures) {
    const match = await prisma.match.findUnique({ where: { externalId: m.id } });
    if (!match) continue;
    const current = await prisma.matchLiveData.findUnique({ where: { matchId: match.id } });
    const patch: { homeRedCards?: number; awayRedCards?: number } = {};
    if (m.homeRedCards !== null && current?.homeRedCards == null) patch.homeRedCards = m.homeRedCards;
    if (m.awayRedCards !== null && current?.awayRedCards == null) patch.awayRedCards = m.awayRedCards;
    if (Object.keys(patch).length === 0) continue;
    if (current) {
      await prisma.matchLiveData.update({ where: { matchId: match.id }, data: patch });
    } else {
      await prisma.matchLiveData.create({ data: { matchId: match.id, ...patch } });
    }
    redFilled += 1;
  }

  console.log("");
  console.log("─".repeat(78));
  console.log(`Rencontres lues      : ${totalReceived}`);
  console.log(`  insérées           : ${totalInserted}`);
  console.log(`  mises à jour       : ${totalUpdated} (dont ${totalMerged} fusions de doublons)`);
  console.log(`  équipes créées     : ${totalTeams}`);
  console.log(`  cartons rouges     : ${redFilled} rencontres complétées`);
  console.log("─".repeat(78));
  console.log("🔒 Import additif. Rien de supprimé, rien d'écrasé (§34).");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
