"use client";
/**
 * The moving background: topographic contour lines drawn from slowly evolving 3D noise
 * (marching squares), with the odd dotted flight arc crossing the chart. Cheap enough to run
 * all day: coarse grid, ~24 fps cap, paused when the tab is hidden, a single still frame when the
 * player prefers reduced motion.
 */
import { useEffect, useRef } from "react";

// ---- 3D simplex noise (Stefan Gustavson's public-domain reference, compacted)
const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
function makeNoise(seed: number) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed;
  for (let i = 255; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F3 = 1 / 3;
  const G3 = 1 / 6;
  return (x: number, y: number, z: number): number => {
    const s0 = (x + y + z) * F3;
    const i = Math.floor(x + s0);
    const j = Math.floor(y + s0);
    const k = Math.floor(z + s0);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const corners = [
      [x0, y0, z0, 0, 0, 0],
      [x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, i1, j1, k1],
      [x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, i2, j2, k2],
      [x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, 1, 1, 1],
    ];
    let n = 0;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    for (const [cx, cy, cz, di, dj, dk] of corners) {
      let tt = 0.6 - cx * cx - cy * cy - cz * cz;
      if (tt < 0) continue;
      const g = GRAD[perm[ii + di + perm[jj + dj + perm[kk + dk]]] % 12];
      tt *= tt;
      n += tt * tt * (g[0] * cx + g[1] * cy + g[2] * cz);
    }
    return 32 * n; // about -1..1
  };
}

interface Flight {
  x0: number; y0: number; x1: number; y1: number; cx: number; cy: number;
  start: number; dur: number;
}

const CELL = 18;
const LEVELS = [-0.55, -0.4, -0.25, -0.1, 0.05, 0.2, 0.35, 0.5, 0.65];

export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const noise = makeNoise(20261120);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let field = new Float32Array(0);
    let raf = 0;
    let last = 0;
    const flights: Flight[] = [];
    let nextFlight = 1500;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 1;
      rows = Math.ceil(h / CELL) + 1;
      field = new Float32Array(cols * rows);
    }

    function contours(t: number) {
      const z = t * 0.000035;
      const drift = t * 0.0000045;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * CELL;
          const y = r * CELL;
          field[r * cols + c] =
            0.75 * noise(x * 0.0021 + drift, y * 0.0024, z) + 0.25 * noise(x * 0.006, y * 0.006 - drift, z * 1.7);
        }
      }
      LEVELS.forEach((lv, li) => {
        const major = li % 3 === 1;
        ctx!.beginPath();
        for (let r = 0; r < rows - 1; r++) {
          for (let c = 0; c < cols - 1; c++) {
            const a = field[r * cols + c];
            const b = field[r * cols + c + 1];
            const d = field[(r + 1) * cols + c];
            const e = field[(r + 1) * cols + c + 1];
            const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (e > lv ? 2 : 0) | (d > lv ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const x = c * CELL;
            const y = r * CELL;
            const top = (): [number, number] => [x + CELL * ((lv - a) / (b - a)), y];
            const right = (): [number, number] => [x + CELL, y + CELL * ((lv - b) / (e - b))];
            const bottom = (): [number, number] => [x + CELL * ((lv - d) / (e - d)), y + CELL];
            const left = (): [number, number] => [x, y + CELL * ((lv - a) / (d - a))];
            const seg = (p: [number, number], q: [number, number]) => { ctx!.moveTo(p[0], p[1]); ctx!.lineTo(q[0], q[1]); };
            switch (idx) {
              case 1: case 14: seg(left(), bottom()); break;
              case 2: case 13: seg(bottom(), right()); break;
              case 3: case 12: seg(left(), right()); break;
              case 4: case 11: seg(top(), right()); break;
              case 6: case 9: seg(top(), bottom()); break;
              case 7: case 8: seg(left(), top()); break;
              case 5: seg(left(), top()); seg(bottom(), right()); break;
              case 10: seg(top(), right()); seg(left(), bottom()); break;
            }
          }
        }
        ctx!.strokeStyle = major ? "rgba(132,186,214,0.2)" : "rgba(132,186,214,0.085)";
        ctx!.lineWidth = major ? 1.3 : 1;
        ctx!.stroke();
      });
    }

    function spawnFlight(t: number) {
      const side = Math.random() < 0.5;
      const x0 = side ? -40 : w + 40;
      const x1 = side ? w + 40 : -40;
      const y0 = h * (0.15 + Math.random() * 0.7);
      const y1 = h * (0.15 + Math.random() * 0.7);
      flights.push({
        x0, y0, x1, y1, cx: w / 2 + (Math.random() - 0.5) * w * 0.3,
        cy: Math.min(y0, y1) - h * (0.15 + Math.random() * 0.25), start: t, dur: 16000 + Math.random() * 8000,
      });
    }

    function drawFlights(t: number) {
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i];
        const p = (t - f.start) / f.dur;
        if (p >= 1.15) { flights.splice(i, 1); continue; }
        const fade = p < 0.1 ? p / 0.1 : p > 0.9 ? Math.max(0, (1.15 - p) / 0.25) : 1;
        const at = (u: number): [number, number] => [
          (1 - u) * (1 - u) * f.x0 + 2 * (1 - u) * u * f.cx + u * u * f.x1,
          (1 - u) * (1 - u) * f.y0 + 2 * (1 - u) * u * f.cy + u * u * f.y1,
        ];
        ctx!.save();
        ctx!.setLineDash([2, 7]);
        ctx!.lineCap = "round";
        ctx!.strokeStyle = `rgba(240,169,59,${0.45 * fade})`;
        ctx!.lineWidth = 1.6;
        ctx!.beginPath();
        const head = Math.min(p, 1);
        for (let u = 0; u <= head; u += 0.01) {
          const [x, y] = at(u);
          if (u === 0) ctx!.moveTo(x, y); else ctx!.lineTo(x, y);
        }
        ctx!.stroke();
        ctx!.restore();
        if (p <= 1) {
          const [x, y] = at(head);
          const [x2, y2] = at(Math.min(1, head + 0.01));
          ctx!.save();
          ctx!.translate(x, y);
          ctx!.rotate(Math.atan2(y2 - y, x2 - x));
          ctx!.fillStyle = `rgba(244,236,218,${0.85 * fade})`;
          ctx!.beginPath(); // a tiny plane
          ctx!.moveTo(7, 0); ctx!.lineTo(-5, -1.5); ctx!.lineTo(-7, 0); ctx!.lineTo(-5, 1.5); ctx!.closePath();
          ctx!.moveTo(1, 0); ctx!.lineTo(-3, -6); ctx!.lineTo(-1, 0); ctx!.lineTo(-3, 6); ctx!.closePath();
          ctx!.fill();
          ctx!.restore();
        }
      }
    }

    function frame(t: number) {
      raf = requestAnimationFrame(frame);
      if (t - last < 42) return; // ~24 fps is plenty for drifting lines
      last = t;
      ctx!.clearRect(0, 0, w, h);
      contours(t);
      if (t > nextFlight) {
        spawnFlight(t);
        nextFlight = t + 9000 + Math.random() * 9000;
      }
      drawFlights(t);
    }

    resize();
    window.addEventListener("resize", resize);
    if (reduced) {
      contours(60_000);
    } else {
      raf = requestAnimationFrame(frame);
    }
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="backdrop" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
    </>
  );
}
