/**
 * ============================================================================
 * SOLEIL AI — Client LLM (OpenAI-compatible, tool calling)
 * ============================================================================
 * Le LLM est le cerveau conversationnel et décisionnel de Soleil AI. Il
 * comprend librement la question, choisit les outils, croise les résultats et
 * raisonne. Il ne remplace PAS le moteur de prédiction : les probabilités
 * restent calculées par `generatePrediction` et sont simplement lues ici.
 *
 * Standard OpenAI-compatible (`POST /chat/completions` + `tools`) : fonctionne
 * avec OpenAI, Groq, Mistral, OpenRouter, ou un modèle local (Ollama, LM
 * Studio) sans changer une ligne.
 *
 * Configuration (variables d'environnement, jamais exposées au client) :
 *   · `SOLEIL_AI_LLM_API_URL`   — défaut https://api.openai.com/v1
 *   · `SOLEIL_AI_LLM_API_KEY`   — clé du fournisseur (requis pour activer)
 *   · `SOLEIL_AI_LLM_MODEL`     — défaut gpt-4o-mini
 *
 * 🔒 La clé n'est envoyée qu'au fournisseur, jamais dans une réponse, jamais
 *    dans un outil, jamais journalisée.
 */

const DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 45_000;

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmReply {
  content: string | null;
  toolCalls: LlmToolCall[];
}

function config() {
  return {
    baseUrl: (process.env.SOLEIL_AI_LLM_API_URL ?? DEFAULT_BASE).replace(/\/$/, ""),
    apiKey: (process.env.SOLEIL_AI_LLM_API_KEY ?? "").trim(),
    model: (process.env.SOLEIL_AI_LLM_MODEL ?? DEFAULT_MODEL).trim(),
  };
}

export function llmAvailable(): boolean {
  return config().apiKey.length > 0;
}

export function llmModelName(): string {
  return config().model;
}

/** Un appel de tour de parole. Renvoie `null` en cas d'indisponibilité/échec. */
export async function llmChat(
  messages: LlmMessage[],
  tools: LlmToolSchema[],
  options: { temperature?: number } = {},
): Promise<LlmReply | null> {
  const { baseUrl, apiKey, model } = config();
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: options.temperature ?? 0.3,
        // gpt-oss consomme une partie des tokens pour le raisonnement interne :
        // on alloue assez pour la réponse + le JSON final.
        max_tokens: 4_000,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[soleil-llm] HTTP ${res.status} : ${detail.slice(0, 300)}`);
      return null;
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = body.choices?.[0]?.message;
    if (!msg) return null;
    return {
      content: msg.content ?? null,
      // Format API imbriqué strict (`type` + `function.name/arguments`) exigé
      // par Groq comme par OpenAI quand on rejoue les tool_calls en historique.
      toolCalls: (msg.tool_calls ?? []).map((t) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.function.name, arguments: t.function.arguments },
      })),
    };
  } catch (error) {
    console.error(`[soleil-llm] exception : ${(error as Error).message}`);
    return null;
  }
}
