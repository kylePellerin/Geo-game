# Question design guide

This file defines *what* we ask. `PLAN.md` defines how it's built. Templates in
`pipeline/templates/` should be generated from the families below.

## 1. Design principles

1. **Easy to score, hard to max.** Every question must have obvious answers a casual player knows
   (they score 10–25 points and feel good) *and* a long tail of rare answers for enthusiasts
   (60–100 points). Rarity scoring does the difficulty work — the question itself should not be hard.
2. **Nobody should stare at a blank box.** If a non-geography person can't think of *any* valid
   answer within ~10 seconds, the question is too hard for the daily game.
3. **Variety every day.** 6 questions, 6 different families, at least one visual (flags) most days.
4. **Teach something.** Every reveal shows a fact card about a rare valid answer.
5. **Traps are fun, not unfair.** "Real but wrong" answers (e.g. a country whose national bird is
   unofficial) get a friendly explanation, never a bare ✗.

## 2. The "easy floor" rule (enforced by the generator)

Every generated question must pass all of these:

- **Answer count:** 10–300 valid answers.
- **Rarity categories.** Each valid answer is placed in one of five categories by its popularity
  percentile *within the question's pool* (see below):

  | Category | Share of the pool |
  |---|---|
  | Famous | top 15% |
  | Well known | next 25% |
  | Familiar | next 30% |
  | Obscure | next 28% |
  | Rarest | bottom 2% |

- **Floor:** at least **5 valid answers that are Famous or Well known**. This guarantees answers a
  casual player knows.
- **Tail:** at least **5 valid answers that are not Famous**, so rare answers exist to score big.
- **Pool:** percentiles are measured against the entities a player would plausibly draw from, not
  the whole type (every capital is "famous" among 31k cities). Defaults: all countries; cities with
  100k+ people or capitals; large airports. Templates can set their own `universe` (capital
  questions use all capitals). Popularity = `entities.popularity`.
- **Wording:** plain English, no jargon in the prompt ("meets two other countries at a single point",
  not "tripoint"). Jargon can appear in the fact card.

(Revised 2026-11-20: the original rule, ≥5 answers in the top 20% and ≥5 in the bottom 50% of the
whole type, rejected "Name a country in Africa" and most capital questions.)

### Daily mix
| Slot | Difficulty | Typical families |
|---|---|---|
| 1–3 | Easy | countries, capitals & big cities, flags, national symbols, famous landmarks |
| 4–5 | Medium | airports, mountains, rivers & lakes, borders, map surprises, national parks |
| 6 | Hard ("deep dive") | volcanoes, climate, weird borders, aviation deep cuts |

Mix rules (2026-11-20): **flags every day** (sometimes two), **airports occasionally** (≤ 2 a
week, easy-ish questions only), a **matching round** (§3.12) on most days in slot 3 or 4. Until
deep-dive data exists (Phase 6), slot 6 often falls back to a medium question.

### Calibrating with real data (after launch)
- Track per question: **% of players scoring > 0** and **median points**.
- Targets: easy ≥ 85% scoring, medium ≥ 70%, hard ≥ 50%.
- A template family that misses its target for 3+ uses is automatically demoted a difficulty tier
  (or flagged for review).

## 3. Question families

Difficulty: E = easy, M = medium, H = hard. "Answer type" is what the player types.

### 3.1 Flags (E–M) ⭐ visual, daily favourite
Answer type: country. Show answered flags as images in the reveal.

- Name a country whose flag has a **star** / **sun** / **moon or crescent** / **cross**
- Name a country whose flag has an **animal** / **a bird** / **a plant or tree** / **a weapon**
- Name a country whose flag has **exactly two colours** / **green, yellow and red** /
  **red, white and blue** / **no red**
- Name a flag with **horizontal stripes** / **vertical stripes** / **a Nordic cross**
- Name a country whose flag includes **the Union Jack**
- Name a country whose flag has **writing** on it / **a map** on it
- Combo (M): "a flag with a star *and* in Africa", "a two-colour flag in Europe"
- Fact-card-only oddities (too few answers for questions): Nepal's non-rectangular flag,
  Mozambique's rifle, the map on Cyprus's flag.

Data: tag every flag ourselves (≈200 flags × ~25 boolean tags + colour list). Draft the tags with AI
from the Wikimedia Commons SVGs, then human-review once. Store as `attrs.flag` on country entities.
Images: `flag-icons` npm package (MIT) or Wikimedia Commons SVGs.

### 3.2 Countries & capitals (E)
- Name a country in {continent/region}; a landlocked country; an island country
- Name a country with more than {N} million people / bigger than {area}
- Name a capital city on a river / on the coast / starting with {letter}
- Name a country that borders {big, well-known country} (France, Brazil, China, Russia…)
- Name a country where {language} is an official language / that uses the euro
- Name a country that drives on the left

### 3.3 Cities (E–M)
- Name a city of over 5 million people; a city in {country} with over 1M people
- Name a city that has hosted the Olympics (E — huge pop-culture recall)
- Name a city that isn't its country's capital but is more famous (M, curate the list)

### 3.4 National symbols (E–M)
Answer type: species / thing (not a country).
- Name a country's **national animal**; a national animal that is **a big cat** / **a bird of prey**
- Name a **national bird**; a **national flower**; a **national dish**; a **national sport**
- Reverse (E): Name a country whose national animal is **a lion** / **an eagle**
- Policy: accept officially designated + widely recognised unofficial symbols, but show the
  official status in the fact card (e.g. Australia's emu is not officially designated).

Data: Wikipedia "Lists of national symbols" family + Wikidata; store as relations
`has_national_animal {official: bool}`, etc.

### 3.5 Famous landmarks & national parks (E–M)
- Name a national park in {USA / Africa / Europe}; a national park with mountains
- Name a UNESCO World Heritage Site in {Italy/China/Mexico…}
- Name a famous waterfall; a famous desert; a famous island

### 3.6 Map surprises (M) ⭐ most shareable
Generated purely from coordinates.
- Name a European capital further north than {Montreal / New York}
- Name a capital in the Southern Hemisphere
- Name a South American capital east of {New York / Miami}
- Name an African country entirely north of the Equator
- Always phrase with well-known reference cities. Fact card shows the surprising line on a map.

### 3.7 Nature (M)
- Name a river that flows through {N}+ countries / through a capital city
- Name a lake shared by two or more countries
- Name a mountain over 8,000 m (H-ish but famous) / the highest mountain of any country
- Name a country with a mountain over 5,000 m

### 3.8 Airports (M)
- Name the busiest airport in its country (only for countries with passenger data)
- Name an airport named after a person (JFK, Charles de Gaulle, Ataturk…) (E–M, fun)
- Name an airport above 2,500 m elevation (H)
- Avoid route questions (OpenFlights route data is stale since 2014).

### 3.9 Names & language (E–M)
- Name a country named after a person
- Name a country whose name ends in "-stan" / "-land" / "-ia"
- Name a country with the same name as its capital
- Name a country whose name in its own language starts with a different letter
  (Deutschland, Magyarország, Nippon, Hellas)

### 3.10 Borders (M–H)
- Name a country that borders only one other country (M)
- Name a country that borders both {A} and {B} (M)
- Name a country that meets two others at a single point with {X} (H; prompt avoids "tripoint")
- Name a place that belongs to one country but is surrounded by another (H)

### 3.11 Deep dives (H — slot 6 only)
- Name a volcano that has erupted since 2000 (Smithsonian GVP; check terms, cite)
- Name a capital city with a desert climate (Köppen-Geiger 1 km map, CC BY 4.0)
- Name an airport with a runway longer than 4,000 m

### 3.12 Matching rounds (E–M) ⭐ visual switch-up, every day
Four items ↔ four items, the player pairs them. Not rarity-scored (see PLAN.md §1). One per day,
in slot 3 (easy) or 4 (medium). Variants (`pipeline/geo_pipeline/matching.py`), flags most often:
- **flags ↔ countries** · **capitals ↔ countries** · **big cities ↔ countries**
- **cities ↔ continents** · **countries ↔ continents** (easy only)
- **countries ↔ currencies** (bare names: "lira", "krone"; only currencies unique to one country)
- **countries ↔ official language** and **countries ↔ what the people are called**: only
  non-giveaways (Brazil–Portuguese, Netherlands–Dutch; not Poland–Polish)
- **countries ↔ internet domain** (.jp, .de)
- **countries ↔ highest mountain** (medium; peaks over 2,000 m)
- **Olympic host cities ↔ year** (medium)
- Easy rounds: 2 famous + 2 well-known items; medium: 2 famous/well-known + 2 rarer.
- No round may contain two items that could match the same right-hand item (e.g. Stockholm,
  which hosted in 1912 and 1956, never appears beside a 1956 Melbourne).
- Look-alike flags (Chad/Romania, Indonesia/Monaco) never share an easy round.
- A variant doesn't repeat within 4 days; an item doesn't repeat within 21 days.

### 3.12b Attribute-based questions added 2026-11-20
Monarchies, King Charles III realms, countries named after a person, native-name first letter,
highest mountain over N m / highest point under N m, forest cover, Olympic host countries and
cities (curated list in `pipeline/data/olympics.yaml`), cities on famous rivers.

### 3.13 Parked (too niche for the daily game — endless/expert mode only)
- Sister cities, tripoints of specific minor countries, runway surfaces, volcano types,
  second-level administrative regions.

## 4. Fact cards

For each question, the reveal shows one fact card about the **rarest valid answer given by any
player so far** (fallback: a pre-picked rare answer). Fact cards are short (≤ 40 words), written once
per entity/relation, AI-drafted from Wikidata/Wikipedia facts and human-reviewed. Store in
`entity_facts(entity_id, context, text, reviewed)`.
