/**
 * The pixel world: an animated, chunky-pixel map of the Earth that the player's plane flies over.
 * Used full-screen behind the game (mode "backdrop") and as a small strip inside the question card
 * on narrow screens (mode "mini").
 *
 * Everything snaps to a pixel grid: the land is one map cell per pixel scaled up without
 * smoothing, and sprites (planes, pins, clouds) are drawn as blocks of `u` screen pixels, rotated
 * by nearest-neighbour sampling so they stay jaggy rather than blurry.
 *
 * Extras: real-time day/night shading (dithered twilight band, city lights on the night side),
 * drifting clouds with shadows, ocean glints, the odd passing airliner. Cheap: ~30 fps cap,
 * paused when the tab is hidden, a single still frame (no flights) for reduced motion.
 */
import type { MapPin } from "./flightlog";
import { CELL_DEG, COLS, GRID, LIGHTS, NORTH, ROWS } from "./worldmap.data";

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const PALETTE: Record<string, RGB[]> = {
  ".": ["#183a6b", "#1a3f73", "#163664"].map(hex),
  ",": ["#245089", "#275694"].map(hex),
  g: ["#6aa84f", "#74b357", "#5e9a46"].map(hex),
  f: ["#3d7d45", "#45894c", "#356f3d"].map(hex),
  j: ["#2b7a45", "#31874c", "#256b3c"].map(hex),
  v: ["#b2ad55", "#bdb860", "#a6a14c"].map(hex),
  d: ["#e3bf73", "#ebc97f", "#d8b267"].map(hex),
  t: ["#93ae9f", "#9fbaab", "#87a293"].map(hex),
  i: ["#e8f0f5", "#f5f9fb", "#d9e5ed"].map(hex),
  h: ["#97744b", "#a27f55", "#8a6943"].map(hex),
  m: ["#f3f6f9", "#ffffff"].map(hex),
};
const FOAM = hex("#4a80bd");
const SHORE_SHADOW = hex("#132f59");

/** Deterministic 0..1 hash of a cell. */
function hash(c: number, r: number, s = 0): number {
  let h = (c * 374761393 + r * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const cellAt = (c: number, r: number): string =>
  r < 0 || r >= ROWS ? "." : GRID[r][((c % COLS) + COLS) % COLS];
const isWater = (ch: string) => ch === "." || ch === ",";

export const lonToX = (lon: number) => (lon + 180) / CELL_DEG;
export const latToY = (lat: number) => (NORTH - lat) / CELL_DEG;

function makeBase(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = COLS;
  cv.height = ROWS;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(COLS, ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ch = cellAt(c, r);
      let col: RGB;
      if (ch === "m") {
        col = PALETTE.m[hash(c, r) < 0.5 ? 0 : 1];
      } else if (isWater(ch)) {
        const landN = !isWater(cellAt(c, r - 1));
        const landSide = !isWater(cellAt(c - 1, r)) || !isWater(cellAt(c + 1, r)) || !isWater(cellAt(c, r + 1));
        const shades = PALETTE[ch];
        col = landN ? SHORE_SHADOW : ch === "," && landSide && hash(c, r, 3) < 0.55 ? FOAM
          : shades[hash(c, r) < 0.82 ? 0 : 1 + Math.floor(hash(c, r, 1) * (shades.length - 1))];
      } else {
        const shades = PALETTE[ch] ?? PALETTE.g;
        // light from the north-west: land with water to the NW is a touch brighter
        const lit = isWater(cellAt(c - 1, r - 1)) && hash(c, r, 2) < 0.7;
        col = lit ? shades[1] : shades[hash(c, r) < 0.6 ? 0 : hash(c, r, 4) < 0.5 ? 1 : 2];
      }
      const i = (r * COLS + c) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Sun position → per-cell darkness (0 day … 1 night). */
function nightField(now: Date): Float32Array {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const doy = (now.getTime() - start) / 86_400_000;
  const decl = (-23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)) * Math.PI) / 180;
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const subLon = (-15 * (hours - 12) * Math.PI) / 180;
  const out = new Float32Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    const lat = ((NORTH - (r + 0.5) * CELL_DEG) * Math.PI) / 180;
    for (let c = 0; c < COLS; c++) {
      const lon = ((-180 + (c + 0.5) * CELL_DEG) * Math.PI) / 180;
      const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(lon - subLon);
      out[r * COLS + c] = cosZ < -0.12 ? 1 : cosZ > 0.04 ? 0 : (0.04 - cosZ) / 0.16;
    }
  }
  return out;
}

function makeNight(field: Float32Array): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = COLS;
  cv.height = ROWS;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(COLS, ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const n = field[r * COLS + c];
      // twilight is a checkerboard dither: pixel-art, not a gradient
      const a = n >= 1 ? 0.5 : n <= 0 ? 0 : (c + r) % 2 === 0 ? 0.5 * Math.min(1, n * 1.6) : 0.5 * n * 0.5;
      const i = (r * COLS + c) * 4;
      img.data[i] = 6;
      img.data[i + 1] = 10;
      img.data[i + 2] = 38;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function makeCloud(seed: number): HTMLCanvasElement {
  const w = 9 + Math.floor(hash(seed, 1) * 9);
  const h = 3 + Math.floor(hash(seed, 2) * 3);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#fff";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2);
      const dy = (y + 0.5 - h / 2) / (h / 2);
      // flat bottom, lumpy top
      const lump = 0.25 * Math.sin(x * 1.3 + seed) + 0.15 * Math.sin(x * 2.7 + seed * 2);
      if (dx * dx + (dy < 0 ? (dy * dy) / (1 + lump) ** 2 : dy * dy * 1.6) < 1) ctx.fillRect(x, y, 1, 1);
    }
  }
  return cv;
}

// ---- sprites: one char per sprite pixel
const PLANE = [
  "......#......",
  "......##.....",
  ".#.....##....",
  "##.....###...",
  "#############",
  "#rrrrrrrrr##b",
  "#############",
  "##.....###...",
  ".#.....##....",
  "......##.....",
  "......#......",
];
const SMALL_PLANE = [
  "...#....",
  "...##...",
  "#..###..",
  "########",
  "#..###..",
  "...##...",
  "...#....",
];
const FLAG = [
  "pgggg.",
  "pGgggg",
  "pgggg.",
  "p.....",
  "p.....",
  "p.....",
  "pp....",
];
const FLAG_WAVE = [
  "pggggg",
  "pGggg.",
  "pggggg",
  "p.....",
  "p.....",
  "p.....",
  "pp....",
];
const CROSS = [
  "r...r",
  ".r.r.",
  "..r..",
  ".r.r.",
  "r...r",
];
const PIN_COLORS: Record<string, string> = {
  p: "#2b2118", g: "#4ade80", G: "#16a34a", r: "#ff5a5f",
};
const PLANE_COLORS: Record<string, string> = { "#": "#fff7e0", r: "#ff5a5f", b: "#58a6ff" };
const AMBIENT_COLORS: Record<string, string> = { "#": "#e9eef5" };
const OUTLINE = "#140d1f";

export interface PixelWorldOptions {
  /** atlas: the end-of-day map, where players drag around and tap their pins */
  mode: "backdrop" | "mini" | "atlas";
  /** backdrop: the game column, so guesses are steered into the visible margins */
  column?: () => DOMRect | null;
  /** fly to guesses (false: just pin them) */
  flights?: () => boolean;
  font?: string;
  /** atlas: called when the player taps a pin (or empty map: null) */
  onSelect?: (key: string | null) => void;
}

/** A map pin, optionally with a second line shown when the player taps it (atlas). */
type Pin = MapPin & { detail?: string };

interface Flight {
  x0: number; y0: number; x1: number; y1: number; cx: number; cy: number;
  start: number; dur: number; pin: MapPin;
}

interface Ambient {
  x0: number; y0: number; x1: number; y1: number; start: number; dur: number;
}

const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class PixelWorld {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: PixelWorldOptions;
  private readonly base: HTMLCanvasElement;
  private night: HTMLCanvasElement;
  private nightMask: Float32Array;
  private nightAt = 0;
  private readonly clouds: { cv: HTMLCanvasElement; shadow: HTMLCanvasElement; x: number; y: number; v: number }[] = [];
  private readonly ocean: number[] = [];
  private glints: { c: number; r: number; born: number }[] = [];
  private ambient: Ambient[] = [];
  private nextAmbient = 4000;

  private w = 0;
  private h = 0;
  private cell = 8;
  private camX = 0;
  private camY = 0;
  private camTween: { x0: number; x1: number; y0: number; y1: number; start: number; dur: number } | null = null;
  private driftPausedUntil = 0;

  private pins: Pin[] = [];
  private landed = new Map<string, number>();
  private plane = { x: 0, y: 0, angle: 0 };
  private home = { x: 0, y: 0, since: 0 };
  private flight: Flight | null = null;
  private queue: MapPin[] = [];
  private selected: string | null = null;
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;

  private raf = 0;
  private last = 0;
  private now = 0;
  private readonly reduced: boolean;
  private ro: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, opts: PixelWorldOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.opts = opts;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.base = makeBase();
    this.nightMask = nightField(new Date());
    this.night = makeNight(this.nightMask);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (GRID[r][c] === ".") this.ocean.push(r * COLS + c);
    }
    if (opts.mode === "backdrop") {
      for (let i = 0; i < 9; i++) {
        const cv = makeCloud(i * 7 + 3);
        const shadow = document.createElement("canvas");
        shadow.width = cv.width;
        shadow.height = cv.height;
        const sctx = shadow.getContext("2d")!;
        sctx.drawImage(cv, 0, 0);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = "#06122a";
        sctx.fillRect(0, 0, cv.width, cv.height);
        this.clouds.push({ cv, shadow, x: hash(i, 9) * COLS, y: 6 + hash(i, 10) * (ROWS - 30), v: 0.12 + hash(i, 11) * 0.12 });
      }
    }
    this.resize();
    // start somewhere with land in view: over the Atlantic towards Europe/Africa
    const startX = lonToX(-25);
    this.camX = startX * this.cell - this.w * 0.3;
    this.home = { x: lonToX(-15), y: latToY(35), since: 0 };
    if (opts.mode === "backdrop") this.parkHomeInMargin();
    this.plane = { x: this.home.x, y: this.home.y, angle: 0 };
    if (opts.mode !== "backdrop") this.centreOn(this.home.x, this.home.y, false);

    if (typeof ResizeObserver !== "undefined" && opts.mode !== "backdrop") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    } else {
      window.addEventListener("resize", this.resize);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    if (opts.mode === "atlas") {
      canvas.addEventListener("pointerdown", this.onDown);
      canvas.addEventListener("pointermove", this.onMove);
      canvas.addEventListener("pointerup", this.onUp);
      canvas.addEventListener("pointercancel", this.onCancel);
    }
    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onCancel);
  }

  /** Atlas: fly to a pin and keep its tag open (null closes it). */
  select(key: string | null): void {
    this.selected = key;
    const pin = this.pins.find((p) => p.key === key);
    if (!pin) return;
    if (this.reduced) {
      this.home = { x: lonToX(pin.lon), y: latToY(pin.lat), since: this.now };
      this.plane.x = this.home.x;
      this.plane.y = this.home.y;
      this.centreOn(this.home.x, this.home.y, false);
      this.draw();
      return;
    }
    this.queue = [];
    if (this.flight) this.flight = null;
    this.launch(pin);
  }

  // ------------------------------------------------------------------ atlas input

  private pinAtPoint(px: number, py: number): Pin | null {
    let best: Pin | null = null;
    let bestD = 22;
    for (const p of this.pins) {
      const x = this.sx(lonToX(p.lon));
      // the pin's flag/cross stands above its foot: test the middle of the sprite
      const y = this.sy(latToY(p.lat)) - 10;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private point(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * this.w) / r.width, ((e.clientY - r.top) * this.h) / r.height];
  }

  private onDown = (e: PointerEvent) => {
    const [x, y] = this.point(e);
    this.drag = { x, y, camX: this.camX, camY: this.camY, moved: false };
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    const [x, y] = this.point(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.pinAtPoint(x, y) ? "pointer" : "grab";
      return;
    }
    const dx = x - this.drag.x;
    const dy = y - this.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.camTween = null;
    this.camX = this.drag.camX - dx;
    const maxY = Math.max(0, ROWS * this.cell - this.h);
    this.camY = Math.min(maxY, Math.max(0, this.drag.camY - dy));
    if (this.reduced) this.draw();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    const [x, y] = this.point(e);
    const pin = this.pinAtPoint(x, y);
    this.select(pin ? pin.key : null);
    this.opts.onSelect?.(pin ? pin.key : null);
  };

  private onCancel = () => { this.drag = null; };

  /** Replace pins (no flight). The plane parks over the latest one. */
  setPins(pins: MapPin[]): void {
    const hadNone = this.pins.length === 0;
    this.pins = pins;
    if (hadNone && pins.length && !this.flight) {
      const p = pins[pins.length - 1];
      this.home = { x: lonToX(p.lon), y: latToY(p.lat), since: this.now };
      this.plane.x = this.home.x;
      this.plane.y = this.home.y;
      if (this.opts.mode === "atlas") this.centreOnAll();
      else if (this.opts.mode !== "backdrop") this.centreOn(this.home.x, this.home.y, false);
      else this.steerToMargin(this.home.x, false);
    }
    if (this.reduced) this.draw();
  }

  /** A fresh guess: fly there (queued if a flight is under way), then drop the pin. */
  guess(pin: MapPin): void {
    if (!this.pins.some((p) => p.key === pin.key)) this.pins = [...this.pins, pin];
    if (this.reduced || (this.opts.flights && !this.opts.flights())) {
      // the backdrop only pins quietly when the card's mini map is doing the flying
      this.landed.set(pin.key, this.opts.mode !== "backdrop" ? this.now : -1e9);
      this.home = { x: lonToX(pin.lon), y: latToY(pin.lat), since: this.now };
      this.plane.x = this.home.x;
      this.plane.y = this.home.y;
      if (this.opts.mode !== "backdrop") this.centreOn(this.home.x, this.home.y, !this.reduced);
      if (this.reduced) this.draw();
      return;
    }
    this.landed.set(pin.key, Infinity); // hidden until the plane gets there
    if (this.flight) this.queue.push(pin);
    else this.launch(pin);
  }

  // ------------------------------------------------------------------ layout & camera

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(this.opts.mode === "backdrop" ? window.innerWidth : rect.width));
    const h = Math.max(1, Math.round(this.opts.mode === "backdrop" ? window.innerHeight : rect.height));
    const oldCell = this.cell;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.cell = this.opts.mode === "backdrop"
      ? Math.max(4, Math.ceil(h / (ROWS - 6)), Math.ceil(w / COLS))
      : this.opts.mode === "atlas" ? Math.max(3, Math.round(h / 52))
      : Math.max(3, Math.round(h / 26));
    this.camX = (this.camX / oldCell) * this.cell;
    if (this.opts.mode === "backdrop") {
      // a little more north than south: that's where most land is
      this.camY = Math.max(0, Math.round((ROWS * this.cell - h) * 0.4));
    } else {
      this.camY = Math.min(Math.max(0, this.camY), Math.max(0, ROWS * this.cell - h));
    }
    this.ctx.imageSmoothingEnabled = false;
    if (this.reduced) this.draw();
  };

  private get worldW() {
    return COLS * this.cell;
  }

  /** Screen x of world x (cells), choosing the wrap copy nearest the middle of the view. */
  private sx(x: number): number {
    const v = x * this.cell - this.camX;
    return v - this.worldW * Math.round((v - this.w / 2) / this.worldW);
  }

  private sy(y: number): number {
    return y * this.cell - this.camY;
  }

  private margins(): number[] {
    const col = this.opts.column?.();
    if (!col) return [this.w * 0.82];
    const out: number[] = [];
    if (col.left > 150) out.push(col.left / 2);
    if (this.w - col.right > 150) out.push(col.right + (this.w - col.right) / 2);
    return out.length ? out : [this.w * 0.82];
  }

  private parkHomeInMargin() {
    const m = this.margins();
    const x = m[m.length - 1];
    this.home.x = ((x + this.camX) / this.cell) % COLS;
    this.home.y = (this.camY + this.h * 0.42) / this.cell;
  }

  /** Pan (wrapping) so world x lands in the nearest visible margin. */
  private steerToMargin(x: number, animate: boolean, dur = 900) {
    let best = 0;
    let bestAbs = Infinity;
    for (const target of this.margins()) {
      const v = this.sx(x) - target;
      if (Math.abs(v) < bestAbs) { bestAbs = Math.abs(v); best = v; }
    }
    this.panBy(best, 0, animate, dur);
  }

  /** Atlas: start over the middle of the day's pins (circular mean of longitude). */
  private centreOnAll() {
    if (!this.pins.length) return;
    let sx = 0;
    let sy = 0;
    let lat = 0;
    for (const p of this.pins) {
      const a = (p.lon * Math.PI) / 180;
      sx += Math.cos(a);
      sy += Math.sin(a);
      lat += p.lat;
    }
    const lon = (Math.atan2(sy, sx) * 180) / Math.PI;
    this.centreOn(lonToX(lon), latToY(lat / this.pins.length), false);
  }

  private centreOn(x: number, y: number, animate: boolean, dur = 800) {
    const dx = this.sx(x) - this.w / 2;
    const maxY = Math.max(0, ROWS * this.cell - this.h);
    const ty = Math.min(maxY, Math.max(0, y * this.cell - this.h / 2));
    this.panBy(dx, ty - this.camY, animate, dur);
  }

  private panBy(dx: number, dy: number, animate: boolean, dur: number) {
    if (!animate) {
      this.camX += dx;
      this.camY += dy;
      this.camTween = null;
      return;
    }
    this.camTween = { x0: this.camX, x1: this.camX + dx, y0: this.camY, y1: this.camY + dy, start: this.now, dur };
  }

  // ------------------------------------------------------------------ flights

  private launch(pin: MapPin) {
    const tx0 = lonToX(pin.lon);
    // unwrap: fly the short way round
    const tx = tx0 + COLS * Math.round((this.plane.x - tx0) / COLS);
    const ty = latToY(pin.lat);
    const dist = Math.hypot(tx - this.plane.x, ty - this.plane.y);
    const dur = Math.min(1700, Math.max(650, 500 + dist * 9));
    const mx = (this.plane.x + tx) / 2;
    const my = (this.plane.y + ty) / 2 - Math.min(30, 4 + dist * 0.3);
    this.flight = { x0: this.plane.x, y0: this.plane.y, x1: tx, y1: ty, cx: mx, cy: my, start: this.now, dur, pin };
    this.driftPausedUntil = this.now + dur + 9000;
    if (this.opts.mode !== "backdrop") this.centreOn(tx0, ty, true, dur * 0.85);
    else this.steerToMargin(tx0, true, dur * 0.85);
  }

  private flightAt(f: Flight, p: number): [number, number] {
    const a = (1 - p) * (1 - p);
    const b = 2 * (1 - p) * p;
    const c = p * p;
    return [a * f.x0 + b * f.cx + c * f.x1, a * f.y0 + b * f.cy + c * f.y1];
  }

  // ------------------------------------------------------------------ loop

  private onVisibility = () => {
    cancelAnimationFrame(this.raf);
    if (!document.hidden) this.start();
  };

  private start() {
    if (this.reduced) {
      this.draw();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (t - this.last < 33) return;
    const dt = Math.min(100, t - (this.last || t));
    this.last = t;
    this.now = t;
    this.update(dt);
    this.draw();
  };

  private update(dt: number) {
    const t = this.now;
    if (t - this.nightAt > 60_000) {
      this.nightAt = t;
      this.nightMask = nightField(new Date());
      this.night = makeNight(this.nightMask);
    }
    if (this.camTween) {
      const k = Math.min(1, (t - this.camTween.start) / this.camTween.dur);
      const e = easeInOut(k);
      this.camX = this.camTween.x0 + (this.camTween.x1 - this.camTween.x0) * e;
      this.camY = this.camTween.y0 + (this.camTween.y1 - this.camTween.y0) * e;
      if (k >= 1) this.camTween = null;
    } else if (this.opts.mode === "backdrop" && t > this.driftPausedUntil) {
      this.camX += dt * 0.012; // a slow drift east
    }
    this.camX = ((this.camX % this.worldW) + this.worldW) % this.worldW;

    for (const cl of this.clouds) cl.x = (cl.x + (cl.v * dt) / 1000 + COLS) % COLS;

    // the player's plane
    const f = this.flight;
    if (f) {
      const p = Math.min(1, (t - f.start) / f.dur);
      const e = easeInOut(p);
      const [x, y] = this.flightAt(f, e);
      const [x2, y2] = this.flightAt(f, Math.min(1, e + 0.02));
      this.plane.x = x;
      this.plane.y = y;
      if (p < 1) this.plane.angle = Math.atan2(y2 - y, x2 - x);
      if (p >= 1) {
        this.flight = null;
        this.landed.set(f.pin.key, t);
        this.home = { x: ((f.x1 % COLS) + COLS) % COLS, y: f.y1, since: t };
        const next = this.queue.shift();
        if (next) this.launch(next);
      }
    } else {
      // holding pattern round the last pin, widening in after landing
      const R = 2.6 * Math.min(1, (t - this.home.since) / 1200);
      const a = (t / 1000) * 0.9;
      this.plane.x = this.home.x + Math.cos(a) * R * 1.4;
      this.plane.y = this.home.y - 1.2 + Math.sin(a) * R * 0.7;
      this.plane.angle = R > 0.2 ? Math.atan2(Math.cos(a) * 0.7, -Math.sin(a) * 1.4) : this.plane.angle;
    }

    // ocean glints
    if (this.ocean.length) {
      this.glints = this.glints.filter((g) => t - g.born < 1100);
      const want = this.opts.mode === "backdrop" ? 70 : 10;
      for (let i = 0; this.glints.length < want && i < 4; i++) {
        const idx = this.ocean[Math.floor(Math.random() * this.ocean.length)];
        this.glints.push({ c: idx % COLS, r: Math.floor(idx / COLS), born: t - Math.random() * 300 });
      }
    }

    // passing traffic (backdrop only)
    if (this.opts.mode === "backdrop") {
      this.ambient = this.ambient.filter((a) => t - a.start < a.dur);
      if (t > this.nextAmbient) {
        const ltr = Math.random() < 0.5;
        const y0 = this.h * (0.1 + Math.random() * 0.8);
        this.ambient.push({
          x0: ltr ? -40 : this.w + 40, x1: ltr ? this.w + 40 : -40,
          y0, y1: y0 + (Math.random() - 0.5) * this.h * 0.4, start: t, dur: 22000 + Math.random() * 12000,
        });
        this.nextAmbient = t + 14000 + Math.random() * 16000;
      }
    }
  }

  private draw() {
    const { ctx, cell, w, h } = this;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    const ww = this.worldW;
    const wh = ROWS * cell;
    const camX = Math.round(this.camX);
    const camY = Math.round(this.camY);
    let x0 = -(((camX % ww) + ww) % ww);
    for (; x0 < w; x0 += ww) {
      ctx.drawImage(this.base, x0, -camY, ww, wh);
      ctx.drawImage(this.night, x0, -camY, ww, wh);
    }
    const u = Math.max(2, Math.round(cell / 4));

    // city lights on the night side, twinkling
    for (const [c, r] of LIGHTS) {
      const n = this.nightMask[r * COLS + c];
      if (n < 0.5) continue;
      const tw = hash(c, r, Math.floor(this.now / 700)) < 0.15 ? 0.5 : 1;
      const x = Math.round(this.sx(c + 0.5)) - u / 2;
      const y = Math.round(this.sy(r + 0.5)) - u / 2;
      if (x < -u || x > w || y < -u || y > h) continue;
      ctx.globalAlpha = tw;
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(x, y, u, u);
      ctx.globalAlpha = 0.35 * tw;
      ctx.fillRect(x - u, y, u * 3, u);
      ctx.fillRect(x, y - u, u, u * 3);
      ctx.globalAlpha = 1;
    }

    // glints: a little + that grows and fades
    for (const g of this.glints) {
      const age = (this.now - g.born) / 1100;
      if (age < 0) continue;
      const x = Math.round(this.sx(g.c + 0.5));
      const y = Math.round(this.sy(g.r + 0.5));
      if (x < 0 || x > w || y < 0 || y > h) continue;
      ctx.fillStyle = `rgba(190,225,255,${(age < 0.5 ? age * 2 : (1 - age) * 2) * 0.75})`;
      ctx.fillRect(x - u / 2, y - u / 2, u, u);
      if (age > 0.3 && age < 0.7) {
        ctx.fillRect(x - u * 1.5, y - u / 2, u, u);
        ctx.fillRect(x + u / 2, y - u / 2, u, u);
      }
    }

    // pins
    // the tapped pin last, so its tag sits on top
    for (const p of this.pins) if (p.key !== this.selected) this.drawPin(p, u);
    const sel = this.pins.find((p) => p.key === this.selected);
    if (sel) this.drawPin(sel, u, "pin");

    // cloud shadows, then clouds
    for (const cl of this.clouds) {
      const x = Math.round(this.sx(cl.x));
      const y = Math.round(this.sy(cl.y));
      ctx.globalAlpha = 0.22;
      ctx.drawImage(cl.shadow, x + cell, y + cell * 2, cl.cv.width * cell, cl.cv.height * cell);
    }
    ctx.globalAlpha = 0.88;
    for (const cl of this.clouds) {
      const x = Math.round(this.sx(cl.x));
      const y = Math.round(this.sy(cl.y));
      ctx.drawImage(cl.cv, x, y, cl.cv.width * cell, cl.cv.height * cell);
    }
    ctx.globalAlpha = 1;

    // passing airliners with dotted contrails
    for (const a of this.ambient) {
      const p = (this.now - a.start) / a.dur;
      const x = a.x0 + (a.x1 - a.x0) * p;
      const y = a.y0 + (a.y1 - a.y0) * p;
      const ang = Math.atan2(a.y1 - a.y0, a.x1 - a.x0);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      for (let k = 1; k < 24; k++) {
        const d = k * 7;
        if (k % 2) ctx.fillRect(Math.round(x - Math.cos(ang) * d), Math.round(y - Math.sin(ang) * d), 2, 2);
      }
      this.sprite(SMALL_PLANE, AMBIENT_COLORS, x, y, ang, 2, 0.9);
    }

    this.drawPlayerPlane(u);
    // the tapped pin's tag goes over the plane circling it
    if (sel) this.drawPin(sel, u, "tag");
  }

  private drawPin(p: Pin, u: number, part: "all" | "pin" | "tag" = "all") {
    const landedAt = this.landed.get(p.key) ?? -1e9;
    if (landedAt === Infinity) return;
    const x = Math.round(this.sx(lonToX(p.lon)));
    const y = Math.round(this.sy(latToY(p.lat)));
    if (x < -60 || x > this.w + 60 || y < -60 || y > this.h + 60) return;
    const age = this.now - landedAt;
    const pu = Math.max(2, u);
    if (part !== "tag") this.drawPinSprite(p, x, y, age, pu);
    if (part !== "pin") this.drawTag(p, x, y, age, pu);
  }

  private drawPinSprite(p: Pin, x: number, y: number, age: number, pu: number) {
    const drop = age < 300 ? Math.round((1 - Math.sin((age / 300) * Math.PI * 0.5)) * -40 + Math.sin((age / 300) * Math.PI) * -6) : 0;
    // ripple rings on landing
    if (age < 700) {
      const k = age / 700;
      const r = Math.round((4 + k * 14) * pu / 2) * 2;
      this.ctx.strokeStyle = `rgba(255,240,180,${1 - k})`;
      this.ctx.lineWidth = pu;
      this.ctx.strokeRect(x - r, y - r / 2, r * 2, r);
    }
    // shadow dot
    this.ctx.fillStyle = "rgba(0,0,0,0.3)";
    this.ctx.fillRect(x - pu, y, pu * 3, pu);
    if (p.ok) {
      const wave = Math.floor(this.now / 300) % 2;
      const sprite = wave ? FLAG_WAVE : FLAG;
      this.grid(sprite, PIN_COLORS, x - pu / 2, y - sprite.length * pu + drop, pu);
    } else {
      this.grid(CROSS, PIN_COLORS, x - 2.5 * pu, y - 5 * pu + drop, pu);
    }
  }

  private drawTag(p: Pin, x: number, y: number, age: number, pu: number) {
    // name tag for a few seconds after landing; a tapped pin (atlas) keeps it, with details
    const held = p.key === this.selected && age >= 200;
    if ((held || (age >= 200 && age < 4200)) && this.opts.font) {
      const ctx = this.ctx;
      const size = this.opts.mode === "backdrop" ? 13 : 11;
      const lines = [p.label.toUpperCase(), ...(held && p.detail ? [p.detail.toUpperCase()] : [])];
      ctx.font = `${size}px ${this.opts.font}`;
      const tw = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)));
      const lh = size + 4;
      const boxH = lines.length * lh + 4;
      let bx = Math.round(x - tw / 2 - 6);
      bx = Math.max(4, Math.min(this.w - tw - 18, bx));
      const by = y + pu * 2;
      ctx.globalAlpha = held ? 1 : age > 3700 ? (4200 - age) / 500 : 1;
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(bx - 2, by - 2, tw + 16, boxH + 4);
      ctx.fillStyle = p.ok ? "#fff7e0" : "#ffe1e1";
      ctx.fillRect(bx, by, tw + 12, boxH);
      ctx.textBaseline = "top";
      lines.forEach((l, i) => {
        ctx.fillStyle = i === 0 ? OUTLINE : p.ok ? "#2f7a3a" : "#a8323a";
        ctx.fillText(l, bx + 6, by + 4 + i * lh);
      });
      ctx.globalAlpha = 1;
    }
  }

  private drawPlayerPlane(u: number) {
    // the player's plane is drawn big (1.3x the map unit) so it reads at a glance
    const pu = Math.max(3, this.opts.mode !== "backdrop" ? Math.round(u * 1.05) : Math.round(u * 1.3));
    const du = Math.max(2, Math.round(u * 0.6));
    const x = this.sx(this.plane.x);
    const y = this.sy(this.plane.y);
    if (x < -80 || x > this.w + 80) return;
    let alt = 3;
    if (this.flight) {
      const p = Math.min(1, (this.now - this.flight.start) / this.flight.dur);
      alt = 3 + Math.sin(p * Math.PI) * 7;
      // dotted route behind the plane
      const f = this.flight;
      this.ctx.fillStyle = "#ffd166";
      const e = easeInOut(p);
      for (let k = 0; k <= 60; k++) {
        const q = (k / 60) * e;
        if (k % 3 === 2) continue;
        const [qx, qy] = this.flightAt(f, q);
        this.ctx.fillRect(Math.round(this.sx(qx) - du / 2), Math.round(this.sy(qy) - du / 2), du, du);
      }
    }
    this.sprite(PLANE, { "#": "rgba(0,0,0,0.28)", r: "rgba(0,0,0,0.28)", b: "rgba(0,0,0,0.28)" },
      x + alt * pu * 0.5, y + alt * pu, this.plane.angle, pu, 1, false);
    this.sprite(PLANE, PLANE_COLORS, x, y, this.plane.angle, pu, 1, true);
  }

  /** Axis-aligned sprite with a 1-pixel outline. */
  private grid(rows: string[], colors: Record<string, string>, x: number, y: number, u: number) {
    const ctx = this.ctx;
    const X = Math.round(x);
    const Y = Math.round(y);
    ctx.fillStyle = OUTLINE;
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch !== ".") ctx.fillRect(X + (i - 1) * u, Y + (j - 1) * u, u * 3, u * 3);
    }));
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === ".") return;
      ctx.fillStyle = colors[ch] ?? "#fff";
      ctx.fillRect(X + i * u, Y + j * u, u, u);
    }));
  }

  /** Rotated sprite, nearest-neighbour: stays crunchy at any angle. */
  private sprite(rows: string[], colors: Record<string, string>, cx: number, cy: number, angle: number,
                 u: number, alpha = 1, outline = true) {
    const ctx = this.ctx;
    const sw = rows[0].length;
    const sh = rows.length;
    const R = Math.ceil(Math.hypot(sw, sh) / 2) + 1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ox = Math.round(cx / u) * u;
    const oy = Math.round(cy / u) * u;
    const cells: [number, number, string][] = [];
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        // inverse-rotate the target cell into sprite space
        const sx = Math.round(cos * i + sin * j + (sw - 1) / 2);
        const sy = Math.round(-sin * i + cos * j + (sh - 1) / 2);
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
        const ch = rows[sy][sx];
        if (ch !== ".") cells.push([i, j, ch]);
      }
    }
    ctx.globalAlpha = alpha;
    if (outline) {
      ctx.fillStyle = OUTLINE;
      for (const [i, j] of cells) ctx.fillRect(ox + (i - 1) * u, oy + (j - 1) * u, u * 3, u * 3);
    }
    for (const [i, j, ch] of cells) {
      ctx.fillStyle = colors[ch] ?? colors["#"];
      ctx.fillRect(ox + i * u, oy + j * u, u, u);
    }
    ctx.globalAlpha = 1;
  }
}
