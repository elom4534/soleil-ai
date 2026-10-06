/**
 * ============================================================================
 * SOLEIL AI — Boîte à outils du LLM (tool calling)
 * ============================================================================
 * Chaque outil est déclaré en JSON Schema (standard OpenAI-compatible) et
 * exécuté côté serveur vers `tools.ts` (lecture seule) ou `websearch.ts`.
 *
 * 🔒 SÉCURITÉ — le LLM ne dispose d'aucun outil d'écriture : impossible de
 *    modifier la base, une prédiction, le code ou un secret. Les résultats
 *    sont bornés en taille (MAX_OUTPUT) et ne contiennent jamais d'environ.
 */

import {
  findTeam,
  findMatchBetween,
  getMatchById,
  upcomingMatches,
  teamForm,
  homeAwaySplit,
  headToHead,
  matchStats,
  teamAverages,
  competitionInfo,
  predictionInfo,
  predictionContext,
} from "./tools";
import { webSearch } from "./websearch";

const MAX_OUTPUT = 2_400;

export interface ToolContext {
  /** Recherches web déjà consommées sur la question (borne posée par l'agent). */
  webUsed: number;
  maxWeb: number;
}

const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…(tronqué)" : s);

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "search_team",
      description: "Cherche une équipe dans la base interne (nom français ou anglais) et renvoie son identifiant.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Nom de l'équipe (ex: 'Arsenal', 'Angleterre', 'Kazakhstan')" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_upcoming_match",
      description: "Trouve le prochain match à venir entre deux équipes (statut SCHEDULED), avec identifiants, date, compétition.",
      parameters: {
        type: "object",
        properties: {
          team_a: { type: "string", description: "Nom de la première équipe" },
          team_b: { type: "string", description: "Nom de la deuxième équipe" },
        },
        required: ["team_a", "team_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar",
      description: "Liste les prochains matchs à venir (toutes compétitions), du plus proche au plus lointain.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Nombre de matchs (défaut 10, max 30)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_form",
      description: "Forme récente d'une équipe : les N derniers matchs TERMINÉS (bilan V-N-D, buts, xG, série de résultats).",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "Nom de l'équipe" },
          last_matches: { type: "number", description: "Nombre de matchs (défaut 8, max 20)" },
        },
        required: ["team"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "home_away_split",
      description: "Répartition domicile/extérieur d'une équipe (bilans et buts séparés).",
      parameters: {
        type: "object",
        properties: { team: { type: "string", description: "Nom de l'équipe" } },
        required: ["team"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "head_to_head",
      description: "Historique des confrontations directes entre deux équipes (matchs terminés).",
      parameters: {
        type: "object",
        properties: {
          team_a: { type: "string" },
          team_b: { type: "string" },
          last_matches: { type: "number", description: "Défaut 6, max 15" },
        },
        required: ["team_a", "team_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "match_stats",
      description: "Statistiques détaillées d'un match TERMINÉ (xG, tirs, tirs cadrés, corners, cartons, possession) — passe un matchId ou les deux noms d'équipes.",
      parameters: {
        type: "object",
        properties: {
          match_id: { type: "string", description: "Identifiant interne du match (si connu)" },
          team_a: { type: "string" },
          team_b: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_averages",
      description: "Moyennes sur 12 mois d'une équipe : tirs, tirs cadrés, corners, cartons, xG par match.",
      parameters: {
        type: "object",
        properties: { team: { type: "string" } },
        required: ["team"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "competition_info",
      description: "Informations sur une compétition : nom, nombre de matchs joués/à venir, saisons disponibles.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Nom ou code de la compétition (ex: 'UNL', 'Premier League', 'CONCACAF')" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prediction",
      description: "Résultat du MOTEUR de prédiction pour un match (probabilités, confiance, qualité, version) — passe match_id ou les deux équipes.",
      parameters: {
        type: "object",
        properties: {
          match_id: { type: "string" },
          team_a: { type: "string" },
          team_b: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prediction_context",
      description: "Contexte réellement exploitable d'une prédiction : combien de matchs chaque équipe avait AVANT la date du match, référence de compétition.",
      parameters: {
        type: "object",
        properties: {
          match_id: { type: "string" },
          team_a: { type: "string" },
          team_b: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Recherche Internet (actualités, blessures, compositions, entraîneur). À utiliser UNIQUEMENT quand la base interne ne suffit pas ou qu'une information actuelle est nécessaire. Toute information trouvée doit être citée avec son URL et marquée [WEB].",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Requête de recherche, en anglais de préférence" } },
        required: ["query"],
      },
    },
  },
] as const;

async function resolveId(name: string): Promise<{ id: string; name: string } | { error: string }> {
  const hit = await findTeam(name);
  if (hit && "id" in hit) return { id: hit.id, name: hit.name };
  return { error: `Équipe « ${name} » introuvable en base.` };
}

async function resolveMatch(args: Record<string, unknown>) {
  const mid = typeof args.match_id === "string" ? args.match_id : null;
  if (mid) return getMatchById(mid);
  const a = typeof args.team_a === "string" ? args.team_a : null;
  const b = typeof args.team_b === "string" ? args.team_b : null;
  if (!a || !b) return null;
  const ta = await resolveId(a);
  const tb = await resolveId(b);
  if ("error" in ta || "error" in tb) return null;
  return (await findMatchBetween(ta.id, tb.id, true)) ?? (await findMatchBetween(ta.id, tb.id, false));
}

/** Exécute un outil appelé par le LLM. Toujours en lecture, jamais d'écriture. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    switch (name) {
      case "search_team": {
        const hit = await findTeam(String(args.name ?? ""));
        if (!hit) return clip(`Équipe « ${args.name} » introuvable en base.`);
        if ("id" in hit) return clip(`Équipe trouvée : ${hit.name} (id: ${hit.id}).`);
        return clip("Plusieurs équipes correspondent : " + hit.ambiguous.map((t) => t.name).join(", ") + ". Précisez.");
      }
      case "find_upcoming_match": {
        const ta = await resolveId(String(args.team_a ?? ""));
        if ("error" in ta) return clip(ta.error);
        const tb = await resolveId(String(args.team_b ?? ""));
        if ("error" in tb) return clip(tb.error);
        const m = await findMatchBetween(ta.id, tb.id, true);
        if (!m) return clip(`Aucun match à venir entre ${ta.name} et ${tb.name}.`);
        return clip(
          `Match : ${m.homeTeam.name} – ${m.awayTeam.name} · ${m.utcDate.toISOString()} · ${m.league.name} (${m.season?.year ?? "?"}) · id: ${m.id} · statut: ${m.status}`,
        );
      }
      case "calendar": {
        const limit = Math.min(Number(args.limit ?? 10), 30);
        const rows = await upcomingMatches(limit);
        return clip(rows.map((m) => `${m.utcDate.toISOString().slice(0, 16)} · ${m.league.name} · ${m.homeTeam.name} – ${m.awayTeam.name}`).join("\n"));
      }
      case "team_form": {
        const t = await resolveId(String(args.team ?? ""));
        if ("error" in t) return clip(t.error);
        const form = await teamForm(t.id, Math.min(Number(args.last_matches ?? 8), 20));
        return clip(
          `${t.name} — ${form.played} derniers matchs : ${form.results || "aucun"} · bilan ${form.wins}V-${form.draws}N-${form.losses}D · buts ${form.goalsFor}-${form.goalsAgainst}` +
            (form.xgFor !== null ? ` · xG moyen ${form.xgFor}/${form.xgAgainst}` : "") +
            (form.lastDate ? ` · dernier match joué ${form.lastDate}` : ""),
        );
      }
      case "home_away_split": {
        const t = await resolveId(String(args.team ?? ""));
        if ("error" in t) return clip(t.error);
        const ha = await homeAwaySplit(t.id, 20);
        return clip(
          `${t.name} — domicile : ${ha.home.played} matchs, ${ha.home.wins}V-${ha.home.draws}N-${ha.home.losses}D, buts ${ha.home.goalsFor}-${ha.home.goalsAgainst}` +
            `\n${t.name} — extérieur : ${ha.away.played} matchs, ${ha.away.wins}V-${ha.away.draws}N-${ha.away.losses}D, buts ${ha.away.goalsFor}-${ha.away.goalsAgainst}`,
        );
      }
      case "head_to_head": {
        const ta = await resolveId(String(args.team_a ?? ""));
        if ("error" in ta) return clip(ta.error);
        const tb = await resolveId(String(args.team_b ?? ""));
        if ("error" in tb) return clip(tb.error);
        const h = await headToHead(ta.id, tb.id, Math.min(Number(args.last_matches ?? 6), 15));
        return clip(h.facts.map((f) => `${f.label} : ${f.value}`).join("\n"));
      }
      case "match_stats": {
        const m = await resolveMatch(args);
        if (!m) return clip("Match introuvable (donnez match_id ou les deux équipes d'un match TERMINÉ).");
        if (m.status !== "FINISHED") return clip(`Match ${m.homeTeam.name} – ${m.awayTeam.name} : pas encore joué (${m.status}) — pas de statistiques de match.`);
        const s = await matchStats(m.id);
        return clip(`${m.homeTeam.name} ${m.homeScore}-${m.awayScore} ${m.awayTeam.name} (${m.utcDate.toISOString().slice(0, 10)})\n` + s.facts.map((f) => `${f.label} : ${f.value}`).join("\n"));
      }
      case "team_averages": {
        const t = await resolveId(String(args.team ?? ""));
        if ("error" in t) return clip(t.error);
        const avg = await teamAverages(t.id);
        return clip(avg.facts.map((f) => `${f.label} : ${f.value}`).join("\n"));
      }
      case "competition_info": {
        // Recherche de ligue par nom/code (petite table de ligues).
        const q = String(args.name ?? "").toLowerCase();
        const leagues = await (await import("@/lib/prisma")).prisma.league.findMany({ select: { id: true, name: true, externalId: true, shortName: true } });
        const hits = leagues.filter((l) => `${l.name} ${l.externalId} ${l.shortName ?? ""}`.toLowerCase().includes(q));
        if (hits.length === 0) return clip(`Compétition « ${args.name} » introuvable.`);
        const lines: string[] = [];
        for (const h of hits.slice(0, 3)) {
          const info = await competitionInfo(h.id);
          lines.push(...info.facts.map((f) => `${f.label} : ${f.value}`));
        }
        return clip(lines.join("\n"));
      }
      case "prediction":
      case "prediction_context": {
        const m = await resolveMatch(args);
        if (!m) return clip("Match introuvable (donnez match_id ou les deux équipes).");
        if (name === "prediction") {
          const r = await predictionInfo(m.id);
          return clip(`${m.homeTeam.name} – ${m.awayTeam.name}\n` + r.facts.map((f) => `${f.label} : ${f.value}`).join("\n"));
        }
        const r = await predictionContext(m.id);
        return clip(r.facts.map((f) => `${f.label} : ${f.value}`).join("\n"));
      }
      case "web_search": {
        if (ctx.webUsed >= ctx.maxWeb) return clip("Limite de recherches web atteinte pour cette question — base interne uniquement.");
        ctx.webUsed += 1;
        const hits = await webSearch(String(args.query ?? ""), 4);
        if (hits === null) return clip("Source web indisponible — aucune information externe n'a pu être récupérée.");
        return clip(hits.map((h) => `[WEB] ${h.title}\nURL: ${h.url}\n${h.snippet}`).join("\n\n"));
      }
      default:
        return clip(`Outil inconnu : ${name}`);
    }
  } catch (error) {
    return clip(`Erreur outil ${name} : ${(error as Error).message}`);
  }
}
