"""Country shapes from Natural Earth (public domain): outlines for matching rounds and the
geometry behind "map surprise" questions.

Input:  Natural Earth 1:50m admin-0 countries GeoJSON (cached in raw/naturalearth/).
Output: adds attrs.shape to out/country_entities.parquet:
          {"north", "south", "east", "west"}  extent of the mainland group (degrees), so
              "entirely north of the Equator" means what players think (not overseas islands)
          "crosses": ["equator", "tropic_of_cancer", "tropic_of_capricorn", "arctic_circle",
                      "prime_meridian"]  lines that cross any of the country's land
          "area_rank_ok": true if the outline is big enough to recognise
        writes ../app/data/outlines.json: {iso2: {"d": svg path, "w", "h"}} (mainland group,
        equal-area-ish projection, simplified), served by /api/outline/... by position only.
"""

from __future__ import annotations

import argparse
import json
import math

import pandas as pd

from geo_pipeline.common import OUT, PIPELINE_DIR, RAW, download, log, setup_logging

NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
          "ne_50m_admin_0_countries.geojson")
OUTLINES = PIPELINE_DIR.parent / "app" / "data" / "outlines.json"
LINES = {"equator": 0.0, "tropic_of_cancer": 23.4362, "tropic_of_capricorn": -23.4362,
         "arctic_circle": 66.5633}
SIZE = 200  # outline box, px


def _polygons(geom: dict) -> list[list[list[float]]]:
    """Outer rings of a (Multi)Polygon as [[lon, lat], ...]."""
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    return [p[0] for p in geom["coordinates"]]


def ring_area(ring: list[list[float]]) -> float:
    """Approximate area (deg², latitude-corrected) via the shoelace formula."""
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1], strict=False):
        s += x1 * math.cos(lat0) * y2 - x2 * math.cos(lat0) * y1
    return abs(s) / 2


def mainland(rings: list[list[list[float]]], dx: float = 20, dy: float = 15) -> list[list[list[float]]]:
    """The largest landmass plus nearby big pieces (drops far-flung overseas territories)."""
    areas = [ring_area(r) for r in rings]
    big = max(range(len(rings)), key=lambda i: areas[i])
    cx = sum(p[0] for p in rings[big]) / len(rings[big])
    cy = sum(p[1] for p in rings[big]) / len(rings[big])
    keep = []
    for r, a in zip(rings, areas, strict=False):
        rx = sum(p[0] for p in r) / len(r)
        ry = sum(p[1] for p in r) / len(r)
        if a >= 0.002 * areas[big] and abs(rx - cx) < dx and abs(ry - cy) < dy:
            keep.append(r)
    return keep


def crosses(rings: list[list[list[float]]]) -> list[str]:
    """A closed ring with vertices on both sides of a line has land on that line."""
    out = []
    for name, lat in LINES.items():
        if any(min(p[1] for p in r) < lat < max(p[1] for p in r) for r in rings):
            out.append(name)
    # prime meridian: ignore rings straddling the antimeridian (lon jumps of > 180)
    if any(min(p[0] for p in r) < 0 < max(p[0] for p in r)
           and max(p[0] for p in r) - min(p[0] for p in r) < 180 for r in rings):
        out.append("prime_meridian")
    return out


def _simplify(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Drop points closer than eps to the last kept one."""
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(p, out[-1]) >= eps:
            out.append(p)
    return out if len(out) >= 3 else pts


def outline_path(rings: list[list[list[float]]]) -> dict:
    lat0 = math.radians(sum(p[1] for r in rings for p in r) / sum(len(r) for r in rings))
    proj = [[(p[0] * math.cos(lat0), -p[1]) for p in r] for r in rings]
    xs = [x for r in proj for x, _ in r]
    ys = [y for r in proj for _, y in r]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    scale = (SIZE - 8) / max(w, h, 1e-9)
    parts = []
    for r in proj:
        pts = [((x - min(xs)) * scale + 4, (y - min(ys)) * scale + 4) for x, y in r]
        pts = _simplify(pts, 0.8)
        if len(pts) < 3:
            continue
        parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z")
    return {"d": "".join(parts), "w": round(w * scale + 8, 1), "h": round(h * scale + 8, 1)}


def main(refresh: bool = False) -> None:
    gj = json.loads(download(NE_URL, RAW / "naturalearth" / "ne_50m_admin_0_countries.geojson",
                             refresh).read_text(encoding="utf-8"))
    by_iso2: dict[str, dict] = {}
    by_iso3: dict[str, dict] = {}
    for f in gj["features"]:
        pr = f["properties"]
        for key in ("ISO_A2", "ISO_A2_EH"):
            v = pr.get(key)
            if v and v != "-99":
                by_iso2.setdefault(v, f)
        for key in ("ISO_A3", "ADM0_A3"):
            v = pr.get(key)
            if v and v != "-99":
                by_iso3.setdefault(v, f)

    ents = pd.read_parquet(OUT / "country_entities.parquet")
    outlines: dict[str, dict] = {}
    new_attrs = []
    missing = []
    for raw in ents["attrs"]:
        a = json.loads(raw)
        f = by_iso2.get(a.get("iso2")) or by_iso3.get(a.get("iso3"))
        if not f:
            missing.append(a.get("iso2"))
            new_attrs.append(raw)
            continue
        rings = _polygons(f["geometry"])
        main_rings = mainland(rings)
        area = sum(ring_area(r) for r in main_rings)
        a["shape"] = {
            "north": round(max(p[1] for r in main_rings for p in r), 2),
            "south": round(min(p[1] for r in main_rings for p in r), 2),
            "east": round(max(p[0] for r in main_rings for p in r), 2),
            "west": round(min(p[0] for r in main_rings for p in r), 2),
            "crosses": crosses(rings),
            # under ~1 deg² (Luxembourg-sized) outlines are blobs: keep out of outline rounds
            "outline_ok": area >= 1.0,
        }
        # outlines: wide east-west (Indonesia's islands) but tight north-south (no Svalbard)
        outlines[a["iso2"]] = outline_path(mainland(rings, dx=40, dy=10))
        new_attrs.append(json.dumps(a, ensure_ascii=False))
    ents["attrs"] = new_attrs
    ents.to_parquet(OUT / "country_entities.parquet", index=False)
    OUTLINES.parent.mkdir(parents=True, exist_ok=True)
    OUTLINES.write_text(json.dumps(outlines, separators=(",", ":")), encoding="utf-8")
    log.info("shapes for %d countries (%d outlines, %.0f KB); no Natural Earth match: %s",
             len(ents) - len(missing), len(outlines), OUTLINES.stat().st_size / 1024, missing)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    main(p.parse_args().refresh)
