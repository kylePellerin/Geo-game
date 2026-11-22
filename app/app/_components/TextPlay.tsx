"use client";
/**
 * A timed free-text question. One correct answer: a wrong place can be retried, the first right
 * one is final and ends the question. Spelling corrections come back as "did you mean" and only
 * count once confirmed.
 */
import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { addGuess, pinFor } from "@/lib/client/flightlog";
import { withArticle } from "@/lib/client/state";
import type { AnswerResponse, GivenAnswer, Named, Question, Summary } from "@/lib/client/types";
import { MiniMap } from "./MiniMap";
import { TimerDisplay, useCountdown } from "./Timer";

interface Suggestion { raw: string; options: Named[] }

export function TextPlay({ date, question, deadline, seconds, offsetMs, initial, onEnd, onDone, head }: {
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  initial: GivenAnswer[]; onEnd: () => void; onDone: (s: Summary) => void;
  head: (timer: React.ReactNode) => React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState<GivenAnswer[]>(initial.filter((a) => a.status !== "valid"));
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [note, setNote] = useState<React.ReactNode>(null);
  const [shaking, setShaking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const left = useCountdown(deadline, offsetMs, onEnd);

  async function send(raw: string, confirm?: Named) {
    try {
      const r = await api<AnswerResponse>("/api/answer", {
        date, idx: question.idx, text: raw, ...(confirm ? { confirm_entity_id: confirm.id } : {}),
      });
      if ((r.status === "valid" || r.status === "real_but_wrong") && r.entity) {
        const pin = pinFor(question.idx, r.entity, r.status === "valid");
        if (pin) addGuess(pin);
      }
      if (r.status === "valid" && r.summary) {
        onDone(r.summary);
        return;
      }
      if (r.status === "real_but_wrong") {
        setTried((t) => [...t, { entity: r.entity!, status: "real_but_wrong", points: 0 }]);
        const e = r.entity!;
        // territories are only "not countries" where the question doesn't accept them (no hint)
        setNote(e.territoryOf && !question.hint
          ? <><b>{e.name}</b> is a territory{e.territoryOf !== "no country" ? <> of {e.territoryOf}</> : null}, and this one is countries only. Try again!</>
          : <><b>{e.name}</b>{e.partOf ? ` (${e.partOf})` : ""} doesn&apos;t fit. Try again!</>);
        shake();
      } else if (r.status === "duplicate") {
        setNote(<>You already tried <b>{r.entity?.name}</b>.</>);
      } else if (r.status === "did_you_mean") {
        setSuggestion({ raw, options: [r.suggestion, r.alternative].filter((x): x is Named => !!x) });
        setNote(null);
      } else {
        setNote(r.otherType
          ? <>“{raw}” is {withArticle(r.otherType)}; this one wants {withArticle(question.answerType)}.</>
          : <>“{raw}”: not recognised. Check the spelling?</>);
        shake();
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      input.current?.focus();
    }
  }

  function shake() {
    setShaking(false);
    requestAnimationFrame(() => setShaking(true));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = text.trim();
    if (!raw || left <= 0) return;
    setText("");
    setSuggestion(null);
    void send(raw);
  }

  function confirm(o: Named) {
    const s = suggestion!;
    setSuggestion(null);
    void send(s.raw, o);
  }

  return (
    <div className={shaking ? "shake" : ""} onAnimationEnd={(e) => {
      if (e.target === e.currentTarget) setShaking(false);
    }}>
    <div className="card">
      {head(<TimerDisplay ms={left} seconds={seconds} />)}
      <h2 className="question-text">{question.text}</h2>
      {question.hint && <p className="question-hint">{question.hint}</p>}
      <form className="answer-form" onSubmit={onSubmit}>
        <label htmlFor="answer" className="sr-only">Answer</label>
        <input id="answer" ref={input} className="answer-input" value={text}
               onChange={(e) => setText(e.target.value)} autoFocus placeholder="Type a place…"
               autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck={false}
               maxLength={120} disabled={left <= 0} enterKeyHint="go" />
        <button type="submit" className="btn" disabled={!text.trim() || left <= 0}>
          Answer
        </button>
      </form>
      <MiniMap />
      {suggestion && (
        <div className="dym" role="status">
          <span>“{suggestion.raw}”: did you mean</span>
          {suggestion.options.map((o) => (
            <button key={o.id} type="button" className="chip" onClick={() => confirm(o)}>{o.name}?</button>
          ))}
          <button type="button" className="chip no" onClick={() => { setSuggestion(null); input.current?.focus(); }}>No</button>
        </div>
      )}
      {note && <p className="note" role="status">{note}</p>}
      {tried.length > 0 && (
        <>
          <div className="tried-label">Tried</div>
          <ul className="tried" aria-label="Tried so far">
            {tried.map((a) => <li key={a.entity.id}>{a.entity.name}</li>)}
          </ul>
        </>
      )}
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="hint" style={{ margin: 0 }}>One right answer counts: the rarer, the better.</p>
        <button type="button" className="btn btn-ghost" onClick={onEnd}>Skip</button>
      </div>
    </div>
    </div>
  );
}
