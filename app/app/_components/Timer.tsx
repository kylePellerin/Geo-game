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

const SEGMENTS = 10;

/** A pixel fuel gauge that empties as time runs out; red and blinking for the last five seconds. */
export function TimerDisplay({ ms, seconds }: { ms: number; seconds: number }) {
  const s = Math.ceil(ms / 1000);
  const frac = Math.max(0, Math.min(1, ms / (seconds * 1000)));
  const lit = Math.ceil(frac * SEGMENTS);
  return (
    <div className="timer" data-low={s <= 5} role="timer" aria-label={`${s} seconds left`}>
      <span className="timer-num" aria-hidden="true">{s}</span>
      <span className="timer-bar" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => <i key={i} className={i < lit ? "on" : ""} />)}
      </span>
    </div>
  );
}
