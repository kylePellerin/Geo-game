"""Ordering rounds (QUESTIONS.md §3.12c, added 2026-11-20): put five items in order by a number
(cities by population, countries by area, cities by distance from a place, Olympic hosts by year).

Items are well-known (top half of their pool by popularity): the challenge is the numbers, not
recognising names. Values must be clearly apart (min_gap) so the order isn't a coin toss on
noisy data.

Stored in puzzle_questions with kind='order': valid_entity_ids = item ids in display order;
payload = {"variant", "direction", "unit", "items": [{"id", "label", "value"}] (display order),
"answer": [display positions in the correct order]}. Values and the answer stay on the server
until the question ends.
"""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass, field

N_ITEMS = 5


@dataclass(frozen=True)
class OrderVariant:
    id: str
    text: str
    entity_type: str
    # SELECT id, label, value, popularity, group_key, group_label
    pool_sql: str
    direction: str = "desc"  # desc: largest first
    unit: str = ""
    # ratio: neighbours differ by at least this factor (1.3 = 30%); absolute: by this much
    min_ratio: float | None = 1.3
    min_abs: float | None = None
    weight: float = 1.0
    # group rounds draw all items from one group (one country); text uses {group}
    grouped: bool = False
    # distance rounds: value = km from an anchor picked per day; text uses {anchor}
    distance: bool = False


_BIG_CITY = """e.type = 'city' AND e.id LIKE 'Q%' AND e.attrs ? 'enwiki'
               AND NOT e.attrs ? 'part_of_city' AND e.attrs->>'territory' IS NULL"""

VARIANTS = [
    OrderVariant(
        id="order_city_population_country",
        text="Order these cities in {group} by population, largest first",
        entity_type="city", unit="people", grouped=True, min_ratio=1.25,
        pool_sql=f"""SELECT e.id, e.name, (e.attrs->>'population')::float, coalesce(e.popularity, 0),
                            c.id, c.name
                     FROM entities e JOIN entities c ON c.id = e.country_id
                     WHERE {_BIG_CITY} AND (e.attrs->>'population')::float >= 200000""",
    ),
    OrderVariant(
        id="order_country_area",
        text="Order these countries by area, largest first",
        entity_type="country", unit="km²", min_ratio=1.15,
        pool_sql="""SELECT id, name, (attrs->>'area_km2')::float, coalesce(popularity, 0), NULL, NULL
                    FROM entities WHERE type = 'country' AND attrs ? 'area_km2'""",
    ),
    OrderVariant(
        id="order_country_population",
        text="Order these countries by population, largest first",
        entity_type="country", unit="people", min_ratio=1.15,
        pool_sql="""SELECT id, name, (attrs->>'population')::float, coalesce(popularity, 0), NULL, NULL
                    FROM entities WHERE type = 'country' AND attrs ? 'population'""",
    ),
    OrderVariant(
        id="order_city_distance",
        text="Order these cities by distance from {anchor}, nearest first",
        entity_type="city", unit="km", direction="asc", distance=True, min_ratio=1.25, weight=1.5,
        pool_sql=f"""SELECT e.id, e.name, NULL::float, coalesce(e.popularity, 0), e.lat::text,
                            e.lon::text
                     FROM entities e WHERE {_BIG_CITY} AND e.lat IS NOT NULL
                     AND ((e.attrs->>'population')::float >= 1000000
                          OR (e.attrs->>'is_capital')::boolean)""",
    ),
    OrderVariant(
        id="order_country_highest_point",
        text="Order these countries by the height of their highest mountain, highest first",
        entity_type="country", unit="m", min_ratio=None, min_abs=250,
        pool_sql="""SELECT id, name, (attrs->'highest_point'->>'elevation_m')::float,
                           coalesce(popularity, 0), NULL, NULL
                    FROM entities WHERE type = 'country'
                    AND attrs->'highest_point'->>'elevation_m' IS NOT NULL""",
    ),
    OrderVariant(
        id="order_olympic_recent",
        text="Order these Olympic host cities by when they last hosted, most recent first",
        entity_type="city", unit="year", min_ratio=None, min_abs=4,
        pool_sql="""SELECT e.id, e.name, max((o->>'year')::int)::float, coalesce(e.popularity, 0),
                           NULL, NULL
                    FROM entities e, jsonb_array_elements(e.attrs->'olympics') o
                    WHERE e.type = 'city' GROUP BY e.id""",
    ),
    OrderVariant(
        id="order_capital_elevation",
        text="Order these capital cities by height above sea level, highest first",
        entity_type="city", unit="m", min_ratio=None, min_abs=250,
        pool_sql=f"""SELECT e.id, e.name, (e.attrs->>'elevation_m')::float, coalesce(e.popularity, 0),
                            NULL, NULL
                     FROM entities e WHERE {_BIG_CITY} AND (e.attrs->>'is_capital')::boolean
                     AND e.attrs->>'elevation_m' IS NOT NULL""",
    ),
    OrderVariant(
        id="order_airport_passengers",
        text="Order these airports by passengers a year, busiest first",
        entity_type="airport", unit="passengers", min_ratio=1.3, weight=0.3,
        pool_sql="""SELECT id, name, (attrs->>'passengers')::float, coalesce(popularity, 0), NULL, NULL
                    FROM entities WHERE type = 'airport' AND attrs->>'airport_type' = 'large'
                    AND (attrs->>'passengers')::float >= 5000000
                    AND (attrs->>'passengers_year')::int >= 2019""",
    ),
]

# Famous anchors for distance rounds (Wikidata QIDs).
DISTANCE_ANCHORS = {
    "Q90": "Paris", "Q84": "London", "Q60": "New York City", "Q1490": "Tokyo", "Q64": "Berlin",
    "Q220": "Rome", "Q3130": "Sydney", "Q85": "Cairo", "Q8678": "Rio de Janeiro", "Q1156": "Mumbai",
    "Q956": "Beijing", "Q649": "Moscow", "Q406": "Istanbul", "Q65": "Los Angeles", "Q1297": "Chicago",
    "Q172": "Toronto", "Q1489": "Mexico City", "Q1486": "Buenos Aires", "Q34647": "Johannesburg",
    "Q1353": "Delhi", "Q8684": "Seoul", "Q334": "Singapore", "Q1748": "Copenhagen", "Q1754": "Stockholm",
    "Q2807": "Madrid", "Q1218": "Jerusalem", "Q612": "Dubai", "Q3870": "Nairobi",
}


@dataclass
class OrderItem:
    id: str
    label: str
    value: float
    popularity: float
    group: str | None = None
    group_label: str | None = None
    lat: float | None = None
    lon: float | None = None


@dataclass
class OrderRound:
    variant: OrderVariant
    difficulty: int
    text: str
    items: list[OrderItem]  # display order
    answer: list[int] = field(default_factory=list)  # display positions, correct order

    @property
    def answers(self) -> list[str]:
        return [i.id for i in self.items]

    @property
    def family(self) -> str:
        return "ordering"

    def payload(self) -> dict:
        return {
            "variant": self.variant.id, "direction": self.variant.direction,
            "unit": self.variant.unit,
            "items": [{"id": i.id, "label": i.label, "value": round(i.value, 1)} for i in self.items],
            "answer": self.answer,
        }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def load_pool(cur, variant: OrderVariant) -> list[OrderItem]:
    cur.execute(variant.pool_sql)
    out = []
    for id_, label, value, pop, g, gl in cur.fetchall():
        if variant.distance:
            out.append(OrderItem(id_, label, 0.0, pop, lat=float(g), lon=float(gl)))
        elif value is not None and value > 0:
            out.append(OrderItem(id_, label, float(value), pop, g, gl))
    return out


def well_known(items: list[OrderItem], top: float = 0.5) -> list[OrderItem]:
    """The more popular part of a pool: ordering tests numbers, not obscure names."""
    ranked = sorted(items, key=lambda i: -i.popularity)
    return ranked[: max(N_ITEMS * 2, int(len(ranked) * top))]


def apart(values: list[float], v: OrderVariant) -> bool:
    s = sorted(values)
    for a, b in itertools.pairwise(s):
        if v.min_ratio is not None and (a <= 0 or b / a < v.min_ratio):
            return False
        if v.min_abs is not None and b - a < v.min_abs:
            return False
    return True


# Items come from a window of this many neighbours in value order, so the five are close enough
# to need thought (not Canada vs Andorra) but still clearly apart (min_ratio / min_abs).
WINDOW = 14


def _pick(candidates: list[OrderItem], v: OrderVariant, rng: random.Random) -> list[OrderItem] | None:
    if len(candidates) < N_ITEMS:
        return None
    ranked = sorted(candidates, key=lambda c: c.value)
    for _attempt in range(200):
        start = rng.randrange(max(1, len(ranked) - WINDOW + 1))
        window = ranked[start:start + WINDOW]
        if len(window) < N_ITEMS:
            continue
        chosen = rng.sample(window, N_ITEMS)
        if apart([c.value for c in chosen], v):
            return chosen
    return None


def build_round(v: OrderVariant, pool: list[OrderItem], difficulty: int, rng: random.Random,
                recently_used: set[str]) -> OrderRound | None:
    fresh = [i for i in pool if i.id not in recently_used]
    text = v.text
    if v.distance:
        anchors = [a for a in DISTANCE_ANCHORS if any(i.id == a for i in pool)]
        rng.shuffle(anchors)
        for anchor_id in anchors:
            anchor = next(i for i in pool if i.id == anchor_id)
            cands = [OrderItem(i.id, i.label, haversine_km(anchor.lat, anchor.lon, i.lat, i.lon),
                               i.popularity) for i in well_known(fresh, 0.3) if i.id != anchor_id]
            chosen = _pick(cands, v, rng)
            if chosen:
                text = v.text.format(anchor=DISTANCE_ANCHORS[anchor_id])
                break
        else:
            return None
    elif v.grouped:
        groups: dict[str, list[OrderItem]] = {}
        for i in fresh:
            groups.setdefault(i.group or "", []).append(i)
        # countries with enough well-known cities, most popular countries more often
        options = [(g, well_known(items)) for g, items in groups.items() if len(items) >= 8]
        rng.shuffle(options)
        for _g, items in options:
            chosen = _pick(items, v, rng)
            if chosen:
                text = v.text.format(group=chosen[0].group_label)
                break
        else:
            return None
    else:
        chosen = _pick(well_known(fresh), v, rng)
        if not chosen:
            return None
    rng.shuffle(chosen)
    key = (lambda i: i.value) if v.direction == "asc" else (lambda i: -i.value)
    answer = sorted(range(N_ITEMS), key=lambda p: key(chosen[p]))
    if answer == list(range(N_ITEMS)):  # never show them already in order
        chosen.reverse()
        answer = sorted(range(N_ITEMS), key=lambda p: key(chosen[p]))
    return OrderRound(v, difficulty, text, chosen, answer)
