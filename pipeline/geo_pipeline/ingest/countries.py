"""Countries: mledoze/countries + Wikidata + World Bank population.

Output: out/country_{entities,aliases,relations}.parquet
Country set (POLICY.md): UN members + observers (Vatican, Palestine) + allowlist (Kosovo, Taiwan).
"""

from __future__ import annotations

import argparse
import json

import pandas as pd

from geo_pipeline.common import (
    OUT,
    RAW,
    download,
    log,
    qid,
    setup_logging,
    sparql,
    wikidata_entities,
)
from geo_pipeline.ingest.util import wikidata_aliases, write_outputs

MLEDOZE_URL = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
WB_POP_URL = (
    "https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL"
    "?format=json&per_page=20000&mrnev=1"
)

# Non-UN-member entries we include, by mledoze cca3 (Kosovo is "UNK" in mledoze).
OBSERVERS = {"VAT", "PSE"}
ALLOWLIST = {"UNK", "TWN"}
# mledoze cca3 -> World Bank code where they differ
WB_CODE = {"UNK": "XKX"}

# Where several Wikidata items share an ISO code, pin the one players mean.
QID_OVERRIDES = {"NL": "Q55"}  # Netherlands (country), not Kingdom of the Netherlands (Q29999)

LEFT, RIGHT = "Q11920728", "Q14565199"
ISLAND_NATION = "Q112099"


def continent_of(region: str, subregion: str) -> str:
    if region == "Americas":
        return "South America" if subregion == "South America" else "North America"
    return {"Antarctic": "Antarctica"}.get(region, region)


def main(refresh: bool = False) -> None:
    raw = json.loads(
        download(MLEDOZE_URL, RAW / "mledoze" / "countries.json", refresh).read_text("utf-8")
    )
    countries = [
        c for c in raw if c["unMember"] or c["cca3"] in OBSERVERS | ALLOWLIST
    ]
    log.info("country set: %d", len(countries))

    # --- Wikidata: QID by ISO alpha-2, plus driving side, capitals, population fallback
    fields = """
  OPTIONAL { ?item p:P1622 ?ds . ?ds ps:P1622 ?drive .
             FILTER NOT EXISTS { ?ds pq:P582 [] } }  # skip ended statements
  OPTIONAL { ?item wdt:P36 ?capital }
  OPTIONAL { ?item p:P1082 ?ps . ?ps a wikibase:BestRank ; ps:P1082 ?pop .
             OPTIONAL { ?ps pq:P585 ?popTime } }
  ?item wikibase:sitelinks ?sitelinks ."""
    select = "SELECT ?item ?iso2 ?drive ?capital ?pop ?popTime ?sitelinks WHERE {"
    rows = sparql(f"{select}\n  ?item wdt:P297 ?iso2 .{fields}\n}}", "countries", refresh)
    values = " ".join(f'(wd:{q} "{iso}")' for iso, q in QID_OVERRIDES.items())
    rows += sparql(
        f"{select}\n  VALUES (?item ?iso2) {{ {values} }}{fields}\n}}", "country-overrides", refresh
    )
    by_iso: dict[str, dict] = {}
    for r in rows:
        q = qid(r["item"])
        if r["iso2"] in QID_OVERRIDES and q != QID_OVERRIDES[r["iso2"]]:
            continue
        cur = by_iso.get(r["iso2"])
        # several items can share an ISO code (Cyprus the island): keep most-linked item
        if cur is None or (cur["qid"] != q and int(r["sitelinks"]) > cur["sitelinks"]):
            cur = by_iso[r["iso2"]] = {
                "qid": q, "sitelinks": int(r["sitelinks"]), "drive": set(),
                "capitals": set(), "pop": None, "pop_year": None,
            }
        if cur["qid"] != q:
            continue
        if r.get("drive"):
            cur["drive"].add(qid(r["drive"]))
        if r.get("capital"):
            cur["capitals"].add(qid(r["capital"]))
        if r.get("pop"):
            year = int(r["popTime"][:4]) if r.get("popTime") else None
            if cur["pop_year"] is None or (year or 0) > cur["pop_year"]:
                cur["pop"], cur["pop_year"] = float(r["pop"]), year

    islands = {
        qid(r["item"])
        for r in sparql(
            f"SELECT ?item WHERE {{ ?item wdt:P31 wd:{ISLAND_NATION} ; wdt:P297 [] }}",
            "island-nations", refresh,
        )
    }

    # --- World Bank population (most recent value)
    wb = json.loads(
        download(WB_POP_URL, RAW / "worldbank" / "SP.POP.TOTL.json", refresh).read_text("utf-8")
    )[1]
    wb_pop: dict[str, tuple[float, int]] = {}
    for d in wb:  # the API returns several years per country; keep the latest
        if d["value"] is not None:
            code, year = d["countryiso3code"], int(d["date"])
            if code not in wb_pop or year > wb_pop[code][1]:
                wb_pop[code] = (d["value"], year)

    cca3_to_qid: dict[str, str] = {}
    entities, aliases, relations = [], [], []
    for c in countries:
        wd = by_iso.get(c["cca2"])
        if wd is None:
            raise SystemExit(f"no Wikidata item for {c['cca2']} {c['name']['common']}")
        q = wd["qid"]
        cca3_to_qid[c["cca3"]] = q
        pop, pop_year, pop_src = None, None, None
        if (wbv := wb_pop.get(WB_CODE.get(c["cca3"], c["cca3"]))) is not None:
            pop, pop_year, pop_src = wbv[0], wbv[1], "worldbank"
        elif wd["pop"] is not None:
            pop, pop_year, pop_src = wd["pop"], wd["pop_year"], "wikidata"
        drive = (
            "left" if wd["drive"] == {LEFT} else "right" if wd["drive"] == {RIGHT}
            else "mixed" if wd["drive"] else None
        )
        lat, lon = (c.get("latlng") or [None, None])[:2]
        attrs = {
            "iso2": c["cca2"], "iso3": c["cca3"] if c["cca3"] != "UNK" else "XKX",
            "official_name": c["name"]["official"],
            "continent": continent_of(c["region"], c["subregion"]),
            "region": c["region"], "subregion": c["subregion"],
            "un_member": bool(c["unMember"]) and c["cca3"] != "VAT",
            "un_status": (
                "member" if c["unMember"] and c["cca3"] != "VAT"
                else "observer" if c["cca3"] in OBSERVERS else "non_member"
            ),
            "landlocked": bool(c["landlocked"]),
            "island_nation": q in islands,
            "area_km2": c.get("area"),
            "population": pop, "population_year": pop_year, "population_source": pop_src,
            "drives_on": drive,
            "capital_names": c.get("capital", []),
            "capital_qids": sorted(wd["capitals"]),
            "languages": sorted(c.get("languages", {}).values()),
            "currencies": sorted(c.get("currencies", {}).keys()),
            "currency_names": sorted(v["name"] for v in c.get("currencies", {}).values()),
            "flag_emoji": c.get("flag"),
            "demonym": (c.get("demonyms", {}).get("eng") or {}).get("m"),
            "tld": (c.get("tld") or [None])[0],
            "calling_code": (
                c["idd"]["root"] + c["idd"]["suffixes"][0]
                if c.get("idd", {}).get("root") and len(c["idd"].get("suffixes", [])) == 1
                else c.get("idd", {}).get("root")
            ),
            "native_names": sorted({t["common"] for t in c["name"].get("native", {}).values()}),
            "wikidata_sitelinks": wd["sitelinks"],
        }
        entities.append({
            "id": q, "type": "country", "name": c["name"]["common"], "country_id": q,
            "lat": lat, "lon": lon, "attrs": attrs,
            "sources": ["mledoze", "wikidata"] + (["worldbank"] if pop_src == "worldbank" else []),
        })
        # aliases from mledoze
        aliases.append((q, c["name"]["common"], "label"))
        aliases.append((q, c["name"]["official"], "official"))
        aliases.append((q, attrs["iso3"], "code"))
        for s in c.get("altSpellings", []):
            if len(s) > 2:  # skip 2-letter codes ("NO", "IS", "IN"...)
                aliases.append((q, s, "altlabel"))
        for lang, t in c.get("translations", {}).items():
            aliases.append((q, t["common"], f"lang:{lang}"))
        for lang, t in c["name"].get("native", {}).items():
            aliases.append((q, t["common"], f"native:{lang}"))
            aliases.append((q, t["official"], f"native:{lang}"))

    # Wikidata labels/aliases in major languages
    wde = wikidata_entities(cca3_to_qid.values(), "countries", refresh)
    for q in cca3_to_qid.values():
        aliases.extend(wikidata_aliases(q, wde.get(q)))
    enwiki = {q: (wde.get(q) or {}).get("enwiki") for q in cca3_to_qid.values()}
    for e in entities:
        e["attrs"]["enwiki"] = enwiki.get(e["id"])

    # borders (symmetric in source; keep only pairs inside our country set)
    seen = set()
    for c in countries:
        a = cca3_to_qid[c["cca3"]]
        for b3 in c.get("borders", []):
            if (b := cca3_to_qid.get(b3)) and (a, b) not in seen:
                seen.add((a, b))
                relations.append({"a": a, "rel": "borders", "b": b, "attrs": {}})
    asym = [(a, b) for a, b in seen if (b, a) not in seen]
    if asym:
        # e.g. mledoze lists India as bordering Sri Lanka (no land border): keep only mutual pairs
        log.warning("dropping one-way borders: %s", asym)
        relations = [r for r in relations if (r["b"], r["a"]) in seen]

    write_outputs("country", entities, aliases, relations)
    pd.Series(cca3_to_qid).to_json(OUT / "country_cca3_to_qid.json")


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="re-download cached sources")
    main(p.parse_args().refresh)
