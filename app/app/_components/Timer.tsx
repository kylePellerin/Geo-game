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
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [deadline, offsetMs]);
  return left;
}

export function TimerDisplay({ ms, seconds }: { ms: number; seconds: number }) {
  const s = Math.ceil(ms / 1000);
  return (
    <p aria-live="off">
      <strong>⏱ {s}s</strong>{" "}
      <progress value={ms} max={seconds * 1000} style={{ width: "10em", verticalAlign: "middle" }} />
    </p>
  );
}
