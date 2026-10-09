"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Send, AlertCircle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Evidence {
  label: string;
  value: string;
  source: string;
}

interface AgentSections {
  data?: string;
  analysis?: string;
  conclusion?: string;
  confidence?: { score: number; level: string };
  missing?: string[];
  sources?: { label: string; url: string }[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  evidence?: Evidence[];
  followUps?: string[];
  sections?: AgentSections;
  error?: boolean;
}

/** Questions d'amorçage issues du cahier des charges (§16). */
const SUGGESTIONS = [
  "Pourquoi Soleil pense que cette équipe va gagner ?",
  "Pourquoi Over 2.5 possède cette probabilité ?",
  "Quel est le score le plus probable ?",
  "Quelle équipe possède l'avantage offensif ?",
  "Quelle mi-temps semble la plus susceptible de produire des buts ?",
  "Comment fonctionne le moteur SOLEIL ?",
];

/**
 * Interface de l'agent SOLEIL AI.
 * Chaque réponse expose les faits chiffrés utilisés et le champ de la base
 * dont ils proviennent : l'utilisateur peut vérifier ce qui fonde l'analyse.
 */
export function SoleilChat({ matchId, matchLabel }: { matchId?: string; matchLabel?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (trimmed.length < 2 || pending) return;

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: trimmed },
      ]);
      setInput("");
      setPending(true);

      try {
        const history = messages
          .filter((m) => !m.error)
          .slice(-6)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, matchId: matchId ?? null, history }),
        });

        const payload = await response.json();

        if (!response.ok) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: payload.error ?? "Une erreur est survenue.",
              error: true,
            },
          ]);
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: payload.answer,
            evidence: payload.evidence ?? [],
            followUps: payload.followUps ?? [],
            sections: {
              data: payload.data,
              analysis: payload.analysis,
              conclusion: payload.conclusion,
              confidence: payload.confidence,
              missing: payload.missing ?? [],
              sources: payload.sources ?? [],
            },
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "Impossible de contacter le serveur SOLEIL. Vérifiez votre connexion puis réessayez.",
            error: true,
          },
        ]);
      } finally {
        setPending(false);
      }
    },
    [matchId, pending, messages],
  );

  return (
    <div className="flex flex-col">
      {matchLabel ? (
        <div className="mb-3 rounded-xl border border-soleil-500/25 bg-soleil-500/[0.07] px-3.5 py-2.5">
          <p className="text-[11.5px] text-fg-muted">
            Contexte actif : <span className="font-medium text-fg">{matchLabel}</span>
          </p>
        </div>
      ) : null}

      <div className="min-h-[260px] space-y-3.5">
        {messages.length === 0 ? (
          <div className="py-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-soleil-500/12 text-soleil-600 dark:text-soleil-400">
                <Sparkles className="size-4" strokeWidth={2.1} />
              </span>
              <div>
                <p className="text-[13.5px] font-semibold text-fg">SOLEIL AI</p>
                <p className="text-[11.5px] text-fg-subtle">
                  Répond uniquement à partir des données disponibles
                </p>
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-fg-muted">
              Posez une question sur une rencontre, un marché ou un score de confiance. Chaque
              réponse cite les valeurs réellement utilisées ainsi que leur origine dans la base.
              Mentionnez une équipe pour cibler une rencontre précise.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-border-subtle px-3 py-1.5 text-left text-[12px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id}>
            {message.role === "user" ? (
              <div className="flex justify-end">
                <p className="max-w-[86%] rounded-2xl rounded-br-md bg-fg px-3.5 py-2.5 text-[13px] leading-relaxed text-bg">
                  {message.content}
                </p>
              </div>
            ) : (
              <div
                className={cn(
                  "rounded-2xl rounded-bl-md border px-3.5 py-3",
                  message.error
                    ? "border-red-500/25 bg-red-500/[0.06]"
                    : "border-border-subtle bg-bg-subtle",
                )}
              >
                {message.error ? (
                  <p className="flex items-start gap-2 text-[13px] text-fg-muted">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
                    {message.content}
                  </p>
                ) : (
                  <>
                    {message.sections ? (
                      <div className="space-y-2.5">
                        {message.content ? (
                          <p className="whitespace-pre-line text-[13px] leading-relaxed text-fg">{message.content}</p>
                        ) : null}
                        {message.sections.data ? (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Données</p>
                            <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-fg">{message.sections.data}</p>
                          </div>
                        ) : null}
                        {message.sections.analysis ? (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Analyse</p>
                            <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-fg">{message.sections.analysis}</p>
                          </div>
                        ) : null}
                        {message.sections.conclusion ? (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Conclusion</p>
                            <p className="whitespace-pre-line text-[13px] leading-relaxed text-fg">{message.sections.conclusion}</p>
                          </div>
                        ) : null}
                        {message.sections.missing && message.sections.missing.length > 0 ? (
                          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2">
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                              Limites — je ne sais pas
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-fg-muted">
                              {message.sections.missing.map((m, i) => (
                                <li key={i}>{m}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {message.sections.sources && message.sections.sources.length > 0 ? (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Sources web</p>
                            <ul className="space-y-0.5 text-[11.5px]">
                              {message.sections.sources.map((s, i) => (
                                <li key={i}>
                                  <a href={s.url} target="_blank" rel="noreferrer" className="text-soleil-600 underline dark:text-soleil-400">
                                    {s.label}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {message.sections.confidence ? (
                          <p className="text-[11.5px] text-fg-muted">
                            Confiance de l&apos;analyse :{" "}
                            <span className="font-medium text-fg">
                              {message.sections.confidence.level} ({message.sections.confidence.score}/100)
                            </span>
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-[13px] leading-relaxed text-fg">{message.content}</p>
                    )}

                    {message.evidence && message.evidence.length > 0 ? (
                      <div className="mt-3 border-t border-border-subtle pt-2.5">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenEvidence((prev) => ({
                              ...prev,
                              [message.id]: !prev[message.id],
                            }))
                          }
                          aria-expanded={Boolean(openEvidence[message.id])}
                          className="text-[11.5px] font-medium text-fg-muted transition-colors hover:text-fg"
                        >
                          {openEvidence[message.id] ? "Masquer" : "Afficher"} les données utilisées (
                          {message.evidence.length})
                        </button>
                        {openEvidence[message.id] ? (
                          <dl className="mt-2 space-y-1">
                            {message.evidence.map((e, i) => (
                              <div
                                key={`${e.label}-${i}`}
                                className="flex items-baseline justify-between gap-3 text-[11.5px]"
                              >
                                <dt className="min-w-0 flex-1 truncate text-fg-muted">{e.label}</dt>
                                <dd className="shrink-0 font-mono font-medium tabular-nums text-fg">
                                  {e.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </div>
                    ) : null}

                    {message.followUps && message.followUps.length > 0 ? (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {message.followUps.slice(0, 3).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => send(f)}
                            className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-elevated px-2.5 py-1 text-[11.5px] text-fg-muted transition-colors hover:text-fg"
                          >
                            {f}
                            <ArrowRight className="size-3" strokeWidth={2.2} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {pending ? (
          <div className="rounded-2xl rounded-bl-md border border-border-subtle bg-bg-subtle px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="size-1.5 animate-pulse rounded-full bg-soleil-500" />
              <span className="size-1.5 animate-pulse rounded-full bg-soleil-500 [animation-delay:150ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-soleil-500 [animation-delay:300ms]" />
              <span className="ml-1 text-[12px] text-fg-subtle">
                Lecture des données disponibles…
              </span>
            </div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-4 flex items-center gap-2 rounded-2xl border border-border-strong bg-bg-elevated p-1.5"
      >
        <label htmlFor="soleil-ai-input" className="sr-only">
          Votre question
        </label>
        <input
          id="soleil-ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Posez une question sur une rencontre…"
          maxLength={500}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-2.5 py-2 text-[13.5px] text-fg outline-none placeholder:text-fg-subtle"
        />
        <button
          type="submit"
          disabled={pending || input.trim().length < 2}
          aria-label="Envoyer la question"
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-soleil-400 to-soleil-600 text-white transition-opacity disabled:opacity-40"
        >
          <Send className="size-4" strokeWidth={2.2} />
        </button>
      </form>
    </div>
  );
}
