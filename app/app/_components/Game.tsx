"use client";
/**
 * The daily game (PLAN.md Phase 5): question → input → result → next, then the end screen.
 * Deliberately unstyled. All game logic lives on the server; this only renders API responses.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  firstUnanswered, nextUnanswered, progressEmoji,
} from "@/lib/client/state";
import { api } from "@/lib/client/api";
import type { AnswerResponse, Daily, Progress } from "@/lib/client/types";
import { EndScreen } from "./EndScreen";
import { HowToPlay } from "./HowToPlay";
import { MatchQuestion } from "./MatchQuestion";
import { TextQuestion } from "./TextQuestion";

const LOCAL_ID_KEY = "gr_pid";

/** Keep the httpOnly cookie and the localStorage copy of the player id in sync (PLAN.md §10). */
async function reconcileIdentity(): Promise<void> {
  let local: string | null = null;
  try { local = localStorage.getItem(LOCAL_ID_KEY); } catch { /* storage blocked */ }
  const { player_id } = await api<{ player_id: string }>("/api/identity/reconcile", { local_id: local });
  try { localStorage.setItem(LOCAL_ID_KEY, player_id); } catch { /* storage blocked */ }
}

type View = { kind: "question"; idx: number } | { kind: "end" };

export function Game() {
  const [daily, setDaily] = useState<Daily | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  const [results, setResults] = useState<Map<number, AnswerResponse>>(new Map());
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    (async () => {
      await reconcileIdentity();
      const d = await api<Daily>("/api/daily");
      const prog = new Map(d.progress.map((p) => [p.idx, p]));
      setDaily(d);
      setProgress(prog);
      const first = firstUnanswered(d.questions, new Set(prog.keys()));
      setView(first === null ? { kind: "end" } : { kind: "question", idx: first });
    })().catch((e: Error) => setError(e.message));
  }, []);

  const answered = useMemo(() => new Set(progress.keys()), [progress]);
  const total = [...progress.values()].reduce((s, p) => s + p.points, 0);

  /** Called by a question once the server says it's done (final answer). */
  const onFinal = useCallback((idx: number, r: AnswerResponse) => {
    setResults((m) => new Map(m).set(idx, r));
    setProgress((m) => new Map(m).set(idx, {
      idx, status: r.status, points: r.points, answer: r.entity?.name, tier: r.tier,
    }));
  }, []);

  /** Revisit an answered question: the server returns the stored result for a repeat POST. */
  const openQuestion = useCallback(async (idx: number) => {
    setView({ kind: "question", idx });
    if (daily && answered.has(idx) && !results.has(idx)) {
      try {
        const r = await api<AnswerResponse>("/api/answer", { date: daily.date, idx });
        setResults((m) => new Map(m).set(idx, r));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }, [daily, answered, results]);

  if (error && !daily) {
    return <main><h1>Geo-rarity</h1><p role="alert">{error}</p></main>;
  }
  if (!daily || !view) return <main><h1>Geo-rarity</h1><p>Loading…</p></main>;

  const question = view.kind === "question" ? daily.questions.find((q) => q.idx === view.idx) : undefined;
  const position = question ? daily.questions.indexOf(question) + 1 : 0;
  const goNext = () => {
    const next = question ? nextUnanswered(daily.questions, answered, question.idx) : null;
    setView(next === null ? { kind: "end" } : { kind: "question", idx: next });
  };

  return (
    <main>
      <h1>Geo-rarity</h1>
      <p>{daily.date} · {total} points</p>
      <HowToPlay />

      <nav aria-label="Questions">
        <ol style={{ display: "flex", gap: "0.5em", listStyle: "none", padding: 0 }}>
          {daily.questions.map((q, i) => (
            <li key={q.idx}>
              <button
                type="button"
                aria-current={view.kind === "question" && view.idx === q.idx ? "step" : undefined}
                onClick={() => openQuestion(q.idx)}
              >
                {i + 1} {progressEmoji(progress.get(q.idx), q)}
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setView({ kind: "end" })}
                    aria-current={view.kind === "end" ? "step" : undefined}>
              Results
            </button>
          </li>
        </ol>
      </nav>

      {error && <p role="alert">{error}</p>}

      {question && (
        <section key={question.idx}>
          <h2>Question {position} of {daily.questions.length} · {question.family}</h2>
          {question.kind === "match"
            ? <MatchQuestion date={daily.date} question={question} result={results.get(question.idx)}
                             answered={answered.has(question.idx)} onFinal={onFinal} />
            : <TextQuestion date={daily.date} question={question} result={results.get(question.idx)}
                            answered={answered.has(question.idx)} onFinal={onFinal} />}
          {answered.has(question.idx) && (
            <p>
              <button type="button" onClick={goNext} autoFocus>
                {answered.size === daily.questions.length ? "See results" : "Next question"}
              </button>
            </p>
          )}
        </section>
      )}

      {view.kind === "end" && (
        <EndScreen date={daily.date} remaining={daily.questions.length - answered.size}
                   onResume={() => {
                     const first = firstUnanswered(daily.questions, answered);
                     if (first !== null) setView({ kind: "question", idx: first });
                   }} />
      )}
    </main>
  );
}
