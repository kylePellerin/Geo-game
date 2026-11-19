"""Cities: GeoNames cities15000 joined to Wikidata via GeoNames ID (P1566).

Output: out/city_{entities,aliases,relations}.parquet
Requires out/country_entities.parquet (run countries first).

Alias policy: GeoNames name + asciiname, plus Wikidata labels/aliases in ALIAS_LANGS. The GeoNames
`alternatenames` column is NOT used: it contains many machine romanisations ("an dao er cheng")
that would cause false fuzzy matches.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import zipfile

import pandas as pd

from geo_pipeline.common import (
    OUT,
    RAW,
    chunks,
    download,
    log,
    qid,
    setup_logging,
    sparql,
    wikidata_entities,
)
from geo_pipeline.ingest.util import country_resolver, wikidata_aliases, write_outputs
from geo_pipeline.normalize import basic_normalize

CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
GEONAMES_COLS = [
    "geonameid", "name", "asciiname", "alternatenames", "lat", "lon", "fclass", "fcode",
    "cc", "cc2", "admin1", "admin2", "admin3", "admin4", "population", "elevation", "dem",
    "timezone", "modified",
]
# sections of cities, historical, abandoned, destroyed
EXCLUDE_FCODES = {"PPLX", "PPLH", "PPLQ", "PPLW"}


def load_geonames(refresh: bool) -> pd.DataFrame:
    z = download(CITIES_URL, RAW / "geonames" / "cities15000.zip", refresh)
    with zipfile.ZipFile(z) as zf, zf.open("cities15000.txt") as f:
        df = pd.read_csv(
            f, sep="\t", header=None, names=GEONAMES_COLS, dtype=str,
            keep_default_na=False, quoting=3,
        )
    df = df[~df["fcode"].isin(EXCLUDE_FCODES)].copy()
    df["population"] = pd.to_numeric(df["population"], errors="coerce")
    df["lat"] = pd.to_numeric(df["lat"])
    df["lon"] = pd.to_numeric(df["lon"])
    return df


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def name_distance_join(
    df: pd.DataFrame, country_ids: set[str], refresh: bool, max_km: float = 20.0
) -> dict:
    """{df index: (qid, sitelinks)} for rows matching a Wikidata item by name within max_km.

    GeoNames alternatenames are used here for matching only (never as aliases).
    """
    resolve = country_resolver(refresh)
    by_country: dict[str, dict[str, list[tuple[str, float, float, int]]]] = {}
    for cid in sorted(country_ids):
        rows = sparql(
            f"""SELECT DISTINCT ?item ?label ?coord ?sitelinks WHERE {{
  ?item wdt:P17 wd:{cid} ; wdt:P1082 ?pop ; wdt:P625 ?coord ; wikibase:sitelinks ?sitelinks .
  FILTER(?pop >= 10000)
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")
}}""",
            f"city-pop-{cid}", refresh,
        )
        idx: dict[str, list] = {}
        for r in rows:
            q = qid(r["item"])
            m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", r["coord"])
            if not m or q in country_ids:
                continue
            lon, lat = float(m.group(1)), float(m.group(2))
            idx.setdefault(basic_normalize(r["label"]), []).append(
                (q, lat, lon, int(r["sitelinks"]))
            )
        by_country[cid] = idx

    out = {}
    for i, r in zip(df.index, df.itertuples(index=False)):
        country, _ = resolve(r.cc)
        idx = by_country.get(country or "")
        if not idx:
            continue
        names = {r.name, r.asciiname, *r.alternatenames.split(",")}
        best = None
        for n in {basic_normalize(x) for x in names if x}:
            for q, lat, lon, sl in idx.get(n, ()):
                if haversine_km(r.lat, r.lon, lat, lon) <= max_km and (best is None or sl > best[1]):
                    best = (q, sl)
        if best:
            out[i] = best
    return out


def main(refresh: bool = False) -> None:
    df = load_geonames(refresh)
    log.info("geonames cities after filter: %d", len(df))

    admin1 = pd.read_csv(
        download(ADMIN1_URL, RAW / "geonames" / "admin1CodesASCII.txt", refresh),
        sep="\t", header=None, names=["code", "name", "asciiname", "geonameid"], dtype=str,
        keep_default_na=False,
    ).set_index("code")["name"].to_dict()

    # --- countries / territories
    countries = pd.read_parquet(OUT / "country_entities.parquet")
    capitals = {
        q: cid for cid, a in zip(countries.id, countries["attrs"])
        for q in json.loads(a).get("capital_qids", [])
    }
    resolve = country_resolver(refresh)
    country_attrs = {
        cid: {**json.loads(a), "name": n}
        for cid, n, a in zip(countries.id, countries.name, countries["attrs"])
    }

    # --- Wikidata: QIDs by GeoNames ID
    ids = df["geonameid"].tolist()
    by_gn: dict[str, tuple[str, int]] = {}
    for i, batch in enumerate(chunks(ids, 2000)):
        values = " ".join(f'"{g}"' for g in batch)
        rows = sparql(
            f"""SELECT ?item ?gn ?sitelinks WHERE {{
  VALUES ?gn {{ {values} }}
  ?item wdt:P1566 ?gn ; wikibase:sitelinks ?sitelinks .
}}""",
            f"city-gn-{i:03d}", refresh,
        )
        for r in rows:
            q, sl = qid(r["item"]), int(r["sitelinks"])
            if r["gn"] not in by_gn or sl > by_gn[r["gn"]][1]:
                by_gn[r["gn"]] = (q, sl)
    log.info("cities with QID: %d / %d", len(by_gn), len(df))

    df["qid"] = df["geonameid"].map(lambda g: by_gn.get(g, (None, 0))[0]).astype(object)
    df["sitelinks"] = df["geonameid"].map(lambda g: by_gn.get(g, (None, 0))[1])

    # Wikidata's P1566 often points at a municipality/admin GeoNames record rather than the
    # populated place in cities15000 (Madrid: P1566=6359304, cities15000 row 3117735). Second join:
    # per-country Wikidata items with population, matched by name + distance. Take it when it is
    # better linked than the P1566 match. Country items (city-states) are never used for cities.
    upgrades = name_distance_join(df, set(countries.id), refresh)
    n_up = 0
    for idx, (q2, sl2) in upgrades.items():
        if sl2 > df.at[idx, "sitelinks"] and q2 != df.at[idx, "qid"]:
            df.at[idx, "qid"], df.at[idx, "sitelinks"] = q2, sl2
            n_up += 1
    log.info("name+distance join improved %d city QIDs", n_up)

    # one QID can be claimed by several GeoNames rows: the most populous keeps it
    df = df.sort_values("population", ascending=False)
    dup = df["qid"].notna() & df["qid"].duplicated()
    holder = df[df["qid"].notna() & ~dup].set_index("qid")[["lat", "lon"]]
    near = pd.Series(False, index=df.index)
    for i in df.index[dup]:
        h = holder.loc[df.at[i, "qid"]]
        near[i] = haversine_km(df.at[i, "lat"], df.at[i, "lon"], h["lat"], h["lon"]) <= 20
    # near the bigger row: a GeoNames duplicate of the same city (Visakhapatnam) -> drop;
    # elsewhere: a different place wrongly sharing the QID -> keep without a QID
    log.info("QID shared with a bigger city: %d duplicates dropped, %d kept without QID",
             int(near.sum()), int((dup & ~near).sum()))
    df = df[~near].copy()
    dup = dup[df.index]
    df.loc[dup, "qid"] = None
    df.loc[dup, "sitelinks"] = 0

    qids = df["qid"].dropna().tolist()
    wde = wikidata_entities(qids, "cities", refresh)

    entities, aliases, relations = [], [], []
    skipped_cc: dict[str, int] = {}
    df["qid"] = df["qid"].where(df["qid"].notna(), None)  # NaN is truthy; use None
    for r in df.itertuples(index=False):
        country, territory = resolve(r.cc)
        if country is None:
            skipped_cc[r.cc] = skipped_cc.get(r.cc, 0) + 1
            continue
        eid = r.qid or f"geonames:{r.geonameid}"
        wd = wde.get(r.qid) if r.qid else None
        attrs = {
            "geonames_id": int(r.geonameid),
            "population": int(r.population) if r.population == r.population else None,
            "population_source": "geonames",
            "feature_code": r.fcode,
            "admin1": admin1.get(f"{r.cc}.{r.admin1}"),
            "iso2": r.cc,
            "territory": territory,
            # Wikidata P36 of the country, or GeoNames' capital feature code
            "is_capital": (capitals.get(r.qid) == country if r.qid else False)
            or (r.fcode == "PPLC" and territory is None),
            "elevation_m": int(r.dem) if r.dem.lstrip("-").isdigit() else None,
            "timezone": r.timezone,
            "enwiki": wd.get("enwiki") if wd else None,
            "wikidata_sitelinks": int(r.sitelinks) if r.qid else None,
        }
        # City-states (Singapore, Monaco, Vatican City): the city item usually has no enwiki
        # article, so borrow the country's for popularity.
        cattrs = country_attrs.get(country, {})
        if (attrs["is_capital"] and not attrs["enwiki"] and territory is None
                and basic_normalize(r.name) == basic_normalize(cattrs.get("name", ""))):
            attrs["enwiki"] = cattrs.get("enwiki")
            attrs["wikidata_sitelinks"] = cattrs.get("wikidata_sitelinks")
            attrs["city_state"] = True
        # GeoNames name is the local form; prefer the English Wikidata label for display
        name = (wd or {}).get("labels", {}).get("en") or r.name
        entities.append({
            "id": eid, "type": "city", "name": name, "country_id": country,
            "lat": r.lat, "lon": r.lon, "attrs": attrs,
            "sources": ["geonames"] + (["wikidata"] if r.qid else []),
        })
        aliases.append((eid, r.name, "label" if not wd else "geonames"))
        if r.asciiname and r.asciiname != r.name:
            aliases.append((eid, r.asciiname, "geonames"))
        aliases.extend(wikidata_aliases(eid, wd))
        relations.append({"a": eid, "rel": "located_in", "b": country, "attrs": {}})
    if skipped_cc:
        log.warning("cities skipped (country not in set, no sovereign): %s", skipped_cc)

    missing_capitals = set(capitals) - set(df["qid"].dropna())
    if missing_capitals:
        log.warning("capital QIDs not found among cities: %s", sorted(missing_capitals))

    write_outputs("city", entities, aliases, relations)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="re-download cached sources")
    main(p.parse_args().refresh)
