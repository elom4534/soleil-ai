/**
 * ============================================================================
 * SOLEIL AI — Agent LLM autonome (boucle tool calling)
 * ============================================================================
 * QUESTION → compréhension libre (LLM) → plan autonome → appels d'outils →
 * données → recherche supplémentaire si nécessaire → croisement →
 * raisonnement (LLM) → réponse.
 *
 * Le LLM décide lui-même : quels outils, dans quel ordre, combien de fois,
 * s'il faut chercher sur le web, quand arrêter. Les outils sont strictement
 * en lecture seule (voir `toolkit.ts`).
 *
 * VÉRACITÉ (§16) : la réponse distingue [BASE INTERNE] / [MOTEUR] / [WEB] /
 * [ANALYSE]. Ce qui manque est annoncé (« Je ne dispose pas de cette
 * information »), jamais inventé. Les sources web sont citées (URL).
 *
 * LIMITES : 8 tours d'outils maximum · 2 recherches web par question ·
 * timeout global 90 s · anti-boucle (même outil + mêmes arguments × 2 max) ·
 * résultats d'outils bornés en taille.
 *
 * FALLBACK : si aucun LLM n'est configuré ou s'il est en échec, l'agent
 * déterministe de la mission 19 répond, explicitement marqué.
 */

import { llmChat, llmAvailable, llmModelName, type LlmMessage } from "./llm";
import { TOOL_SCHEMAS, executeTool, type ToolContext } from "./toolkit";
import { investigate, type AgentReport } from "./agent";

const MAX_TOOL_ROUNDS = 8;
const MAX_WEB = 2;
const GLOBAL_TIMEOUT_MS = 90_000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResponse {
  answer: string;
  data: string;
  analysis: string;
  conclusion: string;
  confidence: { score: number; level: string; why: string };
  missing: string[];
  sources: { label: string; url: string }[];
  /** Trace d'enquête (outils réellement appelés, dans l'ordre). */
  trace: string[];
  /** `llm` si le cerveau LLM a répondu, `fallback` sinon. */
  mode: "llm" | "fallback";
  model: string | null;
  followUps: string[];
  evidence: { label: string; value: string; source: string }[];
  intent: string;
  matchRef: { id: string; label: string } | null;
}

const SYSTEM_PROMPT = `Tu es SOLEIL AI, l'assistant d'analyse football de la plateforme SOLEIL. Tu es un véritable agent d'enquête autonome.

## Ton rôle
Comprendre librement la question, ENQUÊTER avec les outils fournis, croiser les sources, raisonner, puis répondre comme un analyste football — pas comme un tableau de statistiques.

## Moteur de prédiction
Les probabilités sont calculées par le MOTEUR de prédiction SOLEIL (source de vérité). Tu ne recalcules JAMAIS de probabilités : tu les lis (outil \`prediction\`) et tu les expliques. Ne modifie jamais rien.

## Autonomie — RÈGLES DÉCISIONNELLES
- Décide toi-même quels outils utiliser, dans quel ordre, et combien de fois.
- Commence TOUJOURS par les données internes (gratuites). Utilise \`web_search\` SEULEMENT quand la base interne ne suffit pas (actualités, blessures, suspensions, composition, entraîneur, contexte récent) — au plus 2 recherches.
- N'interroge JAMAIS l'utilisateur pour « vouloir chercher » : cherche toi-même.
- Enchaîne les recherches tant que tu n'as pas assez d'éléments. Quand c'est suffisant, arrête-toi.
- Pour un match à venir, privilégie les informations les plus récentes et GARDE SÉPARÉES les informations historiques et actuelles.

## VÉRACITÉ — obligatoire
- Marque chaque élément : [BASE INTERNE] (base SOLEIL), [MOTEUR] (résultat du moteur), [WEB] (avec URL), [ANALYSE] (ta propre interprétation).
- Ne JAMAIS inventer une statistique. Une donnée absente : « Je ne dispose pas de cette information. »
- Si des sources se contredisent, signale-le explicitement.
- Ne JAMAIS présenter une hypothèse comme un fait.

## Conversation
Les questions de suivi (« et les absences ? », « et sur les 5 derniers matchs ? ») portent sur le match/les équipes du message précédent : n'oblige pas l'utilisateur à répéter.

## Format de réponse FINAL
Après ton enquête, réponds en français, naturellement, et termine TON UNIQUE message final par exactement un objet JSON entre balises \`[RESULT]\` et \`[/RESULT]\` :
{"answer":"réponse conversationnelle complète","data":"faits sourcés (avec marqueurs [BASE INTERNE]/[MOTEUR]/[WEB])","analysis":"ton raisonnement, marqué [ANALYSE]","conclusion":"réponse finale à la question","confidence":{"score":0-100,"level":"élevée|moyenne|faible","why":"explication courte"},"missing":["ce que tu ne sais pas"],"sources":[{"label":"titre","url":"https://..."}]}
Si aucun JSON n'est nécessaire car tu n'as rien trouvé de structuré, fournis quand même l'objet avec les champs vides.`;

function extractResultJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\[RESULT\]([\s\S]*?)\[\/RESULT\]/);
  const raw = m ? m[1] : null;
  if (!raw) return null;
  try {
    return JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fallbackResponse(question: string, report: AgentReport, reason = ""): AgentResponse {
  return {
    answer: [report.data, "", report.analysis, "", report.conclusion].filter(Boolean).join("\n"),
    data: report.data,
    analysis: report.analysis,
    conclusion: report.conclusion,
    confidence: report.confidence,
    missing: report.missing,
    sources: report.sources,
    trace: report.trace,
    mode: "fallback",
    model: reason ? `fallback(${reason})` : null,
    followUps: report.followUps,
    evidence: report.evidence,
    intent: report.intent,
    matchRef: report.matchRef,
  };
}

export async function respond(question: string, history: ChatTurn[] = [], matchId?: string | null): Promise<AgentResponse> {
  // ── Fallback déterministe : pas de clé LLM, ou échec garanti ─────────────
  if (!llmAvailable()) {
    const report = await investigate(question, matchId ?? null);
    return fallbackResponse(question, report, "clé LLM absente de l'environnement");
  }

  const startedAt = Date.now();
  const ctx: ToolContext = { webUsed: 0, maxWeb: MAX_WEB };
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  // Contexte conversationnel : les 6 derniers tours (au plus).
  for (const turn of history.slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  if (matchId) {
    messages.push({ role: "user", content: `[Contexte : l'utilisateur consulte le match id ${matchId}]` });
  }
  messages.push({ role: "user", content: question });

  const seenCalls = new Map<string, number>();
  let lastReply: { content: string | null } | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) break;

    const reply = await llmChat(messages, TOOL_SCHEMAS as never);
    if (!reply) {
      // Le LLM est en échec → fallback explicite.
      const report = await investigate(question, matchId ?? null);
      return fallbackResponse(question, report, `appel LLM en échec (modèle ${llmModelName()})`);
    }
    lastReply = reply;

    if (reply.toolCalls.length === 0) {
      // Réponse finale.
      const text = reply.content ?? "";
      // gpt-oss peut produire une réponse vide (tokens de réflexion épuisés) :
      // on lui redonne la parole une fois avant de conclure.
      if (text.trim().length === 0 && round < MAX_TOOL_ROUNDS - 1) {
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "user", content: "Ta réponse était vide. Réponds à la question avec les éléments collectés (et l'objet JSON [RESULT])." });
        continue;
      }
      const parsed = extractResultJson(text);
      const clean = text.replace(/\[RESULT\][\s\S]*?\[\/RESULT\]/g, "").trim();
      if (parsed) {
        return {
          answer: String(parsed.answer ?? clean),
          data: String(parsed.data ?? ""),
          analysis: String(parsed.analysis ?? ""),
          conclusion: String(parsed.conclusion ?? ""),
          confidence: (parsed.confidence as AgentResponse["confidence"]) ?? { score: 50, level: "moyenne", why: "" },
          missing: Array.isArray(parsed.missing) ? (parsed.missing as unknown[]).map(String) : [],
          sources: Array.isArray(parsed.sources) ? (parsed.sources as { label: string; url: string }[]) : [],
          trace: traceFrom(messages),
          mode: "llm",
          model: llmModelName(),
          followUps: [],
          evidence: [],
          intent: "libre",
          matchRef: null,
        };
      }
      // Pas de JSON parsable : réponse texte honnête.
      return {
        answer: clean || "Je n'ai pas pu produire de réponse structurée.",
        data: "",
        analysis: clean,
        conclusion: clean,
        confidence: { score: 45, level: "moyenne", why: "réponse non structurée" },
        missing: [],
        sources: [],
        trace: traceFrom(messages),
        mode: "llm",
        model: llmModelName(),
        followUps: [],
        evidence: [],
        intent: "libre",
        matchRef: null,
      };
    }

    // Exécution des appels d'outils (anti-boucle + bornes).
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const key = `${call.name}:${call.arguments}`;
      const count = (seenCalls.get(key) ?? 0) + 1;
      seenCalls.set(key, count);
      let result: string;
      if (count > 2) {
        result = "Appel identique déjà effectué deux fois — explore une autre piste ou conclus avec les données disponibles.";
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        result = await executeTool(call.name, args, ctx);
      }
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  // Sortie de boucle (timeout/tours) : le LLM dit où il en est, sinon fallback.
  const closing = await llmChat(
    [
      ...messages,
      {
        role: "user",
        content:
          "L'enquête doit s'arrêter ici. Synthétise avec les éléments déjà collectés, signale ce qui manque, et termine par l'objet JSON [RESULT]…[/RESULT].",
      },
    ],
    [],
  );
  const text = closing?.content ?? lastReply?.content ?? "";
  const parsed = extractResultJson(text);
  const clean = text.replace(/\[RESULT\][\s\S]*?\[\/RESULT\]/g, "").trim();
  if (parsed) {
    return {
      answer: String(parsed.answer ?? clean),
      data: String(parsed.data ?? ""),
      analysis: String(parsed.analysis ?? ""),
      conclusion: String(parsed.conclusion ?? ""),
      confidence: (parsed.confidence as AgentResponse["confidence"]) ?? { score: 45, level: "moyenne", why: "enquête interrompue" },
      missing: Array.isArray(parsed.missing) ? (parsed.missing as unknown[]).map(String) : ["Enquête interrompue par la limite de temps/tours."],
      sources: Array.isArray(parsed.sources) ? (parsed.sources as { label: string; url: string }[]) : [],
      trace: traceFrom(messages),
      mode: "llm",
      model: llmModelName(),
      followUps: [],
      evidence: [],
      intent: "libre",
      matchRef: null,
    };
  }
  const report = await investigate(question, matchId ?? null);
  return fallbackResponse(question, report, "enquête LLM interrompue (tours/temps)");
}

function traceFrom(messages: LlmMessage[]): string[] {
  const trace: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") trace.push(`outil → ${String(m.content ?? "").slice(0, 80)}`);
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) trace.push(`appel ${c.name}(${c.arguments.slice(0, 80)})`);
    }
  }
  return trace.slice(-16);
}
