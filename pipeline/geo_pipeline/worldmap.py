"""Pixel world map for the game's background: Natural Earth land rasterised to a coarse grid,
with simple biome colours, high peaks and big-city lights.

Input:  raw/naturalearth/ne_50m_admin_0_countries.geojson (public domain, fetched by
        ingest.shapes), out/mountain_entities.parquet, out/city_entities.parquet.
Output: ../app/lib/client/worldmap.data.ts (generated, committed; ~40 KB).

Equirectangular, CELL degrees per cell, rows from NORTH down to SOUTH. One character per cell:
  .  deep ocean      ,  shallow water (next to land)
  g  grassland       f  forest        j  jungle       v  savanna
  d  desert          t  tundra        i  ice          h  highland     m  high peak (snow)
Biomes are rough latitude bands plus a few hand-drawn boxes: it is decoration, not data.
"""

from __future__ import annotations

import argparse
import json

import pandas as pd

from geo_pipeline.common import OUT, PIPELINE_DIR, RAW, log, setup_logging

CELL = 1.25
NORTH = 83.75
SOUTH = -60.0
SAMPLES = 3  # per axis, per cell
DEST = PIPELINE_DIR.parent / "app" / "lib" / "client" / "worldmap.data.ts"

# (west, south, east, north) boxes
DESERTS = [
    (-17, 16, 33, 31), (33, 13, 60, 31), (44, 25, 72, 37), (52, 36, 66, 44),  # Sahara, Arabia, Iran
    (68, 24, 75, 29), (78, 36, 112, 45), (114, -32, 140, -20), (12, -29, 22, -18),
    (-72, -27, -68, -17), (-118, 29, -106, 37), (-70, -50, -66, -38),
]
SAVANNAS = [
    (-17, 9, 40, 16), (12, -17, 40, -5), (22, -24, 34, -17), (30, -5, 42, 9), (120, -20, 145, -11),
    (-58, -22, -40, -6), (-105, 18, -97, 25), (73, 15, 82, 24),
]
JUNGLE = (-12.0, 9.0)
GREENLAND = (-56, 60, -18, 84)


def _inside(box: tuple[float, float, float, float], lon: float, lat: float) -> bool:
    w, s, e, n = box
    return w <= lon <= e and s <= lat <= n


def _rings(geom: dict) -> list[list[list[float]]]:
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [ring for poly in polys for ring in poly]


def rasterise(rings: list[list[list[float]]], cols: int, rows: int) -> list[list[bool]]:
    """Even-odd scanline fill at SAMPLES² points per cell; a cell is land if ≥ ~45% of them are."""
    # pre-split edges by sample row for speed
    sub_rows = rows * SAMPLES
    edges_by_row: list[list[tuple[float, float, float, float]]] = [[] for _ in range(sub_rows)]
    step = CELL / SAMPLES
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1], strict=True):
            if y1 == y2:
                continue
            lo, hi = min(y1, y2), max(y1, y2)
            r0 = max(0, int((NORTH - hi) / step - 0.5))
            r1 = min(sub_rows - 1, int((NORTH - lo) / step + 0.5))
            for r in range(r0, r1 + 1):
                edges_by_row[r].append((x1, y1, x2, y2))
    counts = [[0] * cols for _ in range(rows)]
    for r in range(sub_rows):
        lat = NORTH - (r + 0.5) * step
        xs = sorted(
            x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            for x1, y1, x2, y2 in edges_by_row[r]
            if (y1 <= lat < y2) or (y2 <= lat < y1)
        )
        for a, b in zip(xs[0::2], xs[1::2], strict=False):
            c0 = max(0, int(((a + 180) / step) - 0.5) + 1)
            c1 = min(cols * SAMPLES - 1, int(((b + 180) / step) - 0.5))
            for c in range(c0, c1 + 1):
                counts[r // SAMPLES][c // SAMPLES] += 1
    need = round(SAMPLES * SAMPLES * 0.45)
    return [[n >= need for n in row] for row in counts]


def biome(lon: float, lat: float) -> str:
    if lat < -60 or lat > 74 or (_inside(GREENLAND, lon, lat) and lat > 62):
        return "i"
    if lat > 62 or _inside(GREENLAND, lon, lat):
        return "t"
    if any(_inside(b, lon, lat) for b in DESERTS):
        return "d"
    if any(_inside(b, lon, lat) for b in SAVANNAS):
        return "v"
    if JUNGLE[0] < lat < JUNGLE[1] and not (30 <= lon <= 42):
        return "j"
    if 48 < lat <= 62 or -50 > lat:
        return "f"
    return "g"


def build() -> dict:
    geo = json.loads((RAW / "naturalearth" / "ne_50m_admin_0_countries.geojson").read_text())
    rings = [ring for f in geo["features"] for ring in _rings(f["geometry"])]
    cols = round(360 / CELL)
    rows = round((NORTH - SOUTH) / CELL)
    land = rasterise(rings, cols, rows)

    def ll(c: int, r: int) -> tuple[float, float]:
        return -180 + (c + 0.5) * CELL, NORTH - (r + 0.5) * CELL

    grid = [["." for _ in range(cols)] for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            if land[r][c]:
                grid[r][c] = biome(*ll(c, r))
            elif any(
                land[rr][(cc) % cols]
                for rr in range(max(0, r - 1), min(rows, r + 2))
                for cc in range(c - 1, c + 2)
            ):
                grid[r][c] = ","

    def cell_of(lat: float, lon: float) -> tuple[int, int] | None:
        c = int((lon + 180) / CELL) % cols
        r = int((NORTH - lat) / CELL)
        return (c, r) if 0 <= r < rows else None

    peaks = pd.read_parquet(OUT / "mountain_entities.parquet").dropna(subset=["lat", "lon"])
    elev = peaks["attrs"].map(lambda a: json.loads(a).get("elevation_m") or 0)
    for (lat, lon), e in zip(peaks[["lat", "lon"]].itertuples(index=False), elev, strict=True):
        at = cell_of(lat, lon)
        if not at or grid[at[1]][at[0]] in ".,i":
            continue
        if e >= 4500:
            grid[at[1]][at[0]] = "m"
        elif e >= 2800 and grid[at[1]][at[0]] != "m":
            grid[at[1]][at[0]] = "h"

    cities = pd.read_parquet(OUT / "city_entities.parquet").dropna(subset=["lat", "lon"])
    cities["pop"] = cities["attrs"].map(lambda a: json.loads(a).get("population") or 0)
    lights: list[list[int]] = []
    for lat, lon in cities.nlargest(90, "pop")[["lat", "lon"]].itertuples(index=False):
        at = cell_of(lat, lon)
        if at and grid[at[1]][at[0]] not in ".," and list(at) not in lights:
            lights.append(list(at))
    return {"cell": CELL, "north": NORTH, "cols": cols, "rows": rows,
            "grid": ["".join(row) for row in grid], "lights": lights}


def write(world: dict) -> None:
    body = ",\n".join(f'  "{row}"' for row in world["grid"])
    DEST.write_text(
        "/* Generated by pipeline/geo_pipeline/worldmap.py from Natural Earth (public domain). Do not edit. */\n"
        f"export const CELL_DEG = {world['cell']};\n"
        f"export const NORTH = {world['north']};\n"
        f"export const COLS = {world['cols']};\n"
        f"export const ROWS = {world['rows']};\n"
        f"export const LIGHTS: [number, number][] = {json.dumps(world['lights'], separators=(',', ':'))};\n"
        f"export const GRID: string[] = [\n{body},\n];\n"
    )
    log.info("wrote %s (%d×%d, %d city lights)", DEST, world["cols"], world["rows"], len(world["lights"]))


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    setup_logging()
    write(build())


if __name__ == "__main__":
    main()
