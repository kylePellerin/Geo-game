"""Matching rounds (PLAN.md §1, QUESTIONS.md §3.12): pair four left items with four right items.

Variants are defined here rather than in YAML because they pick items per day instead of filtering
a fixed answer set. Each variant has a pool (SQL), how to read the right-hand item, and the pool's
popularity ranking gives every left item a rarity category (which sets its points per pair).

Stored in puzzle_questions with kind='match': valid_entity_ids = the four left ids (in display
order); payload = {"variant", "pairs": [{"left", "right", "right_label", "category"}],
"right_order": [...shuffled right ids/labels]}. The client gets left items and right_order only.
"""

from __future__ import annotations

import bisect
import random
from dataclasses import dataclass, field

from geo_pipeline.questions import rarity_category

# Pairs of flags that are easy to confuse; never put both in an easy round.
SIMILAR_FLAGS = [
    {"TD", "RO", "AD", "MD"}, {"ID", "MC", "PL"}, {"IE", "CI", "IT"}, {"NL", "LU", "FR"},
    {"AU", "NZ"}, {"NO", "IS"}, {"SN", "ML", "GN", "CM"}, {"CO", "EC", "VE"},
    {"SI", "SK", "RU", "RS"}, {"KW", "AE", "JO", "PS", "SD"}, {"QA", "BH"},
    {"EG", "IQ", "SY", "YE"}, {"HN", "NI", "SV"}, {"DK", "CH"}, {"BE", "DE"}, {"HU", "IT", "BG"},
]

HARDER_CATEGORIES = {"familiar", "obscure", "rarest"}


@dataclass(frozen=True)
class MatchVariant:
    id: str
    text: str
    left_type: str
    # SELECT left_id, right_id, right_label, popularity, iso2, alts
    #   alts = every right_id that is correct for this left item (NULL -> just right_id);
    #   a round is rejected if a left item also matches another right item shown.
    pool_sql: str
    weight: float = 1.0
    difficulties: tuple[int, ...] = (2,)


def _giveaway(expr: str) -> str:
    """SQL: the right-hand label starts like any word of the country name (Poland/Polish)."""
    return (f"EXISTS (SELECT 1 FROM regexp_split_to_table(unaccent(c.name), '[^A-Za-z]+') w "
            f"WHERE length(w) >= 3 AND lower(left(w, 3)) = lower(left(unaccent({expr}), 3)))")


_NOT_TRANSCONTINENTAL = "c.attrs->>'iso2' NOT IN ('RU', 'TR', 'KZ', 'AZ', 'GE', 'EG')"

VARIANTS = [
    MatchVariant(
        id="match_flag_country",
        text="Match each flag to its country",
        left_type="country",
        weight=3.0,
        pool_sql="""SELECT e.id, e.id, e.name, coalesce(e.popularity, 0), e.attrs->>'iso2', NULL
                    FROM entities e WHERE e.type = 'country' AND e.attrs ? 'flag'""",
    ),
    MatchVariant(
        id="match_capital_country",
        text="Match each capital city to its country",
        left_type="city",
        weight=2.0,
        pool_sql="""SELECT e.id, c.id, c.name, coalesce(e.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities e JOIN entities c ON c.id = e.country_id
                    WHERE e.type = 'city' AND (e.attrs->>'is_capital')::boolean
                    AND e.attrs->>'territory' IS NULL""",
    ),
    MatchVariant(
        id="match_city_country",
        text="Match each city to its country",
        left_type="city",
        weight=1.5,
        pool_sql="""SELECT e.id, c.id, c.name, coalesce(e.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities e JOIN entities c ON c.id = e.country_id
                    WHERE e.type = 'city' AND NOT (e.attrs->>'is_capital')::boolean
                    AND (e.attrs->>'population')::float >= 1000000
                    AND e.id LIKE 'Q%' AND e.attrs ? 'enwiki' AND NOT e.attrs ? 'part_of_city'
                    AND e.attrs->>'territory' IS NULL""",
    ),
    MatchVariant(
        id="match_city_continent",
        text="Match each city to its continent",
        left_type="city",
        pool_sql=f"""SELECT e.id, c.attrs->>'continent', c.attrs->>'continent',
                            coalesce(e.popularity, 0), c.attrs->>'iso2', NULL
                     FROM entities e JOIN entities c ON c.id = e.country_id
                     WHERE e.type = 'city' AND (e.attrs->>'population')::float >= 1000000
                     AND e.id LIKE 'Q%' AND e.attrs ? 'enwiki' AND NOT e.attrs ? 'part_of_city'
                     AND e.attrs->>'territory' IS NULL
                     -- transcontinental countries: our continent is per country, not per city
                     AND {_NOT_TRANSCONTINENTAL}""",
    ),
    MatchVariant(
        id="match_country_currency",
        text="Match each country to its currency",
        left_type="country",
        # single-currency countries whose currency nobody else uses (no euro, US dollar, CFA...).
        # The country adjective is stripped ("Turkish lira" -> "lira") so the name isn't a giveaway;
        # two countries whose bare names coincide (dinar, peso) never share a round.
        pool_sql="""SELECT c.id, lower(bare), bare, coalesce(c.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities c,
                    LATERAL (SELECT regexp_replace(regexp_replace(c.attrs->'currency_names'->>0,
                               '^(' || regexp_replace(coalesce(c.attrs->>'demonym', '-'),
                                                      '[^A-Za-z ]', '', 'g')
                               || '|' || regexp_replace(c.name, '[^A-Za-z ]', '', 'g')
                               || ')\\s+', '', 'i'),
                               -- any other adjective from the country name (Surinamese dollar)
                               '^' || left(regexp_replace(c.name, '[^A-Za-z]', '', 'g'), 4)
                               || '[a-z]*\\s+', '', 'i') AS bare) b
                    WHERE c.type = 'country'
                    -- still names the country after stripping ("New Taiwan dollar"): skip
                    AND NOT EXISTS (SELECT 1 FROM regexp_split_to_table(unaccent(c.name), '[^A-Za-z]+') w
                                    WHERE length(w) >= 4 AND unaccent(bare) ~* ('\\m' || left(w, 3)))
                    AND jsonb_array_length(c.attrs->'currencies') = 1
                    AND (SELECT count(*) FROM entities o WHERE o.type = 'country'
                         AND o.attrs->'currencies' ? (c.attrs->'currencies'->>0)) = 1""",
    ),
    MatchVariant(
        id="match_country_language",
        text="Match each country to its official language",
        left_type="country",
        pool_sql=f"""SELECT c.id, c.attrs->'languages'->>0, c.attrs->'languages'->>0,
                           coalesce(c.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities c WHERE c.type = 'country'
                    AND jsonb_array_length(c.attrs->'languages') = 1
                    -- skip giveaways (Hungary/Hungarian); keep Brazil/Portuguese, Austria/German
                    AND NOT {_giveaway("c.attrs->'languages'->>0")}""",
    ),
    MatchVariant(
        id="match_country_demonym",
        text="Match each country to what its people are called",
        left_type="country",
        pool_sql=f"""SELECT c.id, c.attrs->>'demonym', c.attrs->>'demonym',
                           coalesce(c.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities c WHERE c.type = 'country' AND c.attrs ? 'demonym'
                    AND (SELECT count(*) FROM entities o WHERE o.type = 'country'
                         AND o.attrs->>'demonym' = c.attrs->>'demonym') = 1
                    -- only the fun ones (Dutch, Monegasque, Burkinabe), not Spain/Spanish
                    AND NOT {_giveaway("c.attrs->>'demonym'")}""",
    ),
    MatchVariant(
        id="match_country_domain",
        text="Match each country to its internet domain",
        left_type="country",
        pool_sql="""SELECT c.id, c.attrs->>'tld', c.attrs->>'tld',
                           coalesce(c.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities c WHERE c.type = 'country' AND c.attrs ? 'tld'""",
    ),
    MatchVariant(
        id="match_country_mountain",
        text="Match each country to its highest mountain",
        left_type="country",
        difficulties=(2,),
        pool_sql="""SELECT c.id, c.attrs->'highest_point'->>'id', c.attrs->'highest_point'->>'name',
                           coalesce(c.popularity, 0), c.attrs->>'iso2', NULL
                    FROM entities c WHERE c.type = 'country'
                    AND c.attrs->'highest_point'->>'name' !~ '^Q[0-9]+$'
                    AND (c.attrs->'highest_point'->>'elevation_m')::float >= 2000""",
    ),
    MatchVariant(
        id="match_olympic_city_year",
        text="Match each city to a year it hosted the Olympics",
        left_type="city",
        difficulties=(2,),
        # right = the city's most recent Games; alts = all its Games
        pool_sql="""SELECT e.id, last.k, last.label, coalesce(e.popularity, 0), e.attrs->>'iso2',
                           ARRAY(SELECT (o->>'year') || ' ' || (o->>'season')
                                 FROM jsonb_array_elements(e.attrs->'olympics') o)
                    FROM entities e,
                    LATERAL (SELECT (o->>'year') || ' ' || (o->>'season') AS k,
                                    (o->>'year') || ' ' || initcap(o->>'season') AS label
                             FROM jsonb_array_elements(e.attrs->'olympics') o
                             ORDER BY (o->>'year')::int DESC LIMIT 1) last
                    WHERE e.type = 'city' AND e.attrs ? 'olympics'""",
    ),
]


@dataclass
class MatchItem:
    left: str
    right: str
    right_label: str
    category: str
    iso2: str
    alts: frozenset[str] = frozenset()

    def matches(self, right: str) -> bool:
        return right == self.right or right in self.alts


@dataclass
class MatchRound:
    variant: MatchVariant
    difficulty: int
    items: list[MatchItem]
    right_order: list[str] = field(default_factory=list)

    @property
    def answers(self) -> list[str]:
        return [i.left for i in self.items]

    @property
    def family(self) -> str:
        return "matching"

    @property
    def text(self) -> str:
        return self.variant.text

    def payload(self) -> dict:
        return {
            "variant": self.variant.id,
            "pairs": [{"left": i.left, "right": i.right, "right_label": i.right_label,
                       "category": i.category} for i in self.items],
            "right_order": self.right_order,
        }


def load_pool(cur, variant: MatchVariant) -> list[MatchItem]:
    cur.execute(variant.pool_sql)
    rows = cur.fetchall()
    pops = sorted(r[3] for r in rows)
    out = []
    for left, right, label, pop, iso2, alts in rows:
        if not right or not label:
            continue
        pct = bisect.bisect_left(pops, pop) / len(pops)
        out.append(MatchItem(left, right, label, rarity_category(pct), iso2 or "",
                             frozenset(alts or ())))
    return out


def _look_alike(a: MatchItem, b: MatchItem) -> bool:
    return any(a.iso2 in g and b.iso2 in g for g in SIMILAR_FLAGS)


def build_round(variant: MatchVariant, pool: list[MatchItem], difficulty: int,
                rng: random.Random, recently_used: set[str]) -> MatchRound | None:
    """Pick 4 items. Easy (1): 2 famous + 2 well known. Standard (2, every daily round since
    2026-11-20, "country to continent is too easy"): 1 well known + 2 familiar + 1 obscure or
    rarer, and look-alike flags are allowed."""
    fresh = [i for i in pool if i.left not in recently_used]
    famous = [i for i in fresh if i.category == "famous"]
    well_known = [i for i in fresh if i.category == "well_known"]
    familiar = [i for i in fresh if i.category == "familiar"]
    rare = [i for i in fresh if i.category in ("obscure", "rarest")]
    if difficulty == 1:
        want = [(famous, 2), (well_known, 2)]
    elif len(rare) >= 1 and len(familiar) >= 2:
        want = [(well_known or famous, 1), (familiar, 2), (rare, 1)]
    else:  # small pools (Olympic hosts): whatever isn't famous
        want = [(well_known, 1), ([i for i in fresh if i.category in HARDER_CATEGORIES], 3)]
    for _attempt in range(50):
        chosen: list[MatchItem] = []
        for group, n in want:
            candidates = list(group)
            rng.shuffle(candidates)
            taken = 0
            for item in candidates:
                if taken >= n:
                    break
                # no two items may share a right answer, or match each other's right answer
                if any(c.matches(item.right) or item.matches(c.right) for c in chosen):
                    continue
                if any(c.left == item.left for c in chosen):
                    continue
                if (difficulty == 1 and variant.id == "match_flag_country"
                        and any(_look_alike(c, item) for c in chosen)):
                    continue
                chosen.append(item)
                taken += 1
        if len(chosen) == 4:
            rng.shuffle(chosen)
            right_order = [c.right for c in chosen]
            while right_order == [c.right for c in chosen]:
                rng.shuffle(right_order)  # never present the pairs already aligned
            return MatchRound(variant, difficulty, chosen, right_order)
    return None
