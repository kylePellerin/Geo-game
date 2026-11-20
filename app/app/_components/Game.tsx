"use client";
/**
 * The daily game: questions in order, each started by the player and timed (PLAN.md §1, rules of
 * 2026-11-20). Start → play (free text: many answers; matching / ordering: one submission) →
 * summary → next, then the end screen. All game logic lives on the server; this only renders.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { currentQuestion, stripLabel } from "@/lib/client/state";
import type { Daily, DayResults, Question, StartResponse, Summary } from "@/lib/client/types";
import { EndScreen } from "./EndScreen";
import { HowToPlay } from "./HowToPlay";
import { MatchPlay } from "./MatchPlay";
import { OrderPlay } from "./OrderPlay";
import { SummaryView } from "./SummaryView";
import { TextPlay } from "./TextPlay";

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
  const [offsetMs, setOffsetMs] = useState(0);
  const [started, setStarted] = useState<Map<number, StartResponse>>(new Map());
  const [summaries, setSummaries] = useState<Map<number, Summary>>(new Map());
  const [results, setResults] = useState<DayResults | null>(null);
  const [view, setView] = useState<View | null>(null);
  const ending = useRef(new Set<number>());

  const markDone = useCallback((idx: number, s: Summary) => {
    setSummaries((m) => new Map(m).set(idx, s));
    setDaily((d) => d && {
      ...d,
      questions: d.questions.map((q) => q.idx === idx
        ? { ...q, points: s.points, play: { ...q.play, state: "done" } } : q),
    });
    if (s.dayComplete) {
      // fetch the end screen now, while the player reads this question's summary
      api<DayResults>(`/api/results/${daily?.date}`).then(setResults, () => {});
    }
  }, [daily?.date]);

  const start = useCallback(async (date: string, idx: number) => {
    try {
      const r = await api<StartResponse>("/api/question/start", { date, idx });
      setOffsetMs(Date.parse(r.serverNow) - Date.now());
      setStarted((m) => new Map(m).set(idx, r));
      setDaily((d) => d && {
        ...d, questions: d.questions.map((q) => q.idx === idx ? { ...q, ...r.question, play: r.play } : q),
      });
      if (r.summary) markDone(idx, r.summary);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [markDone]);

  /** End a question (time up / "I'm done") or fetch the summary of one already over. */
  const end = useCallback(async (date: string, idx: number) => {
    if (ending.current.has(idx)) return;
    ending.current.add(idx);
    try {
      markDone(idx, await api<Summary>("/api/question/end", { date, idx }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      ending.current.delete(idx);
    }
  }, [markDone]);

  useEffect(() => {
    (async () => {
      await reconcileIdentity();
      const d = await api<Daily>("/api/daily");
      setOffsetMs(Date.parse(d.serverNow) - Date.now());
      setDaily(d);
      const cur = currentQuestion(d.questions);
      // only if nothing is shown yet: React's dev mode runs this effect twice, and a second run
      // must not undo a click the player already made
      setView((v) => v ?? (cur === null ? { kind: "end" } : { kind: "question", idx: cur }));
      // a question left running (reload): resume it, the clock kept going on the server
      if (cur !== null && d.questions.find((q) => q.idx === cur)?.play.state === "playing") {
        await start(d.date, cur);
      }
    })().catch((e: Error) => setError(e.message));
  }, [start]);

  if (error && !daily) return <main><h1>Geo-rarity</h1><p role="alert">{error}</p></main>;
  if (!daily || !view) return <main><h1>Geo-rarity</h1><p>Loading…</p></main>;

  const total = daily.questions.reduce((s, q) => s + q.points, 0);
  const cur = currentQuestion(daily.questions);
  const dq = view.kind === "question" ? daily.questions.find((q) => q.idx === view.idx) : undefined;
  const position = dq ? daily.questions.indexOf(dq) + 1 : 0;
  const st = dq ? started.get(dq.idx) : undefined;
  const summary = dq ? summaries.get(dq.idx) : undefined;
  const question: Question | undefined = dq?.text ? (dq as Question) : st?.question;

  const openQuestion = (idx: number) => {
    setView({ kind: "question", idx });
    const q = daily.questions.find((x) => x.idx === idx);
    if (q?.play.state === "done" && !summaries.has(idx)) void end(daily.date, idx);
  };
  const goNext = () => {
    const next = currentQuestion(daily.questions);
    setView(next === null ? { kind: "end" } : { kind: "question", idx: next });
  };

  return (
    <main>
      <h1>Geo-rarity</h1>
      <p>{daily.date} · {total} points</p>
      <HowToPlay />

      <nav aria-label="Questions">
        <ol style={{ display: "flex", flexWrap: "wrap", gap: "0.5em", listStyle: "none", padding: 0 }}>
          {daily.questions.map((q, i) => (
            <li key={q.idx}>
              <button type="button" onClick={() => openQuestion(q.idx)}
                      disabled={q.play.state === "not_started" && q.idx !== cur}
                      aria-current={view.kind === "question" && view.idx === q.idx ? "step" : undefined}>
                {stripLabel(q, i + 1)}
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setView({ kind: "end" })}
                    aria-current={view.kind === "end" ? "step" : undefined}>Results</button>
          </li>
        </ol>
      </nav>

      {error && <p role="alert">{error} <button type="button" onClick={() => setError(null)}>OK</button></p>}

      {dq && (
        <section key={dq.idx}>
          <h2>
            Question {position} of {daily.questions.length} · {dq.family}
          </h2>

          {dq.play.state === "not_started" && (
            <div>
              <p>
                {dq.kind === "free_text"
                  ? `You'll have ${dq.play.seconds} seconds to give as many answers as you can.`
                  : `You'll have ${dq.play.seconds} seconds.`}
              </p>
              <button type="button" autoFocus onClick={() => start(daily.date, dq.idx)}>
                Start question {position}
              </button>
            </div>
          )}

          {dq.play.state === "playing" && !st && <p>Loading…</p>}
          {dq.play.state === "playing" && st && question && (() => {
            const common = {
              date: daily.date, question, deadline: st.play.deadline!, seconds: st.play.seconds, offsetMs,
            };
            if (question.kind === "match") return <MatchPlay {...common} onDone={(s) => markDone(dq.idx, s)} />;
            if (question.kind === "order") return <OrderPlay {...common} onDone={(s) => markDone(dq.idx, s)} />;
            return <TextPlay {...common} initial={st.answers} onEnd={() => end(daily.date, dq.idx)} />;
          })()}

          {dq.play.state === "done" && (
            <>
              {summary && question ? <SummaryView question={question} summary={summary} /> : <p>Loading…</p>}
              <p>
                <button type="button" onClick={goNext} autoFocus>
                  {cur === null ? "See results" : "Next question"}
                </button>
              </p>
            </>
          )}
        </section>
      )}

      {view.kind === "end" && (
        <EndScreen date={daily.date} prefetched={results} remaining={daily.questions.filter((q) => q.play.state !== "done").length}
                   onResume={() => { if (cur !== null) setView({ kind: "question", idx: cur }); }} />
      )}
    </main>
  );
}
