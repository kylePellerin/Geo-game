"use client";
/**
 * The moving background: a pixel map of the world (lib/client/pixelworld) with real day and night,
 * drifting clouds and passing planes. On wide screens the player's plane flies to each guess and
 * drops a pin there, panning the map so it lands in the margin beside the game. On narrow
 * screens the card's MiniMap does the flying instead.
 */
import { useEffect, useRef } from "react";
import { subscribe } from "@/lib/client/flightlog";
import { PixelWorld } from "@/lib/client/pixelworld";

/** Wide enough that the margins beside the game column can show the plane. Keep in sync with
 * `.minimap` in globals.css. */
export const WIDE = "(min-width: 1100px)";

export function pixelFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--f-label").trim() || "monospace";
}

export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const wide = window.matchMedia(WIDE);
    const world = new PixelWorld(ref.current, {
      mode: "backdrop",
      column: () => document.querySelector(".page")?.getBoundingClientRect() ?? null,
      flights: () => wide.matches,
      font: pixelFont(),
    });
    const off = subscribe(({ pins, fresh }) => (fresh ? world.guess(fresh) : world.setPins(pins)));
    return () => { off(); world.destroy(); };
  }, []);

  return (
    <>
      <canvas ref={ref} className="backdrop" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
    </>
  );
}
