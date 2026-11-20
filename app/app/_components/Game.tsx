"use client";
/**
 * The daily game: questions in order, each started by the player and timed (PLAN.md §1, rules of
 * 2026-11-20). Start → play (free text: one right answer, retries allowed; matching / ordering:
 * one submission) → summary → next, then the end screen. All game logic lives on the server; this
 * only renders. Summaries and results are cached per player in localStorage (lib/client/cache).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "@/lib/client/api";
import { cachedSummaries, localResults, pruneCache, storeSummary } from "@/lib/client/cache";
import { currentQuestion } from "@/lib/client/state";
import type { Daily, DayQuestion, Question, StartResponse, Summary, Tier } from "@/lib/client/types";
import { TIERS } from "@/lib/game/scoring";
import { Compass, CountUp, Difficulty, tierColor } from "./Bits";
import { EndScreen } from "./EndScreen";
import { HowToPlay } from "./HowToPlay";
import { MatchPlay } from "./MatchPlay";
import { OrderPlay } from "./OrderPlay";
import { SummaryView } from "./SummaryView";
import { TextPlay } from "./TextPlay";

const LOCAL_ID_KEY = "gr_pid";
const SEEN_RULES_KEY = "gr_seen_rules";
const LAUNCH = Date.UTC(2026, 10, 20);

/** Keep the httpOnly cookie and the localStorage copy of the player id in sync (PLAN.md §10). */
async function reconcileIdentity(): Promise<void> {
  let local: string | null = null;
  try { local = localStorage.getItem(LOCAL_ID_KEY); } catch { /* storage blocked */ }
  const { player_id } = await api<{ player_id: string }>("/api/identity/reconcile", { local_id: local });
  try { localStorage.setItem(LOCAL_ID_KEY, player_id); } catch { /* storage blocked */ }
}

type View = { kind: "question"; idx: number } | { kind: "end" };

function tierOf(s: Summary | undefined): Tier | undefined {
  return s?.answers.find((a) => a.status === "valid")?.tier;
}

function dateline(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const n = Math.round((d.getTime() - LAUNCH) / 86_400_000) + 1;
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return n >= 1 ? `No. ${n} · ${day}` : day;
}

export function Game() {
  const [daily, setDaily] = useState<Daily | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [started, setStarted] = useState<Map<number, StartResponse>>(new Map());
  const [summaries, setSummaries] = useState<Map<number, Summary>>(new Map());
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [view, setView] = useState<View | null>(null);
  const [rules, setRules] = useState(false);
  const ending = useRef(new Set<number>());
  const dateRef = useRef<string | null>(null);

  const markDone = useCallback((idx: number, s: Summary, isFresh = false) => {
    setSummaries((m) => new Map(m).set(idx, s));
    if (isFresh) setFresh((f) => new Set(f).add(idx));
    if (dateRef.current) storeSummary(dateRef.current, s);
    setDaily((d) => d && {
      ...d,
      questions: d.questions.map((q) => q.idx === idx
        ? { ...q, points: s.points, play: { ...q.play, state: "done" } } : q),
    });
  }, []);

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

  /** End a question (time up / skip) or fetch the summary of one already over. */
  const end = useCallback(async (date: string, idx: number, isFresh = false) => {
    if (ending.current.has(idx)) return;
    ending.current.add(idx);
    try {
      markDone(idx, await api<Summary>("/api/question/end", { date, idx }), isFresh);
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
      dateRef.current = d.date;
      pruneCache(d.date);
      setOffsetMs(Date.parse(d.serverNow) - Date.now());
      // finished questions we've seen before: show their summaries without a round trip
      const cached = cachedSummaries(d.date);
      const done = new Set(d.questions.filter((q) => q.play.state === "done").map((q) => q.idx));
      setSummaries((m) => {
        const out = new Map(m);
        for (const [idx, s] of cached) if (done.has(idx) && !out.has(idx)) out.set(idx, s);
        return out;
      });
      setDaily(d);
      const cur = currentQuestion(d.questions);
      // only if nothing is shown yet: React's dev mode runs this effect twice, and a second run
      // must not undo a click the player already made
      setView((v) => v ?? (cur === null ? { kind: "end" } : { kind: "question", idx: cur }));
      try {
        if (!localStorage.getItem(SEEN_RULES_KEY) && d.questions.every((q) => q.play.state === "not_started")) {
          setRules(true);
          localStorage.setItem(SEEN_RULES_KEY, "1");
        }
      } catch { /* storage blocked */ }
      // a question left running (reload): resume it, the clock kept going on the server
      if (cur !== null && d.questions.find((q) => q.idx === cur)?.play.state === "playing") {
        await start(d.date, cur);
      }
    })().catch((e: Error) => setError(e.message));
  }, [start]);

  const local = useMemo(
    () => daily && localResults(daily.date, daily.questions, summaries), [daily, summaries],
  );

  if (error && !daily) {
    return <Shell><div className="alert" role="alert">{error}</div></Shell>;
  }
  if (!daily || !view || !local) {
    return <Shell><div className="loading"><Compass />Charting today&apos;s course…</div></Shell>;
  }

  const total = daily.questions.reduce((s, q) => s + q.points, 0);
  const cur = currentQuestion(daily.questions);
  const dq = view.kind === "question" ? daily.questions.find((q) => q.idx === view.idx) : undefined;
  const position = dq ? daily.questions.indexOf(dq) + 1 : 0;
  const st = dq ? started.get(dq.idx) : undefined;
  const summary = dq ? summaries.get(dq.idx) : undefined;
  const question: Question | undefined = dq?.text ? (dq as Question) : st?.question;
  const doneCount = daily.questions.filter((q) => q.play.state === "done").length;

  const openQuestion = (idx: number) => {
    setView({ kind: "question", idx });
    const q = daily.questions.find((x) => x.idx === idx);
    if (q?.play.state === "done" && !summaries.has(idx)) void end(daily.date, idx);
  };
  const goNext = () => {
    const next = currentQuestion(daily.questions);
    setView(next === null ? { kind: "end" } : { kind: "question", idx: next });
  };
  const head = (q: DayQuestion, timer?: ReactNode) => (
    <div className="card-head">
      <div className="qnum">{String(daily.questions.indexOf(q) + 1).padStart(2, "0")}<small>/{daily.questions.length}</small></div>
      <div className="qmeta">
        <span className="family">{q.family}</span>
        <Difficulty level={q.difficulty} />
      </div>
      {timer}
    </div>
  );

  return (
    <Shell onHelp={() => setRules(true)} date={daily.date} total={total}>
      <nav className="route" aria-label="Questions">
        <span className="route-line" aria-hidden="true" />
        <span className="route-line-done" aria-hidden="true"
              style={{ width: `calc((100% - 2.8rem) * ${Math.min(doneCount, daily.questions.length) / daily.questions.length})` }} />
        <ol>
          {daily.questions.map((q, i) => {
            const tier = q.play.state === "done" ? tierOf(summaries.get(q.idx)) : undefined;
            return (
              <li key={q.idx}>
                <button type="button" className="stop" onClick={() => openQuestion(q.idx)}
                        data-state={q.play.state} data-next={q.idx === cur && q.play.state === "not_started"}
                        data-tier={tier} style={tier ? { "--tier": tierColor(tier) } as CSSProperties : undefined}
                        disabled={q.play.state === "not_started" && q.idx !== cur}
                        aria-current={view.kind === "question" && view.idx === q.idx ? "step" : undefined}
                        aria-label={q.play.state === "done" ? `${i + 1} · ${q.points}` : `Question ${i + 1}`}>
                  {i + 1}
                </button>
                <span className="stop-pts" aria-hidden="true">{q.play.state === "done" ? q.points : ""}</span>
              </li>
            );
          })}
          <li>
            <button type="button" className="stop stop-end" onClick={() => setView({ kind: "end" })}
                    data-state={cur === null ? "done" : "not_started"}
                    aria-current={view.kind === "end" ? "step" : undefined} aria-label="Results">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4h11l-1.5 3.5L16 11H7v10z" fill="currentColor" /></svg>
            </button>
            <span className="stop-pts" aria-hidden="true">end</span>
          </li>
        </ol>
      </nav>

      {error && (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>OK</button>
        </div>
      )}

      {dq && (
        <section key={dq.idx} aria-label={`Question ${position}`}>
          {dq.play.state === "not_started" && (
            <div className="card start-card">
              {position === 1 && doneCount === 0 ? (
                <>
                  <span className="family">Today&apos;s expedition · 6 questions</span>
                  <h2 className="welcome-title">Think of the answer <em>nobody else will.</em></h2>
                  <p>One right answer per question. Common answers score a little; rare ones score a lot.</p>
                  <div className="tier-ladder" aria-hidden="true">
                    {TIERS.map((t, i) => (
                      <span key={t.tier} style={{ "--tier": `var(--t-${t.tier})`, "--r": `${(i % 2 ? 1 : -1) * (2 + i)}deg` } as CSSProperties}>
                        {t.label} <b>{t.points}</b>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <span className="qnum">{String(position).padStart(2, "0")}</span>
                  <span className="family">{dq.family}</span>
                  <p>
                    {dq.kind === "match" ? "Matching round: pair up four items."
                      : dq.kind === "order" ? "Ordering round: put five items in order."
                      : dq.difficulty >= 3 ? "The hard one. Dig deep." : "Ready when you are."}
                  </p>
                </>
              )}
              <div className="seconds" style={{ marginBottom: "1rem" }}>⏱ {dq.play.seconds} seconds</div>
              <button type="button" className="btn btn-big" autoFocus onClick={() => start(daily.date, dq.idx)}>
                Start question {position}
              </button>
              <span className="dashes" aria-hidden="true" />
            </div>
          )}

          {dq.play.state === "playing" && !st && (
            <div className="card"><div className="skeleton" style={{ width: "70%", height: "2rem" }} /></div>
          )}
          {dq.play.state === "playing" && st && question && (() => {
            const common = {
              date: daily.date, question, deadline: st.play.deadline!, seconds: st.play.seconds, offsetMs,
              head: (timer: ReactNode) => head(dq, timer),
              onDone: (s: Summary) => markDone(dq.idx, s, true),
            };
            if (question.kind === "match") return <MatchPlay {...common} />;
            if (question.kind === "order") return <OrderPlay {...common} />;
            return <TextPlay {...common} initial={st.answers} onEnd={() => end(daily.date, dq.idx, true)} />;
          })()}

          {dq.play.state === "done" && (
            summary && question ? (
              <SummaryView question={question} summary={summary} fresh={fresh.has(dq.idx)} head={head(dq)}>
                <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="btn btn-big" onClick={goNext} autoFocus>
                    {cur === null ? "See results" : "Next question"} →
                  </button>
                </div>
              </SummaryView>
            ) : (
              <div className="card">
                {head(dq)}
                <div className="skeleton" style={{ width: "80%", height: "1.6rem" }} />
                <div className="skeleton" style={{ width: "50%", marginTop: "1rem" }} />
              </div>
            )
          )}
        </section>
      )}

      {view.kind === "end" && (
        <EndScreen date={daily.date} local={local} remaining={daily.questions.length - doneCount}
                   onResume={() => { if (cur !== null) setView({ kind: "question", idx: cur }); }} />
      )}

      {rules && <HowToPlay onClose={() => setRules(false)} />}
    </Shell>
  );
}

function Shell({ children, onHelp, date, total }: {
  children: ReactNode; onHelp?: () => void; date?: string; total?: number;
}) {
  return (
    <main className="page">
      <header className="masthead">
        <h1 className="wordmark" aria-label="Geo-rarity">
          <span className="geo">Geo</span><Compass /><span className="rarity">rarity</span>
        </h1>
        <div className="masthead-right">
          {date && <div className="dateline">{dateline(date)}<br />daily puzzle</div>}
          {total !== undefined && (
            <div className="scorebox" aria-label={`${total} points`}>
              <b><CountUp value={total} /></b><small>points</small>
            </div>
          )}
          {onHelp && <button type="button" className="icon-btn" onClick={onHelp} aria-label="How to play">?</button>}
        </div>
      </header>
      {children}
      <footer className="footer">Same six questions for everyone, every day · new puzzle at 00:00 UTC</footer>
    </main>
  );
}
