"use client";
/** A timed ordering round: put the items in order with the arrows. Auto-submits at time up. */
import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { moveItem } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { TimerDisplay, useCountdown } from "./Timer";

export function OrderPlay({ date, question, deadline, seconds, offsetMs, onDone, head, answerUrl = "/api/answer" }: {
  answerUrl?: string;
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  onDone: (s: Summary) => void; head: (timer: React.ReactNode) => React.ReactNode;
}) {
  const items = question.items ?? [];
  const [order, setOrder] = useState<number[]>(items.map((it) => it.pos));
  const [moved, setMoved] = useState<{ pos: number; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;

  async function submit() {
    if (sent.current) return;
    sent.current = true;
    try {
      onDone(await api<Summary>(answerUrl, { date, idx: question.idx, order: orderRef.current }));
    } catch (e) {
      sent.current = false;
      setError((e as Error).message);
    }
  }
  const ms = useCountdown(deadline, offsetMs, submit);
  const over = ms <= 0;
  const label = (pos: number) => items.find((it) => it.pos === pos)?.label ?? "?";
  const move = (i: number, to: number) => {
    setOrder(moveItem(order, i, to));
    setMoved({ pos: order[i], n: (moved?.n ?? 0) + 1 });
  };
  const [top, bottom] = ends(question.text);

  return (
    <div className="card">
      {head(<TimerDisplay ms={ms} seconds={seconds} />)}
      <h2 className="question-text">{question.text}</h2>
      <div className="order-ends" aria-hidden="true"><span>{top}</span></div>
      <ol className="order-list">
        {order.map((pos, i) => (
          <li key={moved?.pos === pos ? `${pos}-${moved.n}` : pos}
              className={`order-item ${moved?.pos === pos ? "moved" : ""}`}>
            <span className="rank" aria-hidden="true">{i + 1}</span>
            <span className="label">{label(pos)}</span>
            <span className="arrows">
              <button type="button" className="arrow" aria-label={`Move ${label(pos)} up`}
                      disabled={i === 0 || over} onClick={() => move(i, i - 1)}>▲</button>
              <button type="button" className="arrow" aria-label={`Move ${label(pos)} down`}
                      disabled={i === order.length - 1 || over} onClick={() => move(i, i + 1)}>▼</button>
            </span>
          </li>
        ))}
      </ol>
      <div className="order-ends" aria-hidden="true" style={{ marginTop: "0.45rem", justifyContent: "flex-end" }}>
        <span>{bottom}</span>
      </div>
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={submit} disabled={over}>Submit order</button>
      </div>
      {error && <p className="note" role="alert">{error}</p>}
    </div>
  );
}

/** Top/bottom captions from the question text ("…, largest first"). */
export function ends(text: string): [string, string] {
  const m = /,\s*([a-z ]+?) first\s*$/i.exec(text.trim());
  if (!m) return ["▲ first", "last ▼"];
  const first = m[1].toLowerCase();
  const opposite: Record<string, string> = {
    largest: "smallest", smallest: "largest", biggest: "smallest", longest: "shortest",
    shortest: "longest", highest: "lowest", lowest: "highest", tallest: "shortest",
    closest: "furthest", nearest: "furthest", furthest: "closest", "most recent": "longest ago",
    "most": "fewest", oldest: "newest", newest: "oldest", busiest: "quietest",
  };
  return [`▲ ${first}`, `${opposite[first] ?? "last"} ▼`];
}
