"""National animals (QUESTIONS.md §3.4) from the curated data/national_animals.yaml.

Output: out/animal_{entities,aliases,relations}.parquet
  entities: type "animal", id = Wikidata QID of the animal's English Wikipedia article
  relations: country --has_national_animal--> animal, attrs {"official": bool}
Requires out/country_entities.parquet. Also sets attrs.national_animals = [animal names] on
countries (written back to out/country_entities.parquet) so templates can filter on it.
"""

from __future__ import annotations

import argparse
import json
from urllib.parse import quote

import pandas as pd
import yaml

from geo_pipeline.common import (
    OUT,
    PIPELINE_DIR,
    log,
    qid,
    setup_logging,
    sparql,
    wikidata_entities,
)
from geo_pipeline.ingest.util import wikidata_aliases, write_outputs

DATA = PIPELINE_DIR / "data" / "national_animals.yaml"


def main(refresh: bool = False) -> None:
    data = yaml.safe_load(DATA.read_text(encoding="utf-8"))
    animals: dict[str, dict] = data["animals"]
    countries = pd.read_parquet(OUT / "country_entities.parquet")
    iso2_to_id = {json.loads(a)["iso2"]: i for i, a in zip(countries["id"], countries["attrs"],
                                                            strict=False)}

    titles = {k: v["wiki"] for k, v in animals.items()}
    values = " ".join(
        f"<https://en.wikipedia.org/wiki/{quote(t.replace(' ', '_'), safe='()_,-')}>"
        for t in titles.values())
    rows = sparql(
        f"""SELECT ?article ?item ?n WHERE {{
  VALUES ?article {{ {values} }}
  ?article schema:about ?item . ?item wikibase:sitelinks ?n .
}}""",
        "national-animals-qids", refresh,
    )
    by_title = {r["article"].rsplit("/wiki/", 1)[1]: (qid(r["item"]), int(r["n"])) for r in rows}
    key_to_q: dict[str, tuple[str, int]] = {}
    for key, title in titles.items():
        hit = by_title.get(quote(title.replace(" ", "_"), safe="()_,-"))
        if not hit:
            log.warning("no Wikidata item for %s (%s)", key, title)
            continue
        key_to_q[key] = hit
    wde = wikidata_entities([q for q, _ in key_to_q.values()], "animals", refresh)

    entities, aliases, relations = [], [], []
    for key, (q, n) in key_to_q.items():
        spec = animals[key]
        name = key[0].upper() + key[1:]
        entities.append({"id": q, "type": "animal", "name": name, "attrs": {
            "groups": spec.get("groups", []), "wikidata_sitelinks": n,
            "enwiki": (wde.get(q) or {}).get("enwiki") or spec["wiki"],
        }, "sources": ["curated", "wikidata"]})
        aliases.append((q, key, "label"))
        aliases.append((q, spec["wiki"].split(" (")[0], "enwiki"))
        aliases.extend((q, a, "curated") for a in spec.get("aliases", []))
        # English labels/aliases only: other-language animal names collide too easily
        aliases.extend(a for a in wikidata_aliases(q, wde.get(q)) if not a[2].startswith("lang:"))

    national: dict[str, list[str]] = {}
    for iso2, items in data["countries"].items():
        cid = iso2_to_id.get(iso2)
        if not cid:
            log.warning("unknown country %s in national_animals.yaml", iso2)
            continue
        for key, official in items:
            if key not in key_to_q:
                raise SystemExit(f"{iso2}: unknown animal {key!r}")
            relations.append({"a": cid, "rel": "has_national_animal", "b": key_to_q[key][0],
                              "attrs": {"official": bool(official)}})
            national.setdefault(cid, []).append(key)
    write_outputs("animal", entities, aliases, relations)

    new_attrs = []
    for cid, raw in zip(countries["id"], countries["attrs"], strict=False):
        a = json.loads(raw)
        if cid in national:
            a["national_animals"] = national[cid]
        else:
            a.pop("national_animals", None)
        new_attrs.append(json.dumps(a, ensure_ascii=False))
    countries["attrs"] = new_attrs
    countries.to_parquet(OUT / "country_entities.parquet", index=False)
    log.info("national animals: %d animals, %d countries", len(entities), len(national))


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    main(p.parse_args().refresh)
