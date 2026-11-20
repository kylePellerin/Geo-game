"use client";
/** A timed ordering round: put the items in order with the arrows. Auto-submits at time up. */
import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { moveItem } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { TimerDisplay, useCountdown } from "./Timer";

export function OrderPlay({ date, question, deadline, seconds, offsetMs, onDone }: {
  date: string; question: Question; deadline: string; seconds: number; offsetMs: number;
  onDone: (s: Summary) => void;
}) {
  const items = question.items ?? [];
  const [order, setOrder] = useState<number[]>(items.map((it) => it.pos));
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;

  async function submit() {
    if (sent.current) return;
    sent.current = true;
    try {
      onDone(await api<Summary>("/api/answer", { date, idx: question.idx, order: orderRef.current }));
    } catch (e) {
      sent.current = false;
      setError((e as Error).message);
    }
  }
  const ms = useCountdown(deadline, offsetMs, submit);
  const label = (pos: number) => items.find((it) => it.pos === pos)?.label ?? "?";

  return (
    <div>
      <p><strong>{question.text}</strong></p>
      <TimerDisplay ms={ms} seconds={seconds} />
      <ol>
        {order.map((pos, i) => (
          <li key={pos}>
            {label(pos)}{" "}
            <button type="button" aria-label={`Move ${label(pos)} up`} disabled={i === 0 || ms <= 0}
                    onClick={() => setOrder(moveItem(order, i, i - 1))}>↑</button>
            <button type="button" aria-label={`Move ${label(pos)} down`}
                    disabled={i === order.length - 1 || ms <= 0}
                    onClick={() => setOrder(moveItem(order, i, i + 1))}>↓</button>
          </li>
        ))}
      </ol>
      <p><button type="button" onClick={submit} disabled={ms <= 0}>Submit order</button></p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
