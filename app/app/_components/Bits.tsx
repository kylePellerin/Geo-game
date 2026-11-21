"use client";
/** Small shared pieces of the look: tier badges, pixel sprites, confetti, a counting number. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TIER_LABEL } from "@/lib/client/state";
import type { Tier } from "@/lib/client/types";

export const tierColor = (t?: Tier | "wrong") => (t && t !== "wrong" ? `var(--t-${t})` : "var(--t-wrong)");

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

/** Pixel art as an SVG: one char per pixel, runs merged into rects, crisp at any size. */
export function PixelArt({ rows, palette, className, title }: {
  rows: string[]; palette: Record<string, string>; className?: string; title?: string;
}) {
  const rects: React.ReactNode[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let n = 1;
      while (row[x + n] === ch) n++;
      if (ch !== "." && palette[ch]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={n} height={1} fill={palette[ch]} />);
      x += n;
    }
  });
  return (
    <svg viewBox={`0 0 ${rows[0].length} ${rows.length}`} className={className} shapeRendering="crispEdges"
         role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {rects}
    </svg>
  );
}

const GLOBE = [
  "....kkkkk....",
  "..kkbbggbkk..",
  ".kbbgggbbbbk.",
  ".kbggggbbgbk.",
  "kbbbgggbbggbk",
  "kbbbbgbbgggbk",
  "kbbbbbbbgggbk",
  "kbbggbbbbgbbk",
  "kbgggggbbbbbk",
  ".kbggggbbbbk.",
  ".kbbgggbbbwk.",
  "..kkbbbbbkk..",
  "....kkkkk....",
];
const GLOBE_PAL = { k: "#140d1f", b: "#3b82f6", g: "#4ade80", w: "#bfe1ff" };

export function Globe({ className }: { className?: string }) {
  return <PixelArt rows={GLOBE} palette={GLOBE_PAL} className={`globe ${className ?? ""}`} />;
}

const PLANE_ICON = [
  ".....kk.....",
  ".....kwk....",
  "kk....kwk...",
  "kwk...kwwk..",
  "kkwkkkkwwwkk",
  "kwrrrrrrrwbk",
  "kkwkkkkwwwkk",
  "kwk...kwwk..",
  "kk....kwk...",
  ".....kwk....",
  ".....kk.....",
];
export function PlaneIcon({ className }: { className?: string }) {
  return <PixelArt rows={PLANE_ICON} palette={{ k: "#140d1f", w: "#fff7e0", r: "#ff5a5f", b: "#58a6ff" }} className={className} />;
}

const FLAG_ICON = [
  "kkkkkkkk.",
  "kryryryk.",
  "kyryryrk.",
  "kryryryk.",
  "kkkkkkkk.",
  "k........",
  "k........",
  "k........",
  "kk.......",
];
export function FlagIcon({ className }: { className?: string }) {
  return <PixelArt rows={FLAG_ICON} palette={{ k: "#140d1f", r: "#ff5a5f", y: "#fff7e0" }} className={className} />;
}

/** A burst of square pixel confetti, for rare finds. */
export function Burst({ tier, count = 26 }: { tier: Tier; count?: number }) {
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 140 + Math.random() * 220;
    const colors = [tierColor(tier), "var(--gold)", "var(--paper)", "var(--sky)", "var(--green)"];
    return {
      "--x": `${Math.cos(angle) * dist}px`, "--y": `${Math.sin(angle) * dist + 120}px`,
      "--s": `${[6, 8, 10, 12][i % 4]}px`, "--c": colors[i % colors.length],
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
