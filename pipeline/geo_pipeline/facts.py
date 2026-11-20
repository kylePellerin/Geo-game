"""Fact cards (QUESTIONS.md §4, Phase 6): one short sentence or two per entity, generated from
the data we hold, stored in entity_facts(context='general', reviewed=false).

  python -m geo_pipeline.facts        (after `make load`)

Facts are built only from attributes we already serve as answers, so they are as accurate as the
answer data; `reviewed` stays false until a human edits/approves one on the admin page, and a
reviewed fact is never overwritten. The reveal after a question shows the card of the rarest
valid answer given so far.
"""

from __future__ import annotations

import json

from geo_pipeline.common import log, setup_logging
from geo_pipeline.db import connect


def _n(v: float | None, unit: str = "") -> str | None:
    if v is None:
        return None
    v = float(v)
    if v >= 1e9:
        s = f"{v / 1e9:.1f} billion"
    elif v >= 1e6:
        s = f"{v / 1e6:.1f} million"
    else:
        s = f"{round(v):,}"
    return f"{s}{unit}"


def _list(xs: list[str]) -> str:
    xs = [x for x in xs if x]
    if len(xs) <= 1:
        return "".join(xs)
    return ", ".join(xs[:-1]) + " and " + xs[-1]


def fact(etype: str, name: str, a: dict, country: str | None, names: dict[str, str],
         animal_of: dict[str, list[str]]) -> str | None:
    in_c = f" in {country}" if country else ""
    countries = [names.get(c, "") for c in a.get("countries", [])]
    if etype == "country":
        bits = []
        if a.get("population"):
            bits.append(f"{name} has about {_n(a['population'])} people")
        if a.get("capital_names"):
            bits.append(f"its capital is {a['capital_names'][0]}")
        s = " and ".join(bits) + "." if bits else ""
        extra = []
        if a.get("landlocked"):
            extra.append("It is landlocked.")
        if a.get("drives_on") == "left":
            extra.append("People drive on the left.")
        if a.get("national_animals"):
            extra.append(f"Its national animal: {a['national_animals'][0]}.")
        return (s + " " + " ".join(extra[:1])).strip() or None
    if etype == "city":
        s = f"{name}{', ' + country if country else ''}"
        bits = []
        if a.get("population"):
            bits.append(f"has about {_n(a['population'])} people")
        if a.get("is_capital"):
            bits.append("is the capital")
        if a.get("elevation_m") and float(a["elevation_m"]) >= 1000:
            bits.append(f"sits {_n(a['elevation_m'], ' m')} above sea level")
        return f"{s} {_list(bits)}." if bits else None
    if etype == "airport":
        if a.get("passengers"):
            return (f"{name} ({a.get('iata', '')}){in_c} handled {_n(a['passengers'])} passengers in "
                    f"{a.get('passengers_year')}.")
        return None
    if etype == "mountain":
        if not a.get("elevation_m"):
            return None
        what = "a volcano" if a.get("volcano") else "a mountain"
        where = f" in {_list(countries)}" if countries else ""
        return f"{name} is {what}{where}, {_n(a['elevation_m'], ' m')} high."
    if etype == "river":
        if a.get("length_km") and countries:
            return f"The {name} is about {_n(a['length_km'], ' km')} long and flows through {_list(countries)}."
        return None
    if etype in ("lake", "island"):
        if a.get("area_km2"):
            where = f" ({_list(countries)})" if countries else ""
            return f"{name}{where} covers about {_n(a['area_km2'], ' km²')}."
        return None
    if etype == "landmark":
        kind = (a.get("class") or a.get("kind") or "landmark").replace("_", " ")
        s = f"{name} is a {kind}{in_c}"
        if a.get("height_m"):
            s += f", {_n(a['height_m'], ' m')} tall"
        if a.get("unesco"):
            s += "; it is a UNESCO World Heritage Site"
        return s + "."
    if etype == "region":
        kind = a.get("region_kind", "region")
        s = f"{name} is a {kind}{' of ' + country if country else ''}"
        if a.get("population"):
            s += f" with about {_n(a['population'])} people"
        return s + "."
    if etype == "animal":
        of = animal_of.get(name.lower())
        if of:
            return f"The {name.lower()} is a national animal of {_list(sorted(of)[:5])}."
    return None


def main() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, name FROM entities WHERE type = 'country'")
        names = dict(cur.fetchall())
        cur.execute(
            """SELECT an.name, k.name FROM relations r JOIN entities an ON an.id = r.b
               JOIN entities k ON k.id = r.a WHERE r.rel = 'has_national_animal'""")
        animal_of: dict[str, list[str]] = {}
        for an, k in cur.fetchall():
            animal_of.setdefault(an.lower(), []).append(k)
        cur.execute("SELECT id, type, name, country_id, attrs FROM entities")
        rows = []
        for eid, etype, name, cid, attrs in cur.fetchall():
            a = attrs if isinstance(attrs, dict) else json.loads(attrs)
            text = fact(etype, name, a, names.get(cid) if cid else None, names, animal_of)
            if text:
                rows.append((eid, text))
        cur.execute("CREATE TEMP TABLE stage_facts (entity_id text, text text) ON COMMIT DROP")
        with cur.copy("COPY stage_facts (entity_id, text) FROM STDIN") as cp:
            for r in rows:
                cp.write_row(r)
        cur.execute(
            """INSERT INTO entity_facts (entity_id, context, text, reviewed)
               SELECT entity_id, 'general', text, false FROM stage_facts
               ON CONFLICT (entity_id, context) DO UPDATE SET text = EXCLUDED.text
               WHERE NOT entity_facts.reviewed""")
        log.info("fact cards: %d generated (reviewed ones kept)", len(rows))


if __name__ == "__main__":
    setup_logging()
    main()
