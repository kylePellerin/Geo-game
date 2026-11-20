"""Airports: OurAirports (large + medium, IATA code, scheduled service) joined to Wikidata.

Output: out/airport_{entities,aliases,relations}.parquet
Requires out/country_entities.parquet.

QID join order: ICAO (P239) -> IATA (P238, only if unique) -> enwiki title from OurAirports.
Passengers: Wikidata P3872 with point-in-time (P585); latest year kept as passengers/_year.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from urllib.parse import unquote

import pandas as pd

from geo_pipeline.common import (
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

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
TYPES = {"large_airport", "medium_airport"}


def derived_airport_names(name: str, municipality: str) -> list[str]:
    """Extra names players use: "London Heathrow Airport" -> "Heathrow Airport";
    "Cam Ranh International Airport / Cam Ranh Air Base" -> both halves."""
    parts = [p.strip() for p in name.replace(" – ", " / ").split(" / ") if p.strip()]
    out = parts if len(parts) > 1 else []
    town = (municipality or "").split(",")[0].split(" (")[0].strip()
    for part in parts:
        if town and part.lower().startswith(town.lower() + " ") and len(part) > len(town) + 4:
            out.append(part[len(town) + 1:])
    return list(dict.fromkeys(out))


def main(refresh: bool = False) -> None:
    df = pd.read_csv(
        download(AIRPORTS_URL, RAW / "ourairports" / "airports.csv", refresh),
        dtype=str, keep_default_na=False,
    )
    df = df[
        df["type"].isin(TYPES)
        & (df["iata_code"] != "")
        & (df["scheduled_service"] == "yes")
        & ~df["name"].str.contains(r"\(Duplicate\)", regex=True)
    ].copy()
    log.info("airports after filter: %d", len(df))

    # --- Wikidata codes -> QID
    code_rows = sparql(
        "SELECT ?item ?icao ?iata WHERE { { ?item wdt:P239 ?icao } UNION { ?item wdt:P238 ?iata } }",
        "airport-codes", refresh,
    )
    code_rows += sparql(
        """SELECT ?item ?enwiki WHERE {
  ?item wdt:P238 [] . ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
}""",
        "airport-enwiki", refresh,
    )
    by_icao: dict[str, set[str]] = defaultdict(set)
    by_iata: dict[str, set[str]] = defaultdict(set)
    by_title: dict[str, str] = {}
    for r in code_rows:
        q = qid(r["item"])
        if r.get("icao"):
            by_icao[r["icao"]].add(q)
        if r.get("iata"):
            by_iata[r["iata"]].add(q)
        if r.get("enwiki"):
            by_title[unquote(r["enwiki"].rsplit("/", 1)[-1]).replace("_", " ")] = q

    def match(row) -> tuple[str | None, str]:
        for code in (row.icao_code, row.gps_code, row.ident):
            if code and len(by_icao.get(code, ())) == 1:
                return next(iter(by_icao[code])), "icao"
        if len(by_iata.get(row.iata_code, ())) == 1:
            return next(iter(by_iata[row.iata_code])), "iata"
        if row.wikipedia_link and "en.wikipedia.org/wiki/" in row.wikipedia_link:
            title = unquote(row.wikipedia_link.rsplit("/wiki/", 1)[-1]).replace("_", " ")
            if title in by_title:
                return by_title[title], "enwiki"
        return None, "none"

    matched = [match(r) for r in df.itertuples(index=False)]
    df["qid"] = [m[0] for m in matched]
    log.info("airport QID match: %s", pd.Series([m[1] for m in matched]).value_counts().to_dict())
    dup = df["qid"].notna() & df["qid"].duplicated(keep=False)
    if dup.any():
        log.warning("QID shared by several airports, using source id: %s",
                    df.loc[dup, ["iata_code", "qid"]].values.tolist())
        df.loc[dup, "qid"] = None

    # --- passengers (latest year) and "named after a person"
    pax_rows = sparql(
        # year-precision (9) statements only: some airports also record monthly figures
        """SELECT ?item ?pax ?time WHERE {
  ?item wdt:P238 [] ; p:P3872 ?st . ?st ps:P3872 ?pax ;
    pqv:P585 [ wikibase:timeValue ?time ; wikibase:timePrecision 9 ] .
}""",
        "airport-passengers", refresh,
    )
    pax: dict[str, tuple[int, int]] = {}
    for r in pax_rows:
        q, year, n = qid(r["item"]), int(r["time"][:4]), int(float(r["pax"]))
        if q not in pax or year > pax[q][1] or (year == pax[q][1] and n > pax[q][0]):
            pax[q] = (n, year)

    named_rows = sparql(
        """SELECT ?item ?person ?personLabel WHERE {
  ?item wdt:P238 [] ; wdt:P138 ?person . ?person wdt:P31 wd:Q5 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""",
        "airport-named-after", refresh,
    )
    named: dict[str, list[dict]] = defaultdict(list)
    for r in named_rows:
        named[qid(r["item"])].append({"id": qid(r["person"]), "name": r.get("personLabel")})

    wde = wikidata_entities(df["qid"].dropna().tolist(), "airports", refresh)
    sitelinks: dict[str, int] = {}
    for i, batch in enumerate(chunks(sorted(set(df["qid"].dropna())), 1000)):
        values = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(
            f"SELECT ?item ?n WHERE {{ VALUES ?item {{ {values} }} ?item wikibase:sitelinks ?n }}",
            f"airport-sitelinks-{i:02d}", refresh,
        ):
            sitelinks[qid(r["item"])] = int(r["n"])
    resolve = country_resolver(refresh)
    df["qid"] = df["qid"].astype(object).where(df["qid"].notna(), None)  # NaN is truthy

    entities, aliases, relations = [], [], []
    skipped: dict[str, int] = defaultdict(int)
    for r in df.itertuples(index=False):
        country, territory = resolve(r.iso_country)
        if country is None:
            skipped[r.iso_country] += 1
            continue
        eid = r.qid or f"ourairports:{r.id}"
        wd = wde.get(r.qid) if r.qid else None
        p = pax.get(r.qid) if r.qid else None
        elev_ft = float(r.elevation_ft) if r.elevation_ft else None
        attrs = {
            "ourairports_id": int(r.id),
            "airport_type": r.type.removesuffix("_airport"),  # large | medium
            "iata": r.iata_code, "icao": r.icao_code or r.gps_code or None,
            "municipality": r.municipality or None,
            "iso2": r.iso_country, "territory": territory,
            "region_code": r.iso_region,
            "elevation_m": round(elev_ft * 0.3048) if elev_ft is not None else None,
            "passengers": p[0] if p else None,
            "passengers_year": p[1] if p else None,
            "passengers_source": "wikidata" if p else None,
            "named_after": named.get(r.qid, []) if r.qid else [],
            "enwiki": wd.get("enwiki") if wd else None,
            "wikidata_sitelinks": sitelinks.get(r.qid) if r.qid else None,
        }
        entities.append({
            "id": eid, "type": "airport", "name": r.name, "country_id": country,
            "lat": float(r.latitude_deg), "lon": float(r.longitude_deg), "attrs": attrs,
            "sources": ["ourairports"] + (["wikidata"] if r.qid else []),
        })
        aliases.append((eid, r.name, "label"))
        for derived in derived_airport_names(r.name, r.municipality):
            aliases.append((eid, derived, "derived"))
        aliases.append((eid, r.iata_code, "code"))
        if attrs["icao"]:
            aliases.append((eid, attrs["icao"], "code"))
        for kw in r.keywords.split(","):
            kw = kw.strip()
            if len(kw) > 4:  # keywords often hold former names; short ones are mostly codes
                aliases.append((eid, kw, "keyword"))
        aliases.extend(wikidata_aliases(eid, wd))
        relations.append({"a": eid, "rel": "located_in", "b": country, "attrs": {}})
        # named_after stays in attrs until person entities exist (Phase 6), since relations
        # must reference entities.
    if skipped:
        log.warning("airports skipped (no country): %s", dict(skipped))
    write_outputs("airport", entities, aliases, relations)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="re-download cached sources")
    main(p.parse_args().refresh)
