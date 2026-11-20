"""Enrich country and city entities with extra attributes for questions and matching rounds.

Runs after the countries/cities/airports ingests and rewrites their Parquet outputs in place:

countries: monarchy (curated data/monarchies.yaml), king_charles (Wikidata P35 = Charles III),
           highest_point {name, elevation_m} (P610 + P2044), named_after_person (P138 humans),
           olympics_hosted [{year, season, city}], forest_pct + forest_year (World Bank).
cities:    olympics / olympics_future [{year, season}] from curated data/olympics.yaml,
           rivers [names] (P206 classified as river; the templates only ask about distinctively named rivers).
           Olympic host towns too small for cities15000 (Lake Placid, Chamonix...) are added as
           city entities so players who name them are recognised.

Idempotent: re-running replaces these attrs (run the cities ingest first to drop added towns).
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import date

import pandas as pd
import yaml

from geo_pipeline.common import (
    DATA,
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
from geo_pipeline.ingest.util import country_resolver, wikidata_aliases
from geo_pipeline.normalize import basic_normalize

CHARLES_III = "Q43274"
HUMAN = "Q5"
CURRENT_YEAR = date.today().year
RIVER = "Q4022"
WB_FOREST_URL = (
    "https://api.worldbank.org/v2/country/all/indicator/AG.LND.FRST.ZS"
    "?format=json&per_page=20000&mrnev=1"
)


def _read(etype: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    return tuple(pd.read_parquet(OUT / f"{etype}_{k}.parquet")
                 for k in ("entities", "aliases", "relations"))


def _write(etype: str, ents: pd.DataFrame, al: pd.DataFrame, rel: pd.DataFrame) -> None:
    ents.to_parquet(OUT / f"{etype}_entities.parquet", index=False)
    al.drop_duplicates().to_parquet(OUT / f"{etype}_aliases.parquet", index=False)
    rel.to_parquet(OUT / f"{etype}_relations.parquet", index=False)


def _update_attrs(ents: pd.DataFrame, extra: dict[str, dict]) -> pd.DataFrame:
    ents = ents.copy()
    ents["attrs"] = [
        json.dumps({**json.loads(a), **extra.get(i, {})}, ensure_ascii=False)
        for i, a in zip(ents["id"], ents["attrs"])
    ]
    return ents


def olympics() -> list[dict]:
    """Curated host list: [{season, year, city, iso2, wikidata_name?}]."""
    doc = yaml.safe_load((DATA / "olympics.yaml").read_text(encoding="utf-8"))
    return [{**g, "season": season} for season, games in doc.items() for g in games]


def resolve_hosts(games: list[dict], ents: pd.DataFrame, al: pd.DataFrame) -> dict[int, str]:
    """{index in games: city entity id}, matching English name/aliases within the country."""
    attrs = ents["attrs"].map(json.loads)
    iso2 = attrs.map(lambda a: a.get("iso2"))
    pop = attrs.map(lambda a: a.get("population") or 0)
    by_name: dict[tuple[str, str], list[tuple[int, str]]] = defaultdict(list)
    for eid, name, cc, p in zip(ents["id"], ents["name"], iso2, pop):
        by_name[(basic_normalize(name), cc)].append((p, eid))
    en = al[al["kind"].isin(["label", "altlabel", "geonames"])]
    cc_of = dict(zip(ents["id"], iso2))
    pop_of = dict(zip(ents["id"], pop))
    for eid, alias in zip(en["entity_id"], en["alias"]):
        by_name[(basic_normalize(alias), cc_of.get(eid))].append((pop_of.get(eid, 0), eid))
    out = {}
    for i, g in enumerate(games):
        hits = by_name.get((basic_normalize(g["city"]), g["iso2"]))
        if hits:
            out[i] = max(hits)[1]
    return out


def enrich_countries(games: list[dict], refresh: bool) -> None:
    ents, al, rel = _read("country")
    attrs = {i: json.loads(a) for i, a in zip(ents["id"], ents["attrs"])}
    iso2_to_id = {a["iso2"]: i for i, a in attrs.items()}
    values = " ".join(f"wd:{q}" for q in ents["id"])
    extra: dict[str, dict] = defaultdict(dict)

    monarchies = yaml.safe_load((DATA / "monarchies.yaml").read_text(encoding="utf-8"))
    for iso2 in monarchies["monarchies"]:
        extra[iso2_to_id[iso2]]["monarchy"] = True
    for i in ents["id"]:
        extra[i].setdefault("monarchy", False)

    for r in sparql(f"""SELECT DISTINCT ?item WHERE {{ VALUES ?item {{ {values} }}
  ?item p:P35 ?st . ?st ps:P35 wd:{CHARLES_III} . FILTER NOT EXISTS {{ ?st pq:P582 [] }} }}""",
                    "country-charles", refresh):
        extra[qid(r["item"])]["king_charles"] = True

    for r in sparql(f"""SELECT ?item ?peak ?peakLabel ?elev WHERE {{ VALUES ?item {{ {values} }}
  ?item wdt:P610 ?peak . ?peak wdt:P2044 ?elev .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}""",
                    "country-highpoint", refresh):
        cur = extra[qid(r["item"])].get("highest_point")
        elev = round(float(r["elev"]))
        if cur is None or elev > cur["elevation_m"]:
            extra[qid(r["item"])]["highest_point"] = {
                "id": qid(r["peak"]), "name": r.get("peakLabel"), "elevation_m": elev}

    for r in sparql(f"""SELECT ?item ?person ?personLabel WHERE {{ VALUES ?item {{ {values} }}
  ?item wdt:P138 ?person . ?person wdt:P31 wd:{HUMAN} .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}""",
                    "country-named-after", refresh):
        extra[qid(r["item"])].setdefault("named_after_person", []).append(
            {"id": qid(r["person"]), "name": r.get("personLabel")})

    cities = pd.read_parquet(OUT / "city_entities.parquet")
    hosted = {(g["iso2"], g["year"], g["season"]) for g in games if g["year"] <= CURRENT_YEAR}
    for iso2, year, season in sorted(hosted):
        if iso2 in iso2_to_id:
            extra[iso2_to_id[iso2]].setdefault("olympics_hosted", []).append(
                {"year": year, "season": season})
    del cities

    wb = json.loads(download(WB_FOREST_URL, RAW / "worldbank" / "AG.LND.FRST.ZS.json",
                             refresh).read_text("utf-8"))[1]
    latest: dict[str, tuple[float, int]] = {}
    for d in wb:
        if d["value"] is not None:
            code, year = d["countryiso3code"], int(d["date"])
            if code not in latest or year > latest[code][1]:
                latest[code] = (d["value"], year)
    for i, a in attrs.items():
        if (v := latest.get(a["iso3"])) is not None:
            extra[i]["forest_pct"] = round(v[0], 1)
            extra[i]["forest_year"] = v[1]

    for e in extra.values():
        if "olympics_hosted" in e:
            e["olympics_hosted"].sort(key=lambda o: o["year"])
    _write("country", _update_attrs(ents, extra), al, rel)
    log.info("countries enriched: monarchy %d, king_charles %d, highest_point %d, "
             "named_after %d, olympics %d, forest %d",
             sum(e.get("monarchy", False) for e in extra.values()),
             sum("king_charles" in e for e in extra.values()),
             sum("highest_point" in e for e in extra.values()),
             sum("named_after_person" in e for e in extra.values()),
             sum("olympics_hosted" in e for e in extra.values()),
             sum("forest_pct" in e for e in extra.values()))


def enrich_cities(games: list[dict], refresh: bool) -> None:
    ents, al, rel = _read("city")
    ids = set(ents["id"])
    extra: dict[str, dict] = defaultdict(dict)

    # Olympic host towns missing from cities15000 become city entities.
    hosts = resolve_hosts(games, ents, al)
    for i, g in enumerate(games):
        if i not in hosts and g.get("qid") in ids:
            hosts[i] = g["qid"]
    missing = [i for i in range(len(games)) if i not in hosts]
    if unpinned := [games[i]["city"] for i in missing if not games[i].get("qid")]:
        log.warning("Olympic hosts not found and without a qid in olympics.yaml: %s", unpinned)
    new_ids = sorted({games[i]["qid"] for i in missing if games[i].get("qid")})
    if new_ids:
        resolve = country_resolver(refresh)
        values = " ".join(f"wd:{q}" for q in new_ids)
        info = {qid(r["item"]): r for r in sparql(
            f"""SELECT ?item ?coord ?pop ?sl WHERE {{ VALUES ?item {{ {values} }}
  ?item wikibase:sitelinks ?sl .
  OPTIONAL {{ ?item wdt:P625 ?coord }} OPTIONAL {{ ?item wdt:P1082 ?pop }} }}""",
            "olympic-towns-sl", refresh)}
        wde = wikidata_entities(new_ids, "olympic-towns", refresh)
        new_rows, new_alias, new_rel = [], [], []
        for q in new_ids:
            g = next(games[i] for i in missing if games[i].get("qid") == q)
            r = info.get(q, {})
            country, territory = resolve(g["iso2"])
            lat = lon = None
            if r.get("coord", "").startswith("Point("):
                lon, lat = (float(x) for x in r["coord"][6:-1].split())
            wd = wde.get(q) or {}
            new_rows.append({
                "id": q, "type": "city", "name": g["city"], "country_id": country, "lat": lat,
                "lon": lon, "sources": ["wikidata"],
                "attrs": json.dumps({
                    "population": int(float(r["pop"])) if r.get("pop") else None,
                    "population_source": "wikidata", "is_capital": False, "iso2": g["iso2"],
                    "territory": territory, "enwiki": wd.get("enwiki"),
                    "wikidata_sitelinks": int(r["sl"]) if r.get("sl") else None,
                    "added_for": "olympic_host"}),
            })
            new_alias.extend(wikidata_aliases(q, wd))
            new_alias.append((q, g["city"], "label"))
            new_rel.append({"a": q, "rel": "located_in", "b": country, "attrs": "{}"})
            ids.add(q)
        ents = pd.concat([ents, pd.DataFrame(new_rows)], ignore_index=True)
        al = pd.concat([al, pd.DataFrame(new_alias, columns=["entity_id", "alias", "kind"])],
                       ignore_index=True)
        rel = pd.concat([rel, pd.DataFrame(new_rel)], ignore_index=True)
        for i in missing:
            if games[i].get("qid") in ids:
                hosts[i] = games[i]["qid"]
        log.info("added %d Olympic host towns as city entities: %s",
                 len(new_rows), [r["name"] for r in new_rows])

    for i, eid in hosts.items():
        g = games[i]
        key = "olympics" if g["year"] <= CURRENT_YEAR else "olympics_future"
        extra[eid].setdefault(key, []).append({"year": g["year"], "season": g["season"]})

    # Districts: GeoNames lists NYC boroughs, Chinese urban districts etc. as cities. A city whose
    # Wikidata P131 (located in) is another city entity is marked part_of_city and left out of
    # city questions (Queens -> New York City, Bao'an -> Shenzhen).
    qids_all = sorted(i for i in ids if i.startswith("Q"))
    n_districts = 0
    for i, batch in enumerate(chunks(qids_all, 1000)):
        values = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"SELECT ?city ?in WHERE {{ VALUES ?city {{ {values} }} ?city wdt:P131 ?in }}",
                        f"city-p131-{i:03d}", refresh):
            parent = qid(r["in"])
            child = qid(r["city"])
            if parent in ids and parent != child and "part_of_city" not in extra[child]:
                extra[child]["part_of_city"] = parent
                n_districts += 1
    log.info("cities marked as districts of another city: %d", n_districts)

    # Rivers a city lies on (P206, classified as river).
    qids = sorted(i for i in ids if i.startswith("Q"))
    city_water: dict[str, set[str]] = defaultdict(set)
    for i, batch in enumerate(chunks(qids, 1000)):
        values = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"SELECT ?city ?w WHERE {{ VALUES ?city {{ {values} }} ?city wdt:P206 ?w }}",
                        f"city-water-{i:03d}", refresh):
            city_water[qid(r["city"])].add(qid(r["w"]))
    waters = sorted(set().union(*city_water.values()) if city_water else set())
    rivers: dict[str, str] = {}
    for i, batch in enumerate(chunks(waters, 500)):
        values = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"""SELECT DISTINCT ?w ?wLabel WHERE {{ VALUES ?w {{ {values} }}
  ?w wdt:P31/wdt:P279* wd:{RIVER} .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}""",
                        f"river-check-{i:03d}", refresh):
            rivers[qid(r["w"])] = r.get("wLabel")
    for city, ws in city_water.items():
        names = sorted({rivers[w] for w in ws if rivers.get(w)})
        if names:
            extra[city]["rivers"] = names
    _write("city", _update_attrs(ents, extra), al, rel)
    log.info("cities enriched: olympics %d, rivers %d",
             sum("olympics" in e for e in extra.values()),
             sum("rivers" in e for e in extra.values()))


def main(refresh: bool = False) -> None:
    games = olympics()
    log.info("olympic host entries: %d", len(games))
    enrich_cities(games, refresh)  # first: adds host towns that countries then count
    enrich_countries(games, refresh)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="re-download cached sources")
    main(p.parse_args().refresh)
