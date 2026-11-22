"use client";
/**
 * End of the day: every guess on one pixel map. Drag to look around; tap a pin (or a chip below)
 * and the plane flies there and shows what you answered.
 */
import { useEffect, useRef, useState } from "react";
import { type MapPin, subscribe } from "@/lib/client/flightlog";
import { PixelWorld } from "@/lib/client/pixelworld";
import { pixelFont } from "./Backdrop";

export function Atlas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const world = useRef<PixelWorld | null>(null);
  const [pins, setPinList] = useState<MapPin[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const w = new PixelWorld(ref.current, { mode: "atlas", font: pixelFont(), onSelect: setSelected });
    world.current = w;
    const off = subscribe(({ pins: next }) => { w.setPins(next); setPinList(next); });
    return () => { off(); w.destroy(); world.current = null; };
  }, []);

  const pick = (key: string) => {
    const next = key === selected ? null : key;
    setSelected(next);
    world.current?.select(next);
  };
  return (
    // always mounted so the canvas exists for the effect; hidden until there is a pin
    <section className="atlas" hidden={!pins.length}>
      <h3 className="kicker">Your day on the map</h3>
      <canvas ref={ref} aria-label="Map of your guesses: drag to look around, tap a pin" />
      <div className="atlas-chips">
        {pins.map((p) => (
          <button key={p.key} type="button" className="chip" data-ok={p.ok} aria-pressed={selected === p.key}
                  onClick={() => pick(p.key)}>
            <small>Q{Number(p.key.split(":")[0]) + 1}</small> {p.ok ? "⚑" : "✗"} {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}
