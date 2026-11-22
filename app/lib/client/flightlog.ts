/**
 * The day's guesses as map pins, shared between the game screen (which learns about guesses) and
 * the pixel maps (which draw them and fly the plane). A tiny module-level store, no context needed.
 */
import type { Summary } from "./types";

export interface MapPin {
  key: string;
  lat: number;
  lon: number;
  ok: boolean;
  label: string;
  /** second line on the end-of-day map: "Q2 · Familiar +50" */
  detail?: string;
}

const TIER_LABEL: Record<string, string> = {
  famous: "Famous", well_known: "Well known", familiar: "Familiar", obscure: "Obscure", rarest: "Rarest",
};

type Listener = (event: { pins: MapPin[]; fresh?: MapPin }) => void;

let pins: MapPin[] = [];
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn({ pins });
  return () => listeners.delete(fn);
}

export function currentPins(): MapPin[] {
  return pins;
}

/** Replace every pin (e.g. after loading the day); no flight. */
export function setPins(next: MapPin[]): void {
  const same = next.length === pins.length
    && next.every((p, i) => p.key === pins[i].key && p.detail === pins[i].detail);
  if (same) return;
  pins = next;
  listeners.forEach((fn) => fn({ pins }));
}

/** A new guess: pin it and fly the plane there. */
export function addGuess(pin: MapPin): void {
  if (pins.some((p) => p.key === pin.key)) return;
  pins = [...pins, pin];
  listeners.forEach((fn) => fn({ pins, fresh: pin }));
}

export function pinFor(idx: number, entity: { id: string; name: string; at?: [number, number] }, ok: boolean): MapPin | null {
  if (!entity.at) return null;
  return { key: `${idx}:${entity.id}`, lat: entity.at[0], lon: entity.at[1], ok, label: entity.name };
}

export function pinsFromSummaries(summaries: Iterable<Summary>): MapPin[] {
  const out: MapPin[] = [];
  for (const s of summaries) {
    for (const a of s.answers) {
      const p = pinFor(s.idx, a.entity, a.status === "valid");
      if (!p) continue;
      p.detail = a.status === "valid"
        ? `Q${s.idx + 1} · ${TIER_LABEL[a.tier ?? ""] ?? "Right"} +${a.points}`
        : `Q${s.idx + 1} · not this one`;
      out.push(p);
    }
  }
  return out;
}
