"""Natural features, landmarks and regions from Wikidata (Phase 6).

Output: out/<type>_{entities,aliases,relations}.parquet for each type below.
Requires out/country_entities.parquet (countries are Wikidata QIDs, so P17 joins directly).

Types (one type per entity; the most specific spec wins when an item matches several):
  mountain  - mountains, summits and volcanoes (attrs.volcano), elevation, prominence
  river     - rivers: length, countries, mouth
  lake      - lakes: area, countries
  island    - islands: area, country
  landmark  - one broad "place to visit" type with attrs.kind: national_park, waterfall, desert,
              canyon, cave, tower, castle, palace, cathedral, temple, mosque, bridge, statue,
              monument, skyscraper, archaeological_site, fortification, mausoleum, museum, plus
              attrs.unesco (World Heritage Site). One type, so "Name a UNESCO site in Italy"
              never misfires as "that looks like a national park".
  region    - first-level administrative divisions (US states, Canadian provinces, German
              Länder, ...), attrs.region_kind = the class label ("U.S. state").

Each spec keeps only items with at least `min_sitelinks` Wikipedia/Wikimedia sitelinks: a cheap
notability filter that drops the long tail nobody will type.
"""

from __future__ import annotations

import argparse
import re
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import unquote

import pandas as pd
import yaml

from geo_pipeline.common import (
    OUT,
    PIPELINE_DIR,
    chunks,
    log,
    qid,
    setup_logging,
    sparql,
    wikidata_entities,
)
from geo_pipeline.ingest.util import REALM_TO_COUNTRY, wikidata_aliases, write_outputs


@dataclass(frozen=True)
class Spec:
    etype: str
    kind: str
    classes: tuple[str, ...]
    min_sitelinks: int
    # extra numeric properties: attr name -> Wikidata property (first value, in SI-ish units)
    numbers: dict[str, str] = field(default_factory=dict)
    # optional: a full WHERE pattern instead of "?item wdt:P31 <class>"
    where: str | None = None
    # also match subclasses up to two levels down (Lake Geneva is a "glacial lake",
    # Kilimanjaro a "dormant volcano"); queried in chunks of classes to stay under the timeout
    subclasses: bool = False


ELEV = {"elevation_m": "P2044"}
SPECS = [
    # landmarks first: an item that is both a landmark and e.g. a mountain keeps the first type
    # seen, except mountains/rivers/lakes/islands, which win (see TYPE_PRIORITY)
    Spec("mountain", "volcano", ("Q8072",), 12, {**ELEV, "prominence_m": "P2660"},
         subclasses=True),
    Spec("mountain", "mountain", ("Q8502", "Q207326"), 15, {**ELEV, "prominence_m": "P2660"},
         subclasses=True),
    Spec("river", "river", ("Q4022",), 15, {"length_km": "P2043", "discharge": "P2225"},
         subclasses=True),
    Spec("lake", "lake", ("Q23397", "Q131681"), 15, {"area_km2": "P2046", **ELEV},
         subclasses=True),
    Spec("island", "island", ("Q23442",), 20, {"area_km2": "P2046", **ELEV}, subclasses=True),
    # curated icons (data/landmarks.yaml); first among landmarks so they keep kind "famous"
    Spec("landmark", "famous", (), 0, {"height_m": "P2048"}, where="FAMOUS"),
    Spec("landmark", "national_park", ("Q46169",), 10, {"area_km2": "P2046"}, subclasses=True),
    Spec("landmark", "waterfall", ("Q34038",), 10, {"height_m": "P2048"}, subclasses=True),
    Spec("landmark", "desert", ("Q8514",), 10, {"area_km2": "P2046"}, subclasses=True),
    Spec("landmark", "canyon", ("Q150784",), 12, {}),
    Spec("landmark", "cave", ("Q35509",), 15, {}),
    Spec("landmark", "unesco", (), 12, {},
         where="?item wdt:P1435 wd:Q9259 ; wdt:P757 []"),
    Spec("landmark", "tower", ("Q12518",), 30, {"height_m": "P2048"}),
    Spec("landmark", "skyscraper", ("Q11303",), 35, {"height_m": "P2048"}),
    Spec("landmark", "castle", ("Q23413",), 30, {}),
    Spec("landmark", "palace", ("Q16560",), 30, {}),
    Spec("landmark", "cathedral", ("Q2977",), 35, {}),
    Spec("landmark", "temple", ("Q44539",), 30, {}),
    Spec("landmark", "mosque", ("Q32815",), 35, {}),
    Spec("landmark", "mausoleum", ("Q162875",), 30, {}),
    Spec("landmark", "bridge", ("Q12280",), 30, {"length_km": "P2043"}),
    Spec("landmark", "statue", ("Q179700",), 30, {"height_m": "P2048"}),
    Spec("landmark", "monument", ("Q4989906",), 35, {}),
    Spec("landmark", "archaeological_site", ("Q839954",), 30, {}),
    Spec("landmark", "fortification", ("Q57821",), 35, {}),
    Spec("landmark", "museum", ("Q33506",), 50, {}),
    Spec("region", "region", (), 20, {"population": "P1082", "area_km2": "P2046"},
         where="?item wdt:P31 ?cls . ?cls wdt:P279* wd:Q10864048 . "
               "FILTER NOT EXISTS { ?item wdt:P576 [] }"),
]
# when an item matches specs of different types, this type wins (lower = stronger)
TYPE_PRIORITY = {"region": 0, "mountain": 1, "river": 2, "lake": 3, "island": 4, "landmark": 5}

TYPES = sorted({s.etype for s in SPECS})

# "Yellowstone National Park" -> "Yellowstone"; "Victoria Falls" stays (no generic suffix rule)
_STRIP = re.compile(
    r"\s+(national park|national monument|world heritage site|cathedral|castle|palace|tower|"
    r"mosque|temple|bridge|desert|cave|caves|canyon|falls|waterfall)$", re.IGNORECASE)


def derived_names(name: str, kind: str) -> list[str]:
    out = []
    m = _STRIP.search(name)
    if m and kind in ("national_park", "unesco") and len(name) - len(m.group(0)) >= 4:
        out.append(name[: m.start()])
    # "Mount Everest" <-> "Everest" handled by the normaliser's type affixes
    if " (" in name:
        out.append(name.split(" (")[0])
    return out


def _famous_where() -> str:
    from urllib.parse import quote

    titles = yaml.safe_load((PIPELINE_DIR / "data" / "landmarks.yaml").read_text(encoding="utf-8"))
    values = " ".join(
        f"<https://en.wikipedia.org/wiki/{quote(t.replace(' ', '_'), safe='()_,-')}>"
        for t in dict.fromkeys(titles["titles"]))
    return f"VALUES ?article {{ {values} }} ?article schema:about ?item"


def _core_query(s: Spec) -> str:
    if s.where == "FAMOUS":
        s = Spec(s.etype, s.kind, s.classes, s.min_sitelinks, s.numbers, where=_famous_where())
    where = (s.where.rstrip(" .") + " .") if s.where else (
        "VALUES ?cls { " + " ".join(f"wd:{c}" for c in s.classes) + " } ?item wdt:P31 ?cls .")
    return f"""SELECT DISTINCT ?item ?n WHERE {{
  {where}
  ?item wikibase:sitelinks ?n . FILTER(?n >= {s.min_sitelinks})
}}"""


def _core_rows(s: Spec, refresh: bool) -> list[dict]:
    rows = sparql(_core_query(s), f"features-core-{s.etype}-{s.kind}", refresh)
    if not s.subclasses:
        return rows
    classes: set[str] = set()
    for base in s.classes:
        classes |= {qid(r["cls"]) for r in sparql(
            f"SELECT DISTINCT ?cls WHERE {{ ?cls wdt:P279?/wdt:P279? wd:{base} }}",
            f"subclasses2-{base}", refresh)}
    extra = sorted(classes - set(s.classes))
    for i, batch in enumerate(chunks(extra, 25)):
        rows += sparql(_core_query(Spec(s.etype, s.kind, tuple(batch), s.min_sitelinks)),
                       f"features-core-{s.etype}-{s.kind}-sub{i:02d}", refresh)
    return rows


def _details(qids: list[str], name: str, refresh: bool) -> dict[str, dict]:
    """Coordinates, countries, continents and class labels for many items (batched)."""
    out: dict[str, dict] = defaultdict(lambda: {"countries": [], "continents": [], "classes": [],
                                                "coord": None, "sitelinks": 0, "located": []})
    for i, batch in enumerate(chunks(qids, 400)):
        values = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(
            f"""SELECT ?item ?n ?coord ?country ?continent ?clsLabel ?admin WHERE {{
  VALUES ?item {{ {values} }}
  ?item wikibase:sitelinks ?n .
  OPTIONAL {{ ?item wdt:P625 ?coord }}
  OPTIONAL {{ ?item wdt:P17 ?country }}
  OPTIONAL {{ ?item wdt:P30 ?continent }}
  OPTIONAL {{ ?item wdt:P31 ?cls }}
  OPTIONAL {{ ?item wdt:P131 ?admin }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}""",
            f"features-{name}-details-{i:03d}", refresh,
        )
        for r in rows:
            d = out[qid(r["item"])]
            d["sitelinks"] = int(r["n"])
            if r.get("coord") and not d["coord"]:
                m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", r["coord"])
                if m:
                    d["coord"] = (float(m.group(2)), float(m.group(1)))
            for key, col in (("countries", "country"), ("continents", "continent"),
                             ("located", "admin")):
                if r.get(col):
                    v = qid(r[col])
                    if v not in d[key]:
                        d[key].append(v)
            if r.get("clsLabel") and r["clsLabel"] not in d["classes"]:
                d["classes"].append(r["clsLabel"])
    return out


def _numbers(qids: list[str], props: dict[str, str], name: str, refresh: bool) -> dict[str, dict]:
    """First (preferred-rank first) numeric value of each property, normalised units."""
    out: dict[str, dict] = defaultdict(dict)
    if not props:
        return out
    for i, batch in enumerate(chunks(qids, 400)):
        values = " ".join(f"wd:{q}" for q in batch)
        for attr, prop in props.items():
            rows = sparql(
                f"""SELECT ?item ?v ?unit ?rank WHERE {{
  VALUES ?item {{ {values} }}
  ?item p:{prop} ?st . ?st wikibase:rank ?rank ; psv:{prop} [ wikibase:quantityAmount ?v ;
                                                              wikibase:quantityUnit ?unit ] .
  FILTER(?rank != wikibase:DeprecatedRank)
}}""",
                f"features-{name}-{attr}-{i:03d}", refresh,
            )
            best: dict[str, tuple[int, float]] = {}
            for r in rows:
                v = _to_unit(float(r["v"]), qid(r["unit"]), attr)
                if v is None:
                    continue
                pref = 0 if r["rank"].endswith("PreferredRank") else 1
                q = qid(r["item"])
                if q not in best or pref < best[q][0]:
                    best[q] = (pref, v)
            for q, (_, v) in best.items():
                out[q][attr] = round(v, 1)
    return out


# unit QIDs: metre Q11573, kilometre Q828224, foot Q3710, mile Q253276, km² Q712226,
# m² Q25343, acre Q81292, hectare Q35852, square mile Q232291, m³/s Q794261
_UNITS = {
    "Q11573": ("m", 1.0), "Q828224": ("m", 1000.0), "Q3710": ("m", 0.3048),
    "Q253276": ("m", 1609.344), "Q712226": ("m2", 1e6), "Q25343": ("m2", 1.0),
    "Q81292": ("m2", 4046.86), "Q35852": ("m2", 1e4), "Q232291": ("m2", 2.58999e6),
    "Q794261": ("m3s", 1.0), "Q199": ("count", 1.0),
}


def _to_unit(v: float, unit: str, attr: str) -> float | None:
    if attr == "population":
        return v
    kind, factor = _UNITS.get(unit, (None, None))
    if kind is None:
        return None
    if attr.endswith("_km2"):
        return v * factor / 1e6 if kind == "m2" else None
    if attr.endswith("_km"):
        return v * factor / 1000 if kind == "m" else None
    if attr.endswith("_m"):
        return v * factor if kind == "m" else None
    if attr == "discharge":
        return v if kind == "m3s" else None
    return None


def main(refresh: bool = False) -> None:
    countries = pd.read_parquet(OUT / "country_entities.parquet")
    country_ids = set(countries.id)
    # ids the core ingests already own (country, city, airport): those keep the plain QID
    taken: set[str] = set()
    for t in ("country", "city", "airport"):
        path = OUT / f"{t}_entities.parquet"
        if path.exists():
            taken |= set(pd.read_parquet(path, columns=["id"])["id"])
    continent_names = {"Q15": "Africa", "Q48": "Asia", "Q46": "Europe", "Q49": "North America",
                       "Q18": "South America", "Q538": "Oceania", "Q55643": "Oceania",
                       "Q51": "Antarctica"}

    # 1. which items, and which spec each belongs to
    owner: dict[str, Spec] = {}
    famous: set[str] = set()
    for s in SPECS:
        rows = _core_rows(s, refresh)
        new = 0
        for r in rows:
            q = qid(r["item"])
            cur = owner.get(q)
            if s.kind == "famous":
                famous.add(q)
            if cur is None or TYPE_PRIORITY[s.etype] < TYPE_PRIORITY[cur.etype]:
                owner[q] = s
                new += 1
        log.info("%s/%s: %d items (%d assigned)", s.etype, s.kind, len(rows), new)
    # UNESCO status for everything (a castle or national park can be a World Heritage Site)
    unesco = {qid(r["item"]) for r in sparql(
        "SELECT ?item WHERE { ?item wdt:P1435 wd:Q9259 }", "features-unesco-all", refresh)}

    qids = sorted(owner)
    details = _details(qids, "all", refresh)
    numbers: dict[str, dict] = defaultdict(dict)
    for etype in TYPES:
        props: dict[str, str] = {}
        for s in SPECS:
            if s.etype == etype:
                props.update(s.numbers)
        mine = [q for q in qids if owner[q].etype == etype]
        for q, vals in _numbers(mine, props, etype, refresh).items():
            numbers[q].update(vals)
    wde = wikidata_entities(qids, "features", refresh)

    for etype in TYPES:
        entities, aliases, relations = [], [], []
        for q in qids:
            s = owner[q]
            if s.etype != etype:
                continue
            e = wde.get(q) or {}
            name = (e.get("labels") or {}).get("en")
            if not name and e.get("enwiki"):
                # a few items come back without an English label (Arizona): use the article title
                name = unquote(e["enwiki"]).replace("_", " ").split(" (")[0]
            if not name or re.fullmatch(r"Q\d+", name):
                continue
            d = details[q]
            eid = q
            if q in taken:
                # city-states (Hamburg, Prague, Vienna) are also first-level regions: give the
                # region facet its own id so "Name a German state" still accepts Hamburg.
                # Other overlaps (a city that is also an island/landmark) stay a city.
                if etype != "region":
                    continue
                eid = f"{q}#region"
            cs = [REALM_TO_COUNTRY.get(c, c) for c in d["countries"]]
            cs = [c for c in dict.fromkeys(cs) if c in country_ids]
            if etype in ("landmark", "island", "region") and not cs:
                continue  # no country: Antarctic islands, disputed odds and ends
            attrs = {
                "kind": s.kind,
                "countries": cs,
                "continents": [continent_names[c] for c in d["continents"] if c in continent_names],
                "wikidata_sitelinks": d["sitelinks"],
                "enwiki": e.get("enwiki"),
                **numbers.get(q, {}),
            }
            if s.kind == "volcano" or any("volcano" in c for c in d["classes"]):
                attrs["volcano"] = True
            if q in unesco:
                attrs["unesco"] = True
            if q in famous:
                attrs["famous"] = True
                if etype == "landmark":
                    kinds = [c for c in d["classes"] if c not in ("tourist attraction",)]
                    attrs["kind"] = "famous"
                    attrs["class"] = kinds[0] if kinds else "landmark"
            if etype == "region":
                kinds = [c for c in d["classes"] if c != "first-level administrative division"]
                attrs["region_kinds"] = kinds
                attrs["region_kind"] = kinds[0] if kinds else "region"
            if etype == "landmark" and s.kind == "unesco":
                attrs["kind"] = "heritage_site"
            lat, lon = d["coord"] or (None, None)
            entities.append({"id": eid, "type": etype, "name": name,
                             "country_id": cs[0] if cs else None, "lat": lat, "lon": lon,
                             "attrs": attrs, "sources": ["wikidata"]})
            aliases.extend((eid, al, k) for _, al, k in wikidata_aliases(q, e))
            for alt in derived_names(name, attrs["kind"]):
                aliases.append((eid, alt, "derived"))
            if e.get("enwiki"):
                title = unquote(e["enwiki"]).replace("_", " ")
                if title != name:
                    aliases.append((eid, title.split(" (")[0], "enwiki"))
            for c in cs:
                relations.append({"a": eid, "rel": "located_in", "b": c, "attrs": {}})
        log.info("%s: %d entities", etype, len(entities))
        write_outputs(etype, entities, aliases, relations)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    main(p.parse_args().refresh)
