"use client";
/** A matching round: pair each left item with one right item, then see which pairs were right. */
import { useState } from "react";
import { api } from "@/lib/client/api";
import { assignPair, pairsComplete } from "@/lib/client/state";
import type { AnswerResponse, Question } from "@/lib/client/types";

interface Props {
  date: string;
  question: Question;
  result?: AnswerResponse;
  answered: boolean;
  onFinal: (idx: number, r: AnswerResponse) => void;
}

export function MatchQuestion({ date, question, result, answered, onFinal }: Props) {
  const left = question.left ?? [];
  const right = question.right ?? [];
  const [pairs, setPairs] = useState<(number | null)[]>(left.map(() => null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!pairsComplete(pairs)) return;
    setBusy(true);
    setError(null);
    try {
      onFinal(question.idx, await api<AnswerResponse>("/api/answer", { date, idx: question.idx, pairs }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (pos: number | null | undefined) =>
    pos === null || pos === undefined ? "—" : right.find((r) => r.pos === pos)?.label ?? "?";
  const done = answered || !!result;

  return (
    <div>
      <p><strong>{question.text}</strong></p>
      <p><small>Each answer on the right is used once.</small></p>
      <table>
        <tbody>
          {left.map((l, i) => {
            const correct = result?.correct?.[i];
            return (
              <tr key={l.pos}>
                <td>
                  {l.image
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={l.image} alt={`Flag ${i + 1}`} width={96} height={72} style={{ border: "1px solid #999" }} />
                    : l.label}
                </td>
                <td>→</td>
                <td>
                  {done ? (
                    result ? (
                      <>
                        {correct ? "✓" : "✗"} {correct ? labelOf(result.solution?.[i]) : (
                          <>{pairs[i] !== null && <s>{labelOf(pairs[i])}</s>} {labelOf(result.solution?.[i])}</>
                        )}
                      </>
                    ) : "…"
                  ) : (
                    <select
                      aria-label={l.label ? `Match for ${l.label}` : `Match for flag ${i + 1}`}
                      value={pairs[i] ?? ""}
                      onChange={(e) => setPairs(assignPair(pairs, i, e.target.value === "" ? null : Number(e.target.value)))}
                      disabled={busy}
                    >
                      <option value="">— choose —</option>
                      {right.map((r) => (
                        <option key={r.pos} value={r.pos}>
                          {r.label}{pairs.includes(r.pos) && pairs[i] !== r.pos ? " (used)" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!done && (
        <p>
          <button type="button" onClick={submit} disabled={busy || !pairsComplete(pairs)}>Submit pairs</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          {(result.correct ?? []).filter(Boolean).length} of {left.length} right:{" "}
          <strong>{result.points} points</strong>
          <br /><small>Rarer items are worth more per correct pair.</small>
        </p>
      )}
    </div>
  );
}
