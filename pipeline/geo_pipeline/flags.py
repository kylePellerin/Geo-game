"""Draft flag tags for every country -> pipeline/flags_tags.yaml (for human review).

Colours are measured: each flag-icons SVG (MIT, app/node_modules/flag-icons) is rendered and every
pixel is classified into a named colour. A colour is a main colour if it covers >= MAIN_SHARE of
the flag, minor if >= MINOR_SHARE (emblem details). Boolean features and stripe orientation come
from data/flag_features_draft.yaml (AI-drafted lists).

The output is meant to be edited by a reviewer, who then sets `reviewed: true`. This script will not
overwrite a reviewed file unless --force is given.
"""

from __future__ import annotations

import argparse
import colorsys
import io
import json
from collections import Counter

import cairosvg
import pandas as pd
import yaml
from PIL import Image

from geo_pipeline.common import DATA, OUT, PIPELINE_DIR, log, setup_logging

FLAG_DIR = PIPELINE_DIR.parent / "app" / "node_modules" / "flag-icons" / "flags" / "4x3"
FEATURES = DATA / "flag_features_draft.yaml"
OUTPUT = PIPELINE_DIR / "flags_tags.yaml"
MAIN_SHARE = 0.02
MINOR_SHARE = 0.003

BOOL_TAGS = [
    "has_star", "has_sun", "has_crescent", "has_cross", "has_nordic_cross", "has_union_jack",
    "has_animal", "has_bird", "has_plant", "has_weapon", "has_text", "has_map",
    "has_coat_of_arms",
]


def classify(r: int, g: int, b: int) -> str:
    """Name a pixel colour in the vocabulary players use for flags."""
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h *= 360
    if v < 0.22:
        return "black"
    if s < 0.18:
        return "white" if v > 0.6 else "black" if v < 0.4 else "grey"
    if h < 15 or h >= 340:
        return "maroon" if v < 0.6 and s > 0.4 else "red"
    if h < 35:
        return "brown" if v < 0.6 else "orange"
    if h < 70:
        return "yellow" if v >= 0.55 else "brown"
    if h < 170:
        return "green"
    if h < 260:
        return "blue"
    return "purple"


def colour_shares(svg_path) -> dict[str, float]:
    png = cairosvg.svg2png(url=str(svg_path), output_width=160, output_height=120)
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    counts: Counter[str] = Counter()
    total = 0
    pixels = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
    for r, g, b, a in pixels:
        if a < 128:
            continue  # transparent (non-rectangular flags like Nepal)
        counts[classify(r, g, b)] += 1
        total += 1
    return {c: n / total for c, n in counts.most_common()}


def main(force: bool = False) -> None:
    if OUTPUT.exists() and not force:
        existing = yaml.safe_load(OUTPUT.read_text(encoding="utf-8")) or {}
        if existing.get("reviewed"):
            raise SystemExit(f"{OUTPUT.name} is marked reviewed; use --force to regenerate")
    if not FLAG_DIR.exists():
        raise SystemExit(f"{FLAG_DIR} missing: run `npm --prefix app install`")

    features = yaml.safe_load(FEATURES.read_text(encoding="utf-8"))
    countries = pd.read_parquet(OUT / "country_entities.parquet")
    known = {json.loads(a)["iso2"] for a in countries["attrs"]}
    for tag, codes in features.items():
        if unknown := set(codes) - known:
            log.warning("%s lists codes not in the country set: %s", tag, sorted(unknown))

    flags = {}
    for name, a in sorted(zip(countries["name"], countries["attrs"])):
        iso2 = json.loads(a)["iso2"]
        svg = FLAG_DIR / f"{iso2.lower()}.svg"
        if not svg.exists():
            log.warning("no flag SVG for %s %s", iso2, name)
            continue
        shares = colour_shares(svg)
        horiz = iso2 in features.get("stripes_horizontal", [])
        vert = iso2 in features.get("stripes_vertical", [])
        tags = {
            "name": name,
            "colors": sorted(c for c, s in shares.items() if s >= MAIN_SHARE),
            "colors_minor": sorted(
                c for c, s in shares.items() if MINOR_SHARE <= s < MAIN_SHARE
            ),
            "stripes": "both" if horiz and vert else "horizontal" if horiz
            else "vertical" if vert else "none",
        }
        tags["n_colors"] = len(tags["colors"])
        for t in BOOL_TAGS:
            tags[t] = iso2 in features.get(t, [])
        flags[iso2] = tags

    header = (
        "# Flag tags, one entry per country (keyed by ISO alpha-2).\n"
        "# colors / colors_minor are measured from the flag-icons SVGs (>=2% / >=0.3% of area);\n"
        "# boolean tags and stripes are AI-drafted from data/flag_features_draft.yaml.\n"
        "# REVIEW: correct any entry in place, then set `reviewed: true`.\n"
        "# Regenerating (python -m geo_pipeline.flags) refuses to overwrite a reviewed file.\n"
    )
    body = yaml.safe_dump(
        {"reviewed": False, "flags": flags}, sort_keys=False, allow_unicode=True, width=100
    )
    OUTPUT.write_text(header + body, encoding="utf-8")
    log.info("wrote %s (%d flags)", OUTPUT.name, len(flags))


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--force", action="store_true", help="overwrite even a reviewed file")
    main(p.parse_args().force)
