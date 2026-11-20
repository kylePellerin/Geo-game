"use client";
/** Small shared pieces of the look: stamps, the compass mark, confetti, a counting number. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TIER_LABEL } from "@/lib/client/state";
import type { Tier } from "@/lib/client/types";

export const tierColor = (t?: Tier | "wrong") => (t && t !== "wrong" ? `var(--t-${t})` : "#8c8478");

/** Rotation that's stable per key, so stamps don't wobble on every render. */
export function tilt(key: string | number, spread = 9): string {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${((Math.abs(h) % 1000) / 1000 - 0.5) * 2 * spread}deg`;
}

export function Stamp({ tier, points, label, big, round, slam, rotate, className = "" }: {
  tier?: Tier | "wrong"; points?: number | string; label?: string; big?: boolean; round?: boolean;
  slam?: boolean; rotate?: string; className?: string;
}) {
  const name = label ?? (tier && tier !== "wrong" ? TIER_LABEL[tier] : "Missed");
  return (
    <span className={`stamp ${big ? "big" : ""} ${round ? "round" : ""} ${slam ? "slam" : ""} ${className}`}
          style={{ "--c": tierColor(tier), "--rot": rotate ?? "-7deg" } as CSSProperties}>
      <span className="tier-name">{name}</span>
      {points !== undefined && <span className="tier-pts">{typeof points === "number" ? `+${points}` : points}</span>}
    </span>
  );
}

export function Compass({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.5" />
      <path d="M20 4 L25 20 L20 17 L15 20 Z" fill="#d9472b" />
      <path d="M20 36 L15 20 L20 23 L25 20 Z" fill="#f4ecda" />
      <circle cx="20" cy="20" r="2.6" fill="#0d1a29" stroke="#f4ecda" strokeWidth="1.2" />
    </svg>
  );
}

/** A confetti burst of little paper scraps, for rare finds. */
export function Burst({ tier, count = 26 }: { tier: Tier; count?: number }) {
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 140 + Math.random() * 220;
    const colors = [tierColor(tier), "var(--gold)", "var(--paper)", "var(--sky)"];
    return {
      "--x": `${Math.cos(angle) * dist}px`, "--y": `${Math.sin(angle) * dist + 120}px`,
      "--r": `${Math.random() * 720 - 360}deg`, "--c": colors[i % colors.length],
      animationDelay: `${Math.random() * 0.08}s`,
    } as CSSProperties;
  }), [tier, count]);
  return (
    <>
      <div className="flash" aria-hidden="true" />
      <div className="burst" aria-hidden="true">{bits.map((s, i) => <i key={i} style={s} />)}</div>
    </>
  );
}

/** A number that counts up to its value when it changes. */
export function CountUp({ value, ms = 700 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === value) return;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value, ms]);
  return <>{shown}</>;
}

export function Difficulty({ level }: { level: number }) {
  return (
    <span className="difficulty" aria-label={`Difficulty ${level} of 3`}>
      {[1, 2, 3].map((n) => <i key={n} className={n <= level ? "on" : ""} />)}
    </span>
  );
}
