"use client";
/**
 * A timed free-text question: type as many answers as you can before the clock runs out.
 * Spelling corrections come back as "did you mean" and only count once confirmed.
 */
import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { formatShare, TIER_LABEL, withArticle } from "@/lib/client/state";
import type { AnswerResponse, GivenAnswer, Named, Question } from "@/lib/client/types";
import { TimerDisplay, useCountdown } from "./Timer";

interface Suggestion { raw: string; options: Named[] }

export function GivenList({ answers }: { answers: GivenAnswer[] }) {
  if (!answers.length) return null;
  return (
    <ul>
      {answers.map((a) => (
        <li key={a.entity.id}>
          {a.status === "valid" ? "✓" : "✗"} {a.entity.name}
          {a.entity.partOf ? ` (${a.entity.partOf})` : ""}
          {a.status === "valid"
            ? <> · <strong>{a.points}</strong> {a.tier && `· ${TIER_LABEL[a.tier]}`}
                {a.share !== undefined && ` · about ${formatShare(a.share)} of answers`}</>
            : " · not a right answer"}
        </li>
      ))}
    </ul>
  );
}

export function TextPlay({ date, question, deadline, seconds, offsetMs, initial, onEnd }: {
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  initial: GivenAnswer[]; onEnd: () => void;
}) {
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<GivenAnswer[]>(initial);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const left = useCountdown(deadline, offsetMs, onEnd);
  const total = answers.reduce((s, a) => s + a.points, 0);

  async function send(raw: string, confirm?: Named) {
    try {
      const r = await api<AnswerResponse>("/api/answer", {
        date, idx: question.idx, text: raw, ...(confirm ? { confirm_entity_id: confirm.id } : {}),
      });
      if (r.status === "valid" || r.status === "real_but_wrong") {
        setAnswers((a) => [...a, { entity: r.entity!, status: r.status as GivenAnswer["status"],
                                    points: r.points, tier: r.tier, share: r.share }]);
        setNote(null);
      } else if (r.status === "duplicate") {
        setNote(`You already said ${r.entity?.name}.`);
      } else if (r.status === "did_you_mean") {
        const options = [r.suggestion, r.alternative].filter((x): x is Named => !!x);
        setSuggestions((s) => [...s.filter((x) => x.raw !== raw), { raw, options }]);
      } else {
        setNote(r.otherType
          ? `“${raw}” is ${withArticle(r.otherType)}; this question wants ${withArticle(question.answerType)}.`
          : `“${raw}”: not recognised.`);
      }
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = text.trim();
    if (!raw || left <= 0) return;
    setText("");
    input.current?.focus();
    void send(raw);
  }

  function confirm(s: Suggestion, o: Named) {
    setSuggestions((all) => all.filter((x) => x !== s));
    void send(s.raw, o);
    input.current?.focus();
  }

  return (
    <div>
      <p><strong>{question.text}</strong></p>
      <TimerDisplay ms={left} seconds={seconds} />
      <form onSubmit={onSubmit}>
        <label>
          Answer{" "}
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} autoFocus
                 autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={120}
                 disabled={left <= 0} />
        </label>{" "}
        <button type="submit" disabled={!text.trim() || left <= 0}>Enter</button>{" "}
        <button type="button" onClick={onEnd}>I&apos;m done</button>
      </form>
      <p><small>Give as many answers as you can. Rarer right answers score more.</small></p>
      {suggestions.map((s) => (
        <p key={s.raw} role="status">
          “{s.raw}”: did you mean{" "}
          {s.options.map((o) => (
            <button key={o.id} type="button" onClick={() => confirm(s, o)}>{o.name}?</button>
          ))}{" "}
          <button type="button" onClick={() => setSuggestions((all) => all.filter((x) => x !== s))}>No</button>
        </p>
      ))}
      {note && <p role="status">{note}</p>}
      <GivenList answers={answers} />
      <p>Points so far: <strong>{total}</strong></p>
    </div>
  );
}
