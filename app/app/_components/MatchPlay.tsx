"use client";
/**
 * A timed matching round: tap an item on the left, then its partner on the right. Pairs share a
 * coloured pin. Auto-submits at time up (unpaired items count as wrong).
 */
import { useRef, useState, type CSSProperties } from "react";
import { api } from "@/lib/client/api";
import { assignPair, pairsComplete } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { TimerDisplay, useCountdown } from "./Timer";

export const PIN_COLORS = ["#ff5a5f", "#2f74d0", "#1f9d6e", "#f08a00", "#8b4fe0", "#6e5f4b"];
export const PIN_LETTERS = "ABCDEF";

export function LeftItem({ item, n }: { item: { label?: string; image?: string; picture?: string }; n: number }) {
  if (!item.image) return <span>{item.label}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={item.image} alt={`Picture ${n}`} className={item.picture ?? ""} />;
}

export function Pin({ i, on = true }: { i: number | null; on?: boolean }) {
  return (
    <span className="pin" aria-hidden="true"
          style={i !== null && on ? { "--pc": PIN_COLORS[i] } as CSSProperties : undefined}>
      {i !== null && on ? PIN_LETTERS[i] : ""}
    </span>
  );
}

export function MatchPlay({ date, question, deadline, seconds, offsetMs, onDone, head }: {
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  onDone: (s: Summary) => void; head: (timer: React.ReactNode) => React.ReactNode;
}) {
  const left = question.left ?? [];
  const right = question.right ?? [];
  const [pairs, setPairs] = useState<(number | null)[]>(left.map(() => null));
  const [selected, setSelected] = useState<number | null>(0);
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
  const over = ms <= 0;

  function pickRight(pos: number) {
    const owner = pairs.indexOf(pos);
    const target = selected ?? pairs.findIndex((p) => p === null);
    if (target < 0) {
      // everything paired and nothing selected: tapping a right item frees it
      if (owner >= 0) { setPairs(assignPair(pairs, owner, null)); setSelected(owner); }
      return;
    }
    const next = owner === target ? assignPair(pairs, target, null) : assignPair(pairs, target, pos);
    setPairs(next);
    const free = next.findIndex((p, i) => p === null && i !== target);
    setSelected(owner === target ? target : free >= 0 ? free : null);
  }

  return (
    <div className="card">
      {head(<TimerDisplay ms={ms} seconds={seconds} />)}
      <h2 className="question-text">{question.text}</h2>
      <div className="match-grid">
        <div className="match-col">
          {left.map((l, i) => (
            <button key={l.pos} type="button" className="tile" aria-pressed={selected === i}
                    data-paired={pairs[i] !== null} disabled={over}
                    aria-label={`Item ${i + 1}${l.label ? `: ${l.label}` : ""}`}
                    onClick={() => setSelected(selected === i ? null : i)}>
              <Pin i={i} />
              <LeftItem item={l} n={i + 1} />
            </button>
          ))}
        </div>
        <div className="match-col">
          {right.map((r) => {
            const owner = pairs.indexOf(r.pos);
            return (
              <button key={r.pos} type="button" className="tile right" data-paired={owner >= 0}
                      disabled={over} aria-label={r.label} onClick={() => pickRight(r.pos)}>
                <span>{r.label}</span>
                <Pin i={owner >= 0 ? owner : null} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="hint" style={{ margin: 0 }}>Tap an item, then its match.{right.length > left.length ? <> {right.length - left.length === 1 ? "One option matches" : `${right.length - left.length} options match`} nothing.</> : null} Rarer items are worth more.</p>
        <button type="button" className="btn" onClick={submit} disabled={over}>
          {pairsComplete(pairs) ? "Submit pairs" : "Submit anyway"}
        </button>
      </div>
      {error && <p className="note" role="alert">{error}</p>}
    </div>
  );
}
