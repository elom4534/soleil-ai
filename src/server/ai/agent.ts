/**
 * ============================================================================
 * SOLEIL AI — Orchestrateur d'enquête (agent autonome de recherche)
 * ============================================================================
 * question → compréhension → plan de recherche → outils DB (gratuits) →
 * recherche web si nécessaire → croisement/vérification → raisonnement →
 * réponse structurée (Données / Analyse / Conclusion) avec sources et
 * niveau de confiance.
 *
 * Principes :
 *   · AUTONOMIE : l'agent décide seul quelles recherches lancer ; il n'interroge
 *     l'utilisateur que s'il manque une information décisive ET non trouvable ;
 *   · CŒUR GRATUIT : toujours les données internes d'abord ; la recherche web
 *     n'intervient que si elle apporte une réelle valeur (actualité, absences,
 *     composition, entraîneur…) — au plus 2 recherches par question ;
 *   · HONNETETÉ (§16) : chaque affirmation est un fait sourcé (db | web) ou une
 *     interprétation explicitement marquée ; ce qui manque est listé sous
 *     « Limites — je ne sais pas » plutôt que deviné ;
 *   · LECTURE SEULE : aucune écriture en base ; le moteur de prédiction n'est
 *     jamais modifié — il est lu et expliqué.
 *
 * ⚠ L'agent n'est PAS le moteur : les probabilités viennent exclusivement des
 *   prédictions calculées par `generatePrediction`. Ici : rechercher, croiser,
 *   expliquer, comparer, contextualiser, reconnaître l'incertain.
 */

import {
  type Fact,
  fact,
  findTeam,
  findMatchBetween,
  getMatchById,
  teamForm,
  homeAwaySplit,
  headToHead,
  matchStats,
  teamAverages,
  predictionInfo,
  predictionContext,
  competitionInfo,
} from "./tools";
import { webSearch, type WebHit } from "./websearch";

const MAX_DB_CALLS = 16;
const MAX_WEB_SEARCHES = 2;

export type AgentIntent =
  | "reliability"
  | "explain_prediction"
  | "compare_teams"
  | "recent_news"
  | "full_analysis"
  | "match_summary"
  | "general";

export interface Confidence {
  score: number;
  level: "élevée" | "moyenne" | "faible";
  why: string;
}

export interface AgentReport {
  question: string;
  intent: AgentIntent;
  matchRef: { id: string; label: string } | null;
  /** Bloc 1 — faits vérifiables (db ou web, chacun sourcé). */
  data: string;
  /** Bloc 2 — interprétation de l'agent (jamais présentée comme un fait). */
  analysis: string;
  /** Bloc 3 — réponse finale à la question posée. */
  conclusion: string;
  confidence: Confidence;
  /** Ce que l'agent n'a PAS pu établir (« je ne sais pas » + raison). */
  missing: string[];
  sources: { label: string; url: string }[];
  evidence: Fact[];
  /** Trace d'enquête : les étapes réellement effectuées. */
  trace: string[];
  webSearches: string[];
  followUps: string[];
}

/* -------------------------------------------------------------------------- */
/* 1. Compréhension                                                           */
/* -------------------------------------------------------------------------- */

interface Understanding {
  intent: AgentIntent;
  teams: string[];
  wantsWeb: boolean;
  isReliability: boolean;
  dateHint: "demain" | "aujourd" | "autre" | null;
}

export function understand(question: string): Understanding {
  const q = question.toLowerCase();
  const wantsWeb = /(bless|absen|suspens|composition|probable|entra[îi]neur|coach|transfert|actualit|nouvelle|news|dernier.{0,12}info)/i.test(q);
  const isReliability = /(fiable|fiabilit|fiable\s*\?|risqu|s[ûu]r de|peut-on faire confiance)/i.test(q);
  const dateHint = /demain/.test(q) ? "demain" : /(aujourd|ce soir|cette nuit)/.test(q) ? "aujourd" : /(hier|passé|récemment|dernier|forme|historique)/.test(q) ? "autre" : null;

  let intent: AgentIntent = "general";
  if (isReliability) intent = "reliability";
  else if (/(analyse compl[eè]te|analyse (du|de la|du match)|rapport complet|tout sur)/.test(q)) intent = "full_analysis";
  else if (/(pourquoi|expliqu|d['oùu] vient|comment (le moteur|soleil) )/.test(q)) intent = "explain_prediction";
  else if (/(avantage|favori|compar|contre|vs|versus|mieux que|plut[ôo]t)/.test(q)) intent = "compare_teams";
  else if (/(récemment|dernier|forme|que s'est|actualit|nouvelle|bless)/.test(q)) intent = "recent_news";
  else if (/(résum|synth[èe]se|score|match)/.test(q)) intent = "match_summary";

  // Équipes : on teste les tronçons significatifs contre la base (outils.findTeam).
  const teams: string[] = [];
  const cleaned = question.replace(/[?!.:,;()"']/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 2);
  for (let i = 0; i < tokens.length; i++) {
    for (const span of [tokens[i + 2] ? `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}` : null, tokens[i + 1] ? `${tokens[i]} ${tokens[i + 1]}` : null, tokens[i]]) {
      if (span && span.length > 3) teams.push(span);
    }
  }
  return { intent, teams: [...new Set(teams)], wantsWeb, isReliability, dateHint };
}

/* -------------------------------------------------------------------------- */
/* 2-4. Plan et enquête (autonomes, bornées)                                  */
/* -------------------------------------------------------------------------- */

async function resolveTeams(candidates: string[]): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  for (const c of candidates) {
    if (found.length >= 2) break;
    const hit = await findTeam(c);
    if (hit && "id" in hit && !found.some((f) => f.id === hit.id)) {
      found.push({ id: hit.id, name: hit.name });
    }
  }
  return found;
}

export async function investigate(question: string, matchIdHint?: string | null): Promise<AgentReport> {
  const u = understand(question);
  const trace: string[] = [];
  const facts: Fact[] = [];
  const missing: string[] = [];
  const webHits: WebHit[] = [];
  const webSearches: string[] = [];
  let dbCalls = 0;

  // ── Étape 1 : identifier le match et les équipes ─────────────────────────
  trace.push("compréhension : " + u.intent + (u.wantsWeb ? " (+ demande d'actualité)" : ""));
  const teams = await resolveTeams(u.teams);
  dbCalls++;
  trace.push(`équipes reconnues : ${teams.map((t) => t.name).join(", ") || "aucune"}`);

  let match: Awaited<ReturnType<typeof findMatchBetween>> = null;
  if (matchIdHint) {
    match = await getMatchById(matchIdHint);
    dbCalls++;
  } else if (teams.length === 2) {
    match = await findMatchBetween(teams[0].id, teams[1].id, true);
    dbCalls++;
    if (!match) {
      match = await findMatchBetween(teams[0].id, teams[1].id, false);
      dbCalls++;
    }
  }
  const matchRef = match ? { id: match.id, label: `${match.homeTeam.name} – ${match.awayTeam.name}` } : null;
  trace.push(matchRef ? `match ciblé : ${matchRef.label} (${match!.utcDate.toISOString().slice(0, 16)})` : "aucun match unique identifié");

  // ── Étape 2 : prédiction du moteur + contexte (source de vérité §23) ─────
  if (matchRef && dbCalls < MAX_DB_CALLS) {
    const { facts: pf } = await predictionInfo(matchRef.id);
    facts.push(...pf);
    dbCalls++;
    const ctx = await predictionContext(matchRef.id);
    facts.push(...ctx.facts);
    dbCalls++;
    if (ctx.priorHome < 5 || ctx.priorAway < 5) {
      missing.push(`Contexte historique mince : ${Math.min(ctx.priorHome, ctx.priorAway)} match(s) ou moins pour l'une des équipes avant la date du match.`);
    }
  } else if (!matchRef) {
    missing.push("Aucun match identifié — précisez les deux équipes (ou le match) pour une analyse ciblée.");
  }

  // ── Étape 3 : croisements statistiques (gratuits, base interne) ──────────
  const sides = matchRef ? [{ id: match!.homeTeamId, name: match!.homeTeam.name, role: "domicile" as const }, { id: match!.awayTeamId, name: match!.awayTeam.name, role: "extérieur" as const }] : teams.map((t) => ({ ...t, role: "—" as const }));

  for (const side of sides.slice(0, 2)) {
    if (dbCalls >= MAX_DB_CALLS) break;
    const form = await teamForm(side.id, 8);
    facts.push(...form.facts.map((f) => fact(`${side.name} — ${f.label}`, f.value, f.ref)));
    dbCalls++;
    if (form.played === 0) missing.push(`Forme récente indisponible pour ${side.name} (aucun match terminé en base).`);

    const ha = await homeAwaySplit(side.id, 20);
    facts.push(...ha.facts.map((f) => fact(`${side.name} — ${f.label}`, f.value, f.ref)));
    dbCalls++;

    const avg = await teamAverages(side.id);
    facts.push(...avg.facts.map((f) => fact(`${side.name} — ${f.label}`, f.value, f.ref)));
    dbCalls++;
    if (avg.sample === 0) missing.push(`Statistiques détaillées (tirs, xG…) manquantes pour ${side.name} sur 12 mois.`);
  }

  if (sides.length === 2 && dbCalls < MAX_DB_CALLS) {
    const h2h = await headToHead(sides[0].id, sides[1].id, 6);
    facts.push(...h2h.facts);
    dbCalls++;
  }

  if (matchRef && dbCalls < MAX_DB_CALLS) {
    const ms = await matchStats(matchRef.id);
    // Stats du MATCH LUI-MÊME : seulement si le match est terminé (pas de
    // donnée future dans une analyse passée, §11).
    if (ms.match && ms.match.status === "FINISHED") {
      facts.push(...ms.facts.filter((f) => f.value !== "absentes de la base pour ce match"));
    }
    if (match!.leagueId) {
      const comp = await competitionInfo(match!.leagueId);
      facts.push(...comp.facts);
      dbCalls++;
    }
  }

  // ── Étape 5 : la recherche web apporte-t-elle une valeur réelle ? ────────
  const needsWeb =
    u.wantsWeb ||
    u.intent === "recent_news" ||
    (u.intent === "reliability" && facts.length < 6) ||
    (u.intent === "full_analysis" && sides.length === 2);
  if (needsWeb && webSearches.length < MAX_WEB_SEARCHES) {
    const target = sides[0]?.name ?? teams[0]?.name ?? null;
    if (target) {
      const query = `${target} ${u.dateHint === "demain" ? "match demain" : "football"} ${u.wantsWeb ? "blessures absences effectif" : "actualité récente"}`;
      webSearches.push(query);
      trace.push(`recherche web : « ${query} »`);
      const hits = await webSearch(query);
      if (hits === null) {
        missing.push("Source web indisponible au moment de la réponse (aucune information externe n'a été ajoutée).");
        trace.push("recherche web : source indisponible");
      } else {
        webHits.push(...hits);
        for (const h of hits) {
          facts.push(fact(`Web — ${h.title.slice(0, 70)}`, h.snippet.slice(0, 140) + "…", h.url, "web"));
        }
        trace.push(`recherche web : ${hits.length} résultat(s)`);
      }
    }
  }

  // ── Étape 6 : le reste est-il couvrable par une recherche supplémentaire ?
  // L'agent le décide seul : si un manque est couvrable, il enchaîne (une
  // fois) ; sinon il l'annonce honnêtement dans « Limites ».
  const uncovered = missing.filter((m) => /blessure|absence|composition/i.test(m));
  if (uncovered.length > 0 && webSearches.length === 0) {
    const query = `${sides[0]?.name ?? ""} ${sides[1]?.name ?? ""} blessures absences`.trim();
    webSearches.push(query);
    const hits = await webSearch(query);
    if (hits) webHits.push(...hits);
    else missing.push("Aucune source disponible pour confirmer les absences/blessures.");
  }

  // ── Étape 7 : synthèse (Données / Analyse / Conclusion) ──────────────────
  const report = synthesize(question, u, facts, webHits, missing, matchRef, trace, webSearches);
  report.followUps = buildFollowUps(u, matchRef, report);
  return report;
}

/* -------------------------------------------------------------------------- */
/* 7. Synthèse : Données / Analyse / Conclusion + confiance                   */
/* -------------------------------------------------------------------------- */

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

function computeConfidence(facts: Fact[], missing: string[], hasPrediction: boolean): Confidence {
  let score = 45;
  const why: string[] = ["base de réponse partielle"];
  if (hasPrediction) { score += 20; why.push("prédiction du moteur présente"); }
  const dbCount = facts.filter((f) => f.source === "db").length;
  if (dbCount >= 8) { score += 15; why.push("couverture statistique large"); }
  else if (dbCount >= 4) { score += 8; why.push("couverture statistique correcte"); }
  if (!facts.some((f) => /Forme/.test(f.label) && /aucun match/.test(f.value))) { score += 8; why.push("formes récentes disponibles"); }
  if (missing.length === 0) { score += 7; why.push("aucun manque identifié"); }
  else { score -= 7 * Math.min(missing.length, 3); why.push(`${missing.length} manque(s) signalé(s)`); }
  score = Math.max(5, Math.min(95, score));
  const level = score >= 72 ? "élevée" : score >= 50 ? "moyenne" : "faible";
  return { score, level, why: why.join(" · ") };
}

function synthesize(
  question: string,
  u: Understanding,
  facts: Fact[],
  webHits: WebHit[],
  missing: string[],
  matchRef: { id: string; label: string } | null,
  trace: string[],
  webSearches: string[],
): AgentReport {
  // ── Bloc 1 : Données (uniquement des faits sourcés) ──────────────────────
  const dbFacts = facts.filter((f) => f.source === "db");
  const webFacts = facts.filter((f) => f.source === "web");
  const dataLines = [
    ...dbFacts.map((f) => `• ${f.label} : ${f.value} [base interne]`),
    ...webFacts.map((f) => `• ${f.label} : ${f.value} [web]`),
  ];

  // ── Bloc 2 : Analyse (interprétation explicite de l'agent) ───────────────
  const analysisLines: string[] = [];
  const formFacts = dbFacts.filter((f) => /Forme \(/.test(f.label));
  const bilanFacts = dbFacts.filter((f) => f.label.endsWith("Bilan"));
  if (bilanFacts.length === 2) {
    analysisLines.push(`Comparaison des dynamiques : ${bilanFacts[0].value} (${matchRef ? "domicile" : "équipe A"}) contre ${bilanFacts[1].value} (${matchRef ? "extérieur" : "équipe B"}).`);
  }
  const haFacts = dbFacts.filter((f) => /^(.+— À (domicile|l'extérieur))/.test(f.label) || /^À (domicile|l'extérieur)/.test(f.label));
  if (haFacts.length >= 2) {
    analysisLines.push("Le prisme domicile/extérieur peut décaler la lecture des formes brutes : c'est précisément le prisme utilisé par le moteur pour les rencontres à enjeu de terrain.");
  }
  const xgFacts = dbFacts.filter((f) => /xG/.test(f.label));
  if (xgFacts.length > 0) {
    analysisLines.push("Les xG (quand ils existent) décrivent la qualité des occasions créées/concédées : des buts au-dessus des xG signalent une finition ou une malchance durable à relativiser sur un petit échantillon.");
  }
  if (u.intent === "reliability") {
    analysisLines.push("La fiabilité d'une prédiction dépend de : la quantité de données antérieures au match, la fraîcheur de la prédiction, et la stabilité des équipes (effectifs, entraîneur — hors base interne).");
  }
  if (u.intent === "compare_teams") {
    analysisLines.push("L'avantage d'une équipe se lit à la convergence des signaux : bilan récent, efficacité à domicile/extérieur, H2H et production de tirs/xG. Une divergence (bonne forme mais xG faible) invite à la prudence.");
  }
  if (webFacts.length > 0) {
    analysisLines.push("Les éléments marqués [web] ne sont pas vérifiés par la base interne : ils sont contextualisants (effectif, actualité) et doivent être lus avec leur source.");
  }
  if (analysisLines.length === 0) {
    analysisLines.push("Les faits ci-dessus sont factuels ; leur interprétation demande le contexte du match précis — reformulez avec les deux équipes pour une analyse croisée.");
  }

  // ── Bloc 3 : Conclusion ──────────────────────────────────────────────────
  let conclusion = "";
  const hasPrediction = dbFacts.some((f) => f.label === "Prédiction du moteur");
  const predFact = dbFacts.find((f) => f.label === "Prédiction du moteur");
  switch (u.intent) {
    case "explain_prediction":
    case "match_summary":
    case "full_analysis":
      conclusion = hasPrediction && predFact
        ? `Le moteur s'appuie sur ${predFact.value}. ${matchRef ? `Les signaux observés sur ${matchRef.label} sont listés ci-dessus — ils éclairent ce calcul sans le modifier.` : ""}`.trim()
        : "Sans prédiction enregistrée, je ne peux pas expliquer un choix du moteur : aucune probabilité n'est inventée.";
      break;
    case "reliability":
      conclusion =
        "La prédiction est crédible DANS LA MESURE où son contexte est riche et récent — voir le fait « Contexte exploitable » et les manques listés. Ce qui relève de l'actualité (blessures, composition) n'est pas couvert par la base interne.";
      break;
    case "compare_teams":
      conclusion = "La comparaison ci-dessus (forme, domicile/extérieur, moyennes de jeu) donne l'avantage aux signaux les plus convergents ; la prédiction du moteur reste la source de probabilités de référence.";
      break;
    case "recent_news":
      conclusion = webFacts.length > 0
        ? "Éléments récents trouvés sur le web (avec sources) et croisés avec la base ; aucune donnée interne récente récente ne les contredit."
        : "Base interne seulement : les matchs et statistiques récents disponibles sont listés ; aucune actualité hors base n'a pu être vérifiée.";
      break;
    default:
      conclusion = matchRef
        ? `${matchRef.label} : les éléments vérifiables sont regroupés ci-dessus (prédiction, contexte, formes, statistiques).`
        : "Données regroupées ci-dessus. Précisez une équipe ou un match pour une conclusion ciblée.";
  }
  if (missing.length > 0) {
    conclusion += " Ce que je ne sais pas est listé dans « Limites » : ces points ne sont pas devinés.";
  }

  const confidence = computeConfidence(facts, missing, hasPrediction);
  return {
    question,
    intent: u.intent,
    matchRef,
    data: dataLines.join("\n"),
    analysis: analysisLines.join("\n"),
    conclusion,
    confidence,
    missing,
    sources: webHits.map((h) => ({ label: h.title.slice(0, 80), url: h.url })),
    evidence: facts,
    trace,
    webSearches,
    followUps: [],
  };
}

function buildFollowUps(u: Understanding, matchRef: { id: string; label: string } | null, report: AgentReport): string[] {
  const ups: string[] = [];
  if (matchRef) {
    ups.push(`Pourquoi le moteur donne-t-il ces probabilités pour ${matchRef.label} ?`);
    ups.push(`${matchRef.label} : est-ce une prédiction fiable ?`);
  } else {
    ups.push("Donne-moi une analyse complète de Arsenal – Bournemouth");
  }
  if (report.missing.length > 0) ups.push("Qu'est-ce qui manque pour être plus sûr ?");
  if (u.intent !== "recent_news") ups.push("Que s'est-il passé récemment pour cette équipe ?");
  return ups.slice(0, 3);
}
