"use client";
/** A free-text question: type a place, handle "did you mean", then show the result. */
import { useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { formatShare, TIER_LABEL, withArticle } from "@/lib/client/state";
import type { AnswerResponse, Named, Question } from "@/lib/client/types";

interface Props {
  date: string;
  question: Question;
  result?: AnswerResponse;
  answered: boolean;
  onFinal: (idx: number, r: AnswerResponse) => void;
}

export function TextQuestion({ date, question, result, answered, onFinal }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AnswerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(confirm?: Named) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<AnswerResponse>("/api/answer", {
        date, idx: question.idx, text, ...(confirm ? { confirm_entity_id: confirm.id } : {}),
      });
      if (r.final) {
        setPending(null);
        onFinal(question.idx, r);
      } else {
        setPending(r);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) void send();
  }

  return (
    <div>
      <p><strong>{question.text}</strong></p>

      {!answered && (
        <form onSubmit={onSubmit}>
          <label>
            Your answer{" "}
            <input value={text} onChange={(e) => { setText(e.target.value); setPending(null); }}
                   autoFocus autoComplete="off" autoCorrect="off" spellCheck={false}
                   disabled={busy || pending?.status === "did_you_mean"} maxLength={120} />
          </label>{" "}
          <button type="submit" disabled={busy || !text.trim() || pending?.status === "did_you_mean"}>
            Submit
          </button>
        </form>
      )}

      {!answered && pending?.status === "did_you_mean" && (
        <DidYouMean pending={pending} busy={busy} onConfirm={send}
                    onRetype={() => { setPending(null); setText(""); }} />
      )}

      {!answered && pending?.status === "unrecognised" && (
        <p role="status">
          {pending.other_type
            ? `That looks like ${withArticle(pending.other_type)}. This question wants ${withArticle(question.answerType)}.`
            : "We don't recognise that place. Check the spelling, or try another."}{" "}
          {pending.attempts_left !== undefined &&
            `${pending.attempts_left} ${pending.attempts_left === 1 ? "try" : "tries"} left before it counts as 0.`}
        </p>
      )}

      {error && <p role="alert">{error}</p>}
      {answered && !result && <p>Loading your answer…</p>}
      {result && <TextResult r={result} />}
    </div>
  );
}

function DidYouMean({ pending, busy, onConfirm, onRetype }: {
  pending: AnswerResponse; busy: boolean; onConfirm: (e: Named) => void; onRetype: () => void;
}) {
  const options = [pending.suggestion, pending.alternative].filter((x): x is Named => !!x);
  return (
    <div role="status">
      <p>Did you mean…</p>
      {options.map((o) => (
        <button key={o.id} type="button" disabled={busy} onClick={() => onConfirm(o)}>{o.name}</button>
      ))}{" "}
      <button type="button" disabled={busy} onClick={onRetype}>No, let me retype</button>
      <p><small>This doesn&apos;t use up your answer.</small></p>
    </div>
  );
}

function TextResult({ r }: { r: AnswerResponse }) {
  const name = r.entity ? `${r.entity.name}${r.entity.partOf ? ` (${r.entity.partOf})` : ""}` : null;
  return (
    <div role="status">
      {r.status === "valid" && (
        <p>
          ✓ <strong>{name}</strong> is right! {r.tier && TIER_LABEL[r.tier]} answer:{" "}
          <strong>{r.points} points</strong>
          {r.share !== undefined && <> · about {formatShare(r.share)} of players give this answer</>}
        </p>
      )}
      {r.status === "real_but_wrong" && <p>✗ <strong>{name}</strong> isn&apos;t a right answer. 0 points.</p>}
      {r.status === "unrecognised" && <p>✗ We couldn&apos;t recognise that answer. 0 points.</p>}
      <AnswerList title="Most common answers" items={r.common_answers} />
      <AnswerList title="Some rare answers" items={r.rare_answers} />
    </div>
  );
}

function AnswerList({ title, items }: { title: string; items?: Named[] }) {
  if (!items?.length) return null;
  return <p>{title}: {items.map((i) => i.name).join(", ")}</p>;
}
