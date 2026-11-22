"use client";
/**
 * Practice mode: endless questions from the practice pool, any time. Nothing is stored or
 * counted: answers are rated by how well known they are, and the score is just for this visit.
 * Uses the same play and summary screens as the daily game (posting to /api/practice/*).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/client/api";
import type { PracticeNext, Summary } from "@/lib/client/types";
import { Difficulty } from "./Bits";
import { MatchPlay } from "./MatchPlay";
import { OrderPlay } from "./OrderPlay";
import { Shell } from "./Shell";
import { SummaryView } from "./SummaryView";
import { TextPlay } from "./TextPlay";

type Filter = "any" | "free_text" | "match" | "order";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "any", label: "Mixed" }, { key: "free_text", label: "Name one" },
  { key: "match", label: "Matching" }, { key: "order", label: "Ordering" },
];
const ANSWER_URL = "/api/practice/answer";

interface Current extends PracticeNext { deadline: string }

export function Practice() {
  const [filter, setFilter] = useState<Filter>("any");
  const [cur, setCur] = useState<Current | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState({ points: 0, played: 0 });
  const seen = useRef<number[]>([]);

  const next = useCallback(async (f: Filter) => {
    setSummary(null);
    setCur(null);
    setError(null);
    try {
      const q = new URLSearchParams({ seen: seen.current.join(",") });
      if (f !== "any") q.set("kind", f);
      const n = await api<PracticeNext>(`/api/practice/next?${q}`);
      seen.current = [...seen.current, n.question.idx].slice(-300);
      setCur({ ...n, deadline: new Date(Date.now() + n.seconds * 1000).toISOString() });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void next("any"); }, [next]);

  const done = (s: Summary) => {
    setSummary(s);
    setScore((sc) => ({ points: sc.points + s.points, played: sc.played + 1 }));
  };
  const timeUp = async () => {
    if (!cur || summary) return;
    try { done(await api<Summary>("/api/practice/reveal", { idx: cur.question.idx })); } catch (e) { setError((e as Error).message); }
  };

  const head = (timer?: ReactNode) => cur && (
    <div className="card-head">
      <div className="qnum">P<small>{score.played + (summary ? 0 : 1)}</small></div>
      <div className="qmeta">
        <span className="family">Practice · {cur.question.family}</span>
        <Difficulty level={cur.difficulty} />
      </div>
      {timer}
    </div>
  );

  return (
    <Shell here="practice" dateline={<>practice<br />not scored</>} total={score.points}>
      <div className="seg practice-filter" role="tablist" aria-label="Question type">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key}
                  onClick={() => { setFilter(f.key); void next(f.key); }}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <div className="alert" role="alert"><span>{error}</span>
        <button type="button" className="btn btn-ghost" onClick={() => next(filter)}>Try again</button></div>}
      {!cur && !error && <div className="card"><div className="skeleton" style={{ width: "70%", height: "2rem" }} /></div>}
      {cur && !summary && (() => {
        const common = {
          date: "practice", question: cur.question, deadline: cur.deadline, seconds: cur.seconds, offsetMs: 0,
          head: (timer: ReactNode) => head(timer), onDone: done, answerUrl: ANSWER_URL,
        };
        if (cur.question.kind === "match") return <MatchPlay key={cur.question.idx} {...common} />;
        if (cur.question.kind === "order") return <OrderPlay key={cur.question.idx} {...common} />;
        return <TextPlay key={cur.question.idx} {...common} initial={[]} onEnd={timeUp} />;
      })()}
      {cur && summary && (
        <SummaryView question={cur.question} summary={summary} fresh head={head()}>
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <span className="fine">Practice answers are rated by how well known they are; nothing is saved.</span>
            <button type="button" className="btn btn-big" autoFocus onClick={() => next(filter)}>Next question →</button>
          </div>
        </SummaryView>
      )}
    </Shell>
  );
}
