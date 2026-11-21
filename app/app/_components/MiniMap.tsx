"use client";
/**
 * The map strip inside a free-text question on narrow screens, where the card covers the
 * background: the plane flies here instead. Hidden (and not mounted) on wide screens.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { subscribe } from "@/lib/client/flightlog";
import { PixelWorld } from "@/lib/client/pixelworld";
import { pixelFont, WIDE } from "./Backdrop";

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export function MiniMap() {
  const wide = useWide();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (wide || !ref.current) return;
    const world = new PixelWorld(ref.current, { mode: "mini", font: pixelFont() });
    const off = subscribe(({ pins, fresh }) => (fresh ? world.guess(fresh) : world.setPins(pins)));
    return () => { off(); world.destroy(); };
  }, [wide]);

  if (wide) return null;
  return (
    <div className="minimap" aria-hidden="true">
      <canvas ref={ref} />
    </div>
  );
}
