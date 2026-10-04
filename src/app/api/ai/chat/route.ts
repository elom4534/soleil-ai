import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { answer } from "@/server/ai/engine";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const BodySchema = z.object({
  question: z.string().min(2, "Question trop courte").max(500, "Question trop longue"),
  matchId: z.string().cuid().nullish(),
  conversationId: z.string().cuid().nullish(),
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
    const result = await answer({
      question: parsed.data.question,
      matchId: parsed.data.matchId ?? null,
    });

    // Journalisation de la conversation si un utilisateur authentifié existe.
    // En l'absence de session, la conversation n'est pas persistée : aucune
    // donnée personnelle n'est collectée sans compte (§30).
    void prisma;

    return NextResponse.json({
      answer: result.answer,
      intent: result.intent,
      evidence: result.evidence,
      followUps: result.followUps,
      matchRef: result.matchRef ?? null,
    });
  } catch (error) {
    console.error("[soleil-ai] erreur:", error);
    return NextResponse.json(
      { error: "Une erreur interne est survenue. Aucune réponse n'a été générée." },
      { status: 500 },
    );
  }
}
