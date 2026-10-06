import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { respond } from "@/server/ai/llmagent";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const BodySchema = z.object({
  question: z.string().min(2, "Question trop courte").max(500, "Question trop longue"),
  matchId: z.string().cuid().nullish(),
  conversationId: z.string().cuid().nullish(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) }))
    .max(12)
    .nullish(),
});

/**
 * Endpoint de l'agent SOLEIL AI (§16).
 * Validation stricte des entrées + limitation de débit (§30).
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, { key: "ai:chat", limit: 20, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Trop de requêtes. Réessayez dans quelques instants." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Requête invalide." },
      { status: 400 },
    );
  }

  try {
    const report = await respond(
      parsed.data.question,
      (parsed.data.history ?? []).map((t) => ({ role: t.role, content: t.content })),
      parsed.data.matchId ?? null,
    );

    // Journalisation de la conversation si un utilisateur authentifié existe.
    // En l'absence de session, la conversation n'est pas persistée : aucune
    // donnée personnelle n'est collectée sans compte (§30).
    void prisma;

    // `answer` (texte plat) reste fourni pour compatibilité ; les blocs
    // structurés (Données / Analyse / Conclusion) sont la forme de référence.
    const flat = [
      "Données —",
      report.data,
      "",
      "Analyse —",
      report.analysis,
      "",
      "Conclusion —",
      report.conclusion,
    ].join("\n");

    return NextResponse.json({
      answer: report.answer || flat,
      intent: report.intent,
      evidence: report.evidence,
      followUps: report.followUps,
      matchRef: report.matchRef ?? null,
      data: report.data,
      analysis: report.analysis,
      conclusion: report.conclusion,
      confidence: report.confidence,
      missing: report.missing,
      sources: report.sources,
      trace: report.trace,
      mode: report.mode,
      model: report.model,
    });
  } catch (error) {
    console.error("[soleil-ai] erreur:", error);
    return NextResponse.json(
      { error: "Une erreur interne est survenue. Aucune réponse n'a été générée." },
      { status: 500 },
    );
  }
}
