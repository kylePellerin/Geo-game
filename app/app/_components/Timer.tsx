"use client";
/** Countdown on the server's clock. Calls onExpire once when it reaches zero. */
import { useEffect, useRef, useState } from "react";
import { remainingMs } from "@/lib/client/state";

export function useCountdown(deadline: string, offsetMs: number, onExpire: () => void): number {
  const [left, setLeft] = useState(() => remainingMs(deadline, offsetMs, Date.now()));
  const fired = useRef(false);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const ms = remainingMs(deadline, offsetMs, Date.now());
      setLeft(ms);
      if (ms <= 0 && !fired.current) {
        fired.current = true;
        expire.current();
      }
    };
    tick();
    const t = setInterval(tick, 100);
    return () => clearInterval(t);
  }, [deadline, offsetMs]);
  return left;
}

/** A ring that empties as time runs out; red and ticking for the last five seconds. */
export function TimerDisplay({ ms, seconds }: { ms: number; seconds: number }) {
  const s = Math.ceil(ms / 1000);
  const r = 16;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, ms / (seconds * 1000)));
  return (
    <div className="timer" data-low={s <= 5} role="timer" aria-label={`${s} seconds left`}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle className="track" cx="20" cy="20" r={r} fill="none" strokeWidth="4" />
        <circle className="arc" cx="20" cy="20" r={r} fill="none" strokeWidth="4"
                strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span aria-hidden="true">{s}</span>
    </div>
  );
}
