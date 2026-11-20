"use client";
/** A timed matching round: pair each left item with one right item. Auto-submits at time up. */
import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { assignPair, pairsComplete } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { TimerDisplay, useCountdown } from "./Timer";

export function LeftItem({ item, n }: { item: { label?: string; image?: string }; n: number }) {
  return item.image
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={item.image} alt={`Picture ${n}`} width={96} height={item.image.includes("/outline/") ? 96 : 72}
           style={{ border: "1px solid #999", objectFit: "contain" }} />
    : <>{item.label}</>;
}

export function MatchPlay({ date, question, deadline, seconds, offsetMs, onDone }: {
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  onDone: (s: Summary) => void;
}) {
  const left = question.left ?? [];
  const right = question.right ?? [];
  const [pairs, setPairs] = useState<(number | null)[]>(left.map(() => null));
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;

  async function submit() {
    if (sent.current) return;
    sent.current = true;
    try {
      onDone(await api<Summary>("/api/answer", {
        date, idx: question.idx, pairs: pairsRef.current.map((p) => p ?? -1),
      }));
    } catch (e) {
      sent.current = false;
      setError((e as Error).message);
    }
  }
  const ms = useCountdown(deadline, offsetMs, submit);

  return (
    <div>
      <p><strong>{question.text}</strong></p>
      <TimerDisplay ms={ms} seconds={seconds} />
      <p><small>Each answer on the right is used once. Rarer items are worth more.</small></p>
      <table>
        <tbody>
          {left.map((l, i) => (
            <tr key={l.pos}>
              <td><LeftItem item={l} n={i + 1} /></td>
              <td>→</td>
              <td>
                <select aria-label={l.label ? `Match for ${l.label}` : `Match for picture ${i + 1}`}
                        value={pairs[i] ?? ""} disabled={ms <= 0}
                        onChange={(e) => setPairs(assignPair(pairs, i, e.target.value === "" ? null : Number(e.target.value)))}>
                  <option value="">— choose —</option>
                  {right.map((r) => (
                    <option key={r.pos} value={r.pos}>
                      {r.label}{pairs.includes(r.pos) && pairs[i] !== r.pos ? " (used)" : ""}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button type="button" onClick={submit} disabled={ms <= 0}>
          {pairsComplete(pairs) ? "Submit pairs" : "Submit (unpaired count as wrong)"}
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
