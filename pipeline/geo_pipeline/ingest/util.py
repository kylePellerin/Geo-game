"""Helpers shared by ingest scripts."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from typing import Any

import pandas as pd

from geo_pipeline.common import OUT, log

ENTITY_COLUMNS = ["id", "type", "name", "country_id", "lat", "lon", "attrs", "sources"]


def wikidata_aliases(q: str, e: dict | None) -> list[tuple[str, str, str]]:
    """(entity_id, alias, kind) tuples from a wikidata_entities() record."""
    if not e:
        return []
    out = []
    for lang, label in e.get("labels", {}).items():
        out.append((q, label, "label" if lang == "en" else f"lang:{lang}"))
    for lang, vals in e.get("aliases", {}).items():
        for v in vals:
            out.append((q, v, "altlabel" if lang == "en" else f"lang:{lang}"))
    return out


def _clean(v: Any) -> Any:
    """Drop NaN/None values from attrs so jsonb stays tidy."""
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items() if x is not None and not (isinstance(x, float) and math.isnan(x))}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def write_outputs(
    etype: str,
    entities: list[dict],
    aliases: Iterable[tuple[str, str, str]],
    relations: list[dict],
) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ents = pd.DataFrame(entities)
    for col in ENTITY_COLUMNS:
        if col not in ents:
            ents[col] = None
    dup = ents["id"][ents["id"].duplicated()]
    if len(dup):
        raise SystemExit(f"duplicate {etype} ids: {list(dup[:10])}")
    ents["attrs"] = ents["attrs"].map(lambda a: json.dumps(_clean(a), ensure_ascii=False))
    ents[ENTITY_COLUMNS].to_parquet(OUT / f"{etype}_entities.parquet", index=False)

    al = pd.DataFrame(list(aliases), columns=["entity_id", "alias", "kind"])
    al["alias"] = al["alias"].astype(str).str.strip()
    al = al[al["alias"] != ""].drop_duplicates()
    al.to_parquet(OUT / f"{etype}_aliases.parquet", index=False)

    rel = pd.DataFrame(relations, columns=["a", "rel", "b", "attrs"])
    rel["attrs"] = rel["attrs"].map(lambda a: json.dumps(a or {}))
    rel.to_parquet(OUT / f"{etype}_relations.parquet", index=False)
    log.info(
        "%s: %d entities, %d aliases, %d relations", etype, len(ents), len(al), len(rel)
    )


# Wikidata models some sovereigns as a "realm" item distinct from the country we use.
REALM_TO_COUNTRY = {
    "Q756617": "Q35",  # Kingdom of Denmark -> Denmark (Greenland, Faroe Islands)
    "Q29999": "Q55",  # Kingdom of the Netherlands -> Netherlands (Aruba, Curaçao, Sint Maarten)
    "Q1340574": "Q664",  # Realm of New Zealand -> New Zealand
}
# Territories whose Wikidata P17 is themselves (self-governing members of a realm).
TERRITORY_SOVEREIGN = {"AW": "Q55", "CK": "Q664", "NU": "Q664"}


def country_resolver(refresh: bool = False):
    """Return f(iso2) -> (country QID | None, territory iso2 | None).

    Territories (Puerto Rico, Hong Kong, Greenland...) resolve to their sovereign country via
    Wikidata P17, and the territory code is returned so callers can keep it in attrs.
    """
    from geo_pipeline.common import qid, sparql

    countries = pd.read_parquet(OUT / "country_entities.parquet")
    iso2_to_country = {json.loads(a)["iso2"]: i for i, a in zip(countries.id, countries["attrs"])}
    ids = set(countries.id)
    territory_sov: dict[str, str] = dict(TERRITORY_SOVEREIGN)
    for r in sparql(
        "SELECT ?iso2 ?sov WHERE { ?item wdt:P297 ?iso2 ; wdt:P17 ?sov . }",
        "iso2-sovereign", refresh,
    ):
        s = qid(r["sov"])
        s = REALM_TO_COUNTRY.get(s, s)
        if r["iso2"] not in iso2_to_country and s in ids:
            territory_sov.setdefault(r["iso2"], s)

    def resolve(iso2: str) -> tuple[str | None, str | None]:
        if iso2 in iso2_to_country:
            return iso2_to_country[iso2], None
        return territory_sov.get(iso2), iso2

    return resolve
