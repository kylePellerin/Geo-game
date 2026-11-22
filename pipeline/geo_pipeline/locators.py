"""Locator maps for "Match each highlighted country" rounds: a small pixel map around each country
with the country in red and its neighbours in green. Our own rendering of Natural Earth (public
domain), in the same pixel style as the game's world map.

Input:  raw/naturalearth/ne_50m_admin_0_countries.geojson (fetched by ingest.shapes),
        out/country_entities.parquet (attrs.shape from ingest.shapes).
Output: ../app/data/locators.json: {iso2: {"rows": [str, ...], "dot": [col, row] | null}}
        One char per pixel: "." sea, "," shallow water, "l" land, "k" land on a border,
        "x" the country. "dot" marks countries too small to see at this scale.
Served by /api/image/... by display position only, never by country.
"""

from __future__ import annotations

import argparse
import json
import math

import pandas as pd

from geo_pipeline.common import OUT, PIPELINE_DIR, RAW, log, setup_logging

COLS, ROWS = 36, 24
SAMPLES = 3
MIN_SPAN = 16.0  # degrees of longitude-equivalent across the window
SPAN_FACTOR = 2.4  # window size relative to the country's extent
DEST = PIPELINE_DIR.parent / "app" / "data" / "locators.json"
NE = RAW / "naturalearth" / "ne_50m_admin_0_countries.geojson"


def _rings(geom: dict) -> list[list[list[float]]]:
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [ring for poly in polys for ring in poly]


def _bbox(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


# Islands far from anything (Samoa, New Zealand) need a wider view to be placeable: zoom out
# until this many cells of other land are in view, up to MAX_SPAN.
MIN_CONTEXT = 40
MAX_SPAN = 110.0


def window(shape: dict, zoom: float = 1.0) -> tuple[float, float, float, float]:
    """(west, north, cell_lon, cell_lat) of a COLS x ROWS window centred on the mainland."""
    west, east, south, north = shape["west"], shape["east"], shape["south"], shape["north"]
    if east < west:  # mainland group crossing the antimeridian (Fiji): rare, centre anyway
        east += 360
    cy = (north + south) / 2
    k = max(math.cos(math.radians(cy)), 0.25)
    # spans in "equal-ish" units: longitude scaled by cos(lat)
    w_eq = (east - west) * k
    h_eq = north - south
    span = max(MIN_SPAN, w_eq * SPAN_FACTOR, h_eq * SPAN_FACTOR * COLS / ROWS)
    span = min(max(span * zoom, span), 300)
    cell_lat = span / COLS  # square pixels in equal-ish units
    cell_lon = cell_lat / k
    cx = (west + east) / 2
    top = min(85.0, cy + cell_lat * ROWS / 2)
    return cx - cell_lon * COLS / 2, top, cell_lon, cell_lat


def raster(features: list[tuple[int, list, tuple]], west: float, north: float,
           cell_lon: float, cell_lat: float) -> list[list[int]]:
    """Owner index per cell (-1 sea), majority of SAMPLES² sample points, even-odd fill."""
    east = west + cell_lon * COLS
    south = north - cell_lat * ROWS
    sub_c, sub_r = COLS * SAMPLES, ROWS * SAMPLES
    sx, sy = cell_lon / SAMPLES, cell_lat / SAMPLES
    owner = [[-1] * sub_c for _ in range(sub_r)]
    for fid, rings, (bw, bs, be, bn) in features:
        for shift in (-360.0, 0.0, 360.0):
            if be + shift < west or bw + shift > east or bn < south or bs > north:
                continue
            for r in range(sub_r):
                lat = north - (r + 0.5) * sy
                if lat < bs or lat > bn:
                    continue
                xs = []
                for ring in rings:
                    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1], strict=True):
                        if (y1 <= lat < y2) or (y2 <= lat < y1):
                            xs.append(x1 + (lat - y1) * (x2 - x1) / (y2 - y1) + shift)
                xs.sort()
                for a, b in zip(xs[0::2], xs[1::2], strict=False):
                    c0 = max(0, math.ceil((a - west) / sx - 0.5))
                    c1 = min(sub_c - 1, math.floor((b - west) / sx - 0.5))
                    row = owner[r]
                    for c in range(c0, c1 + 1):
                        row[c] = fid
    cells = [[-1] * COLS for _ in range(ROWS)]
    for r in range(ROWS):
        for c in range(COLS):
            votes: dict[int, int] = {}
            for i in range(SAMPLES):
                for j in range(SAMPLES):
                    o = owner[r * SAMPLES + i][c * SAMPLES + j]
                    votes[o] = votes.get(o, 0) + 1
            land = {k: v for k, v in votes.items() if k >= 0}
            # a cell is land if at least 4 of 9 samples are; owner = biggest share
            if sum(land.values()) >= 4:
                cells[r][c] = max(land, key=land.get)
    return cells


def draw(cells: list[list[int]], target: int) -> tuple[list[str], int]:
    out = []
    n_target = 0
    for r in range(ROWS):
        line = []
        for c in range(COLS):
            o = cells[r][c]
            if o < 0:
                near = any(0 <= r + dr < ROWS and 0 <= c + dc < COLS and cells[r + dr][c + dc] >= 0
                           for dr in (-1, 0, 1) for dc in (-1, 0, 1))
                line.append("," if near else ".")
            elif o == target:
                line.append("x")
                n_target += 1
            else:
                edge = any(0 <= r + dr < ROWS and 0 <= c + dc < COLS
                           and cells[r + dr][c + dc] >= 0 and cells[r + dr][c + dc] != o
                           for dr, dc in ((0, 1), (1, 0)))
                line.append("k" if edge else "l")
        out.append("".join(line))
    return out, n_target


def build() -> dict[str, dict]:
    gj = json.loads(NE.read_text(encoding="utf-8"))
    features, by_iso2 = [], {}
    for i, f in enumerate(gj["features"]):
        rings = _rings(f["geometry"])
        features.append((i, rings, _bbox(rings)))
        for key in ("ISO_A2", "ISO_A2_EH"):
            v = f["properties"].get(key)
            if v and v != "-99":
                by_iso2.setdefault(v, i)
    ents = pd.read_parquet(OUT / "country_entities.parquet")
    out: dict[str, dict] = {}
    for raw in ents["attrs"]:
        a = json.loads(raw)
        iso2, shape = a.get("iso2"), a.get("shape")
        if iso2 not in by_iso2 or not shape:
            continue
        zoom = 1.0
        while True:
            west, north, cl, ca = window(shape, zoom)
            cells = raster(features, west, north, cl, ca)
            rows, n = draw(cells, by_iso2[iso2])
            context = sum(ch in "lk" for row in rows for ch in row)
            if context >= MIN_CONTEXT or cl * COLS * math.cos(math.radians(north)) >= MAX_SPAN:
                break
            zoom *= 1.6
        dot = None
        if n < 4:  # too small to see: mark its centre
            lat = (shape["north"] + shape["south"]) / 2
            lon = (shape["east"] + shape["west"]) / 2
            dot = [int((lon - west) / cl), int((north - lat) / ca)]
        out[iso2] = {"rows": rows, "dot": dot}
    return out


def main() -> None:
    data = build()
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    log.info("locator maps for %d countries (%.0f KB) -> %s", len(data),
             DEST.stat().st_size / 1024, DEST)


if __name__ == "__main__":
    setup_logging()
    argparse.ArgumentParser(description=__doc__).parse_args()
    main()
