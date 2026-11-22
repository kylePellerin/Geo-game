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

## 2b. Keep it broad (user feedback 2026-11-20)

"Name a volcano in Iceland" is too specific; "Name a volcano in Asia" is right. Natural features
and sights (mountains, volcanoes, rivers, lakes, islands, parks, UNESCO sites) are asked per
continent or worldwide. A single country only where it's big and famous for the thing (national
parks in the US, Kenya or Tanzania; islands of Greece or Japan; UNESCO sites in Italy) — the
allowed list is `BROAD_COUNTRIES` in `pipeline/tests/test_phase6.py`, which fails on anything
else. Regions: only countries whose divisions people know (US states, Canadian provinces, German
states…, not Swiss cantons or Argentine provinces). Cities over a population: big countries only.
Continent-wide sets can be large (2,000 rivers in Europe); `max_answers` is raised for those,
since rarity scoring handles the long tail.

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
Questions run **easiest to hardest** (2026-11-20):

| Slot | Difficulty | Typical families |
|---|---|---|
| 1–3 | Easy (the one with most well-known answers first) | countries, capitals & big cities, flags, national symbols, famous landmarks |
| 4 | **Matching round, every day** (§3.12) | |
| 5 | Medium, or an **ordering round** on ~40% of days (§3.12c) | airports, mountains, rivers & lakes, borders, map surprises, national parks |
| 6 | Hard ("deep dive") | volcanoes, climate, weird borders, aviation deep cuts |

Mix rules (2026-11-20): **flags every day** (sometimes two), **airports occasionally** (≤ 2 a
week, easy-ish questions only). Until deep-dive data exists (Phase 6), slot 6 often falls back
to a medium question.

**Timed, many answers (2026-11-20):** each free-text question gives 20 s to type as many right
answers as you can; every right answer scores by its rarity. Matching and ordering rounds get
40 s and one submission.

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

### 3.12 Matching rounds (M) ⭐ visual switch-up, every day
Three items ↔ three items, the player pairs them. Not rarity-scored (see PLAN.md §1). One per day,
always slot 4. Every round is "standard" difficulty: since 2026-11-22 (playtest: "fewer, a little
harder") 1 well-known + 1 familiar + 1 obscure-or-rarer item, look-alike flags allowed (was 4 pairs:
1 well-known + 2 familiar + 1 obscure).
Variants (`pipeline/geo_pipeline/matching.py`), flags most often:
- **flags ↔ countries** · **capitals ↔ countries** · **big cities ↔ countries**
- **cities ↔ continents** (countries ↔ continents removed: too easy)
- **countries ↔ currencies** (bare names: "lira", "krone"; only currencies unique to one country)
- **countries ↔ official language** and **countries ↔ what the people are called**: only
  non-giveaways (Brazil–Portuguese, Netherlands–Dutch; not Poland–Polish)
- **countries ↔ internet domain** (.jp, .de)
- **countries ↔ highest mountain** (medium; peaks over 2,000 m)
- Picture rounds (images drawn by us or public domain, served by position only):
  **flags ↔ countries**, **flags ↔ capital cities** (2026-11-22), **outlines ↔ countries**,
  **pixel locator maps ↔ countries** (2026-11-22: the country in red on a small pixel map of its
  neighbourhood, from Natural Earth; tiny countries get a ring).
- **Olympic host cities ↔ year** (medium)
- (Easy rounds, 2 famous + 2 well-known, still exist in code for a future practice mode.)
- No round may contain two items that could match the same right-hand item (e.g. Stockholm,
  which hosted in 1912 and 1956, never appears beside a 1956 Melbourne).
- Look-alike flags (Chad/Romania, Indonesia/Monaco) never share an easy round (allowed in
  standard rounds: that's part of the challenge).
- Ideas from playtesting (2026-11-20), added with Phase 6 data: **country outlines ↔ countries**
  (Natural Earth shapes, public domain), **regions ↔ country** (Bavaria → Germany, Ontario →
  Canada), **famous landmarks ↔ country** (harder ones: Petra, Angkor Wat, Chichén Itzá).
- A variant doesn't repeat within 4 days; an item doesn't repeat within 21 days.

### 3.12c Ordering rounds (M) — added 2026-11-20
Five items, put them in order; 20 points per item in the right place. Items are well known (top
half of their pool by popularity); the challenge is the numbers. The five come from a narrow band
of similar values (a window of neighbours) but are still clearly apart (≥15–30% or a fixed gap),
so the order is neither trivial (Canada vs Andorra) nor a coin toss on noisy data.
Variants (`pipeline/geo_pipeline/ordering.py`):
- **cities in one country by population** · **countries by area** · **countries by population**
- **cities by distance from a famous city** (great-circle distance from coordinates)
- **countries by height of their highest mountain** · **capitals by elevation**
- **Olympic host cities by when they last hosted** ("most recently did X")
- **airports by passengers** (rare)
- Later: mountains by height, rivers by length, landmarks by age, countries by independence year.
- Parked: "which country most recently passed law X": no reliable, licence-clean dataset.

### 3.12b Attribute-based questions added 2026-11-20
Monarchies, King Charles III realms, countries named after a person, native-name first letter,
highest mountain over N m / highest point under N m, forest cover, Olympic host countries and
cities (curated list in `pipeline/data/olympics.yaml`), cities on famous rivers.

### 3.14 Phase 6 families as built (2026-11-20)
| Family | Answer type | Examples |
|---|---|---|
| mountains | mountain | a mountain in Japan; over 8,000 m; over 5,000 m not in Asia; a volcano in Iceland |
| water | river / lake | a river in Germany; through 3+ countries; a lake shared by two countries |
| islands | island | an island that belongs to Greece |
| landmarks | landmark | a national park in Kenya; a UNESCO site in Italy; a famous landmark in Asia; a desert |
| regions | region | a US state; a Canadian province; a Japanese prefecture |
| symbols | country / animal | a country whose national animal is a big cat; any national animal |
| map_surprises | country | a country the Equator passes through; entirely in the Southern Hemisphere |

New rounds: outlines ↔ countries, regions ↔ countries, landmarks ↔ countries, countries ↔
national animals; ordering by mountain height, river length, island area, building height.

### 3.13 Parked (too niche for the daily game — endless/expert mode only)
- Sister cities, tripoints of specific minor countries, runway surfaces, volcano types,
  second-level administrative regions.

## 4. Fact cards

For each question, the reveal shows one fact card about the **rarest valid answer given by any
player so far** (fallback: a pre-picked rare answer). Fact cards are short (≤ 40 words), written once
per entity/relation, AI-drafted from Wikidata/Wikipedia facts and human-reviewed. Store in
`entity_facts(entity_id, context, text, reviewed)`.
