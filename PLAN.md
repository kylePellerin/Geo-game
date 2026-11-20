# Implementation plan

## 1. Game rules (MVP)

- 6 questions per day, released 00:00 UTC, identical for all players.
- Each question is about a different category (e.g. airport, country, national park, river…).
- Player types a free-text answer (no autocomplete — it would leak answers). Optional timer (~25 s),
  configurable.
- One submission per question. Result shows: matched entity, valid/invalid, points, rarity tier,
  % of players who gave the same answer, and a few of the most common + rarest valid answers.
- Wrong or unrecognised answer = 0 points.
- If the matcher is unsure, show **"Did you mean X?"** (confirm / retype). This doesn't count as the
  submission.

### Rarity tiers (tune later)

Five tiers, named like the answer rarity categories in QUESTIONS.md §2 (revised 2026-11-20).

| Tier | Share of players giving that answer | Points |
|---|---|---|
| Famous | > 20% | 10 |
| Well known | 10–20% | 25 |
| Familiar | 5–10% | 50 |
| Obscure | 2–5% | 75 |
| Rarest | < 2% | 100 |

### Matching rounds

Some questions are a **matching round** instead of free text: four items on the left, four on the
right, the player pairs them up. Variants: flag ↔ country, capital ↔ country, city ↔ continent
(more later). Every player sees the same eight items, so rarity-by-share doesn't apply; instead
each correct pair scores by how obscure its item is (rarity category of the left item, from
popularity within the variant's pool):

| Item category | Points per correct pair |
|---|---|
| Famous | 10 |
| Well known | 15 |
| Familiar | 25 |
| Obscure | 35 |
| Rarest | 40 |

Max ~100 per round. The correct mapping stays on the server; the client gets the items in shuffled
order. Generated rounds mix categories by difficulty (easy: mostly famous/well-known; medium: one
or two familiar/obscure). Right-hand items are always distinct (e.g. four different continents).

## 2. Data model (Postgres)

```sql
-- NOTE: entities are not only places. Answers can be things linked to places
-- (e.g. "Name a national bird" → answer is a species). See QUESTIONS.md.
entities (
  id            text primary key,     -- Wikidata QID, or "src:xyz" if no QID
  type          text not null,        -- PLACES: country | city | airport | region | national_park
                                      --   | forest | mountain | river | lake | island | volcano
                                      --   | unesco_site | landmark ...
                                      -- NON-PLACES: species | person | language | currency | dish
                                      --   | sport | climate_zone ...
  name          text not null,        -- canonical English display name
  country_id    text references entities(id),
  lat           double precision,
  lon           double precision,
  attrs         jsonb not null default '{}',  -- type-specific: population, elevation_m, passengers,
                                              -- iata, icao, area_km2, length_km, is_capital, ...
  popularity    double precision,     -- Wikipedia pageviews (12-month sum, log-scaled)
  sources       text[]                -- which datasets contributed
)

aliases (
  entity_id     text references entities(id),
  alias         text,                 -- as written
  alias_norm    text,                 -- normalised (see §5)
  kind          text                  -- label | altlabel | lang:xx | former | code | short
)
-- trigram index on aliases(alias_norm); index on (entity type via join, alias_norm)

relations (
  a     text references entities(id),
  rel   text,                         -- borders | located_in | flows_through | part_of_range
                                      -- | has_national_animal | has_national_bird | has_national_flower
                                      -- | named_after | official_language | currency ...
  b     text references entities(id),
  attrs jsonb not null default '{}'   -- qualifiers, e.g. {"official": false, "since": 1968}
)

-- Flag design tags live on country entities: attrs.flag =
-- { colors: [...], stripes: "horizontal|vertical|none", has_star, has_sun, has_crescent,
--   has_cross, has_nordic_cross, has_animal, has_bird, has_plant, has_weapon, has_text,
--   has_map, has_union_jack, ... }   (full list in QUESTIONS.md §3.1)

entity_facts (entity_id text, context text, text text, reviewed bool)  -- fact cards

question_templates (id, kind, entity_type, text_pattern, params_schema, sql_or_filter,
                    min_answers, max_answers, difficulty)

daily_puzzles (date date primary key, created_at, reviewed bool)

puzzle_questions (
  date date references daily_puzzles(date),
  idx  int,                           -- 0..5
  template_id text, params jsonb, question_text text,
  valid_entity_ids text[],            -- frozen answer set
  primary key (date, idx)
)

answers (
  id bigserial, player_id uuid, date date, idx int,
  raw_text text, matched_entity_id text, valid bool,
  points int, created_at timestamptz,
  unique (player_id, date, idx)
)

answer_counts (date, idx, entity_id, n)   -- materialised for fast rarity lookups

unmatched_log (date, idx, raw_text, n)    -- feeds the alias-fixing admin page
```

## 3. Data sources

| Category | Source(s) | Licence | Notes |
|---|---|---|---|
| Countries | Natural Earth admin-0; mledoze/countries; World Bank API; CIA World Factbook | PD / ODbL / CC BY / PD | borders, currencies, languages, population, area, landlocked, continent |
| Cities | GeoNames `cities15000`; Wikidata | CC BY / CC0 | population, capital flags, admin1 |
| Airports | OurAirports (airports.csv) | PD | type (large/medium/small), IATA/ICAO, municipality. **Passengers missing** → Wikidata P3872 + Wikipedia busiest-airport lists; store `passengers` + `passengers_year` |
| Regions (admin-1) | Natural Earth admin-1; GeoNames admin1 | PD / CC BY | |
| National parks | Wikidata (instance of national park Q46169 and subclasses); OSM `boundary=protected_area` + `protect_class=2` / `boundary=national_park` | CC0 / ODbL | **Not WDPA** (no commercial use) |
| Forests | Wikidata (forest Q4421 and subclasses); OSM named `landuse=forest`/`natural=wood` (large only) | CC0 / ODbL | Weakest category — keep questions broad |
| Mountains | Wikidata (mountain Q8502); OSM `natural=peak` with names | CC0 / ODbL | elevation, prominence, range, country |
| Rivers / lakes | Wikidata; Natural Earth rivers/lakes | CC0 / PD | length, countries crossed (P17), mouth |
| Islands, deserts | Wikidata | CC0 | area, country |
| Volcanoes | Smithsonian Global Volcanism Program | free w/ attribution | last eruption, type |
| UNESCO sites | Wikidata (P757) | CC0 | |
| Popularity | Wikimedia pageviews REST API (via Wikidata sitelinks → enwiki title) | free | used for cold-start rarity |
| Aliases | Wikidata labels + altLabels in ~15 major languages; IATA/ICAO; GeoNames alternatenames | CC0 / CC BY | |

Wikidata access: SPARQL (query.wikidata.org) per entity type, paginated with LIMIT/OFFSET or split
by country to avoid timeouts. Respect the user-agent policy. Cache results.

### Policy decisions (configurable, documented in `pipeline/POLICY.md`)
- Country list = UN members + observers + an explicit allowlist (Kosovo, Taiwan) — decide and document.
- Each numeric attribute stores an "as of" year; reveal screen shows it.
- What counts as a "national park" per country.

## 4. Question engine

**Question families, difficulty tiers, the daily mix and the "easy floor" rule are defined in
`QUESTIONS.md` — it is the source of truth for what we ask.** Accessibility for non-geography
players is a core goal: every question needs well-known answers as well as rare ones.

- Templates in `pipeline/templates/*.yaml`. Each has: `kind`, `entity_type`, `text` pattern,
  parameter generator, filter (SQL), `min_answers` (default 10), `max_answers` (default 300),
  `difficulty` (1–3).
- Template kinds to implement:
  - **membership**: "Name a {type} in {continent/country}"
  - **superlative_per_group**: "Name the {largest/busiest/highest} {type} of any country"
  - **intersection**: "Name a country that {A} and {B}" (borders X, uses currency Y, language Z,
    landlocked, on continent C…)
  - **threshold**: "Name a {type} with {attr} over {value}"
  - **relational**: "Name a river that flows through {n}+ countries", "a mountain in the {range}"
  - **name_twist**: "Name a {type} starting with {letter}" (combine with a filter)
- Generator (`pipeline/generate_puzzles.py --from DATE --days N`):
  1. Sample candidate (template, params).
    2. Run filter → answer set; reject if outside min/max, or if it fails the easy-floor / tail
      checks in QUESTIONS.md §2 (≥5 famous/well-known answers, ≥5 not famous).
    3. Assemble 6 questions using the daily mix in QUESTIONS.md §2 (slots 1–3 easy, 4–5 medium,
       6 hard), different families except flags. A flag question every day, a second (harder) one
       on ~1 day in 5; airports at most 2 per 7 days; a matching round (§1) on ~60% of days in
       slot 3 or 4.
    4. No identical template+params within 60 days. Similar answer sets (Jaccard > 0.5) within
       14 days are allowed but strongly down-weighted (decided 2026-11-20: some repetition of
       similar questions in later days is fine).
  5. Write to `daily_puzzles` / `puzzle_questions` with `reviewed = false`.
- Generate ~90 days ahead. Admin review page can approve/replace questions.

## 5. Answer matching (spelling correction)

Pipeline for `match(raw_text, entity_type)`:

1. **Normalise**: NFKD, strip diacritics, lowercase, `&`→`and`, `st.`→`saint`, strip punctuation,
   collapse whitespace, drop leading "the", drop type suffixes ("national park", "airport",
   "international airport", "river", "mount"/"mt", "lake", "forest", "island"…).
   Apply the same normalisation to aliases at load time.
2. **Exact** alias lookup restricted to `entity_type` → set of entities.
3. **Fuzzy** if no exact hit: `pg_trgm` similarity + Damerau-Levenshtein on top candidates.
   Thresholds by length: ≤4 chars → exact only (codes); 5–7 → edit distance ≤1; 8+ → ≤2 or
   similarity ≥ 0.6.
4. **Decide**:
   - one clear winner (score gap above margin) → match.
   - close but uncertain → return "did you mean" with top candidate.
   - nothing → unrecognised; log to `unmatched_log`.
5. **Validity**: if the matched *name* maps to multiple entities (Springfield), the answer is valid
   if any of them is in the valid set; record that one.
6. Result categories for the UI: `valid`, `real_but_wrong` ("that's an airport, but not the busiest
   in its country"), `unrecognised`.

Fixtures (`pipeline/tests/match_cases.yaml`): ≥100 cases incl. "Kathmandoo", "Reykavik", "JFK",
"Heathrow airport", "Bombay", "Côte d'Ivoire"/"Ivory Coast", "Mt Everest", "the Amazon",
"Yosemite NP", "St Petersburg", "DRC", "Czechia"/"Czech Republic". Build the matcher test-first.

## 6. Scoring

- `share = n_same_answer / n_total_answers` for that question today.
- **Cold-start prior** from popularity: for each valid entity,
  `prior_share = softmax(popularity / T)` over the valid set (tune T so the top answer gets ~25–40%).
- Blend: `w = n_total / (n_total + 50)`; `est_share = w * observed + (1 - w) * prior`.
- Map `est_share` to tier (five tiers, table in §1). Points awarded immediately.
- Matching rounds: points per correct pair by item rarity category (table in §1, "Matching rounds").
- Nightly job: recompute final shares → leaderboard scores (keep the instant score displayed; store both).

## 7. API (Next.js route handlers)

- `GET /api/daily` → `{ date, questions: [{ idx, text, category }] }` (no answers).
- `POST /api/answer` `{ date, idx, text, confirm_entity_id? }` →
  `{ status: valid|real_but_wrong|unrecognised|did_you_mean, entity?, points, tier, share,
     common_answers, rare_answers }`.
- `GET /api/results/:date` → player's 6 results + share string.
- Anonymous `player_id` (UUID, httpOnly cookie). Unique constraint enforces one answer per question.
- Basic rate limiting on `/api/answer`.

## 8. Phases

**Phase 0 — Scaffold.** Repo layout (`/pipeline`, `/app`), Docker Compose for local Postgres with
`pg_trgm` + `unaccent`, migrations, `SOURCES.md`, `POLICY.md`, lint/test setup. *Done when:* `make db`
and `make test` work.

**Phase 1 — Data (countries, cities, airports, flags).** Ingest scripts, Wikidata joins, aliases,
relations (borders, located_in), popularity from pageviews, load into Postgres. Flag tags: draft
`attrs.flag` for every country from Wikimedia SVGs, write to `pipeline/flags_tags.yaml` for human
review before loading. Data-quality report script
(counts per type, % with QID, % with population/passengers, top missing). *Done when:* report looks
sane; e.g. ~195 countries, ~25k cities, all large airports with IATA.

**Phase 2 — Question engine.** Template format, 15–20 templates over the three categories, generator
with constraints, 30 days generated. *Done when:* a printed sample of 30 days reads well and every
question has 10–300 answers.

**Phase 3 — Matcher.** Implement §5 against the fixtures. *Done when:* ≥95% of fixtures pass and no
fixture of a wrong answer matches a valid one.

**Phase 4 — API + scoring.** §6 and §7, answer logging, answer_counts, and the `player_stats`
table + update-after-game logic from §10 (so stats data is collected from day one). *Done when:*
integration tests simulate 500 players and tiers distribute sensibly.

**Phase 5 — Minimal UI.** Question → input → result → next; end screen with share text
(e.g. emoji tiers). *Done when:* playable end to end locally.

**Phase 6 — More categories.** Add one at a time, easy families first: national symbols (needs the
non-place entity types + relation qualifiers), landmarks/UNESCO, national parks, mountains,
rivers/lakes, map-surprise templates, names & language, borders, then deep dives (volcanoes,
climate) and forests last. Also: fact cards (`entity_facts`) and per-question stats
(% scoring > 0, median points) for difficulty calibration. Each = ingest + aliases + templates + fixtures.
Admin page: review upcoming puzzles, replace a question, browse `unmatched_log` and add aliases.

**Phase 7 — Retention.** Stats page, transfer code and optional account upgrade (§10), daily
leaderboard, endless/practice mode, deploy (Vercel + Supabase).

## 10. Player stats (no account needed)

### Identity
- On first visit the server issues a random `player_id` (UUID) in an **httpOnly, Secure,
  SameSite=Lax cookie** with a 2-year expiry (server-set cookies survive Safari's limits on
  script-written storage better than localStorage).
- Mirror the `player_id` in localStorage. On load, if cookie and localStorage disagree or one is
  missing, call `POST /api/identity/reconcile` to restore the existing history (never silently
  create a second player when one ID is still present).

### Data
```sql
players (
  id uuid primary key, created_at timestamptz, last_seen_at timestamptz,
  account_user_id uuid null            -- set when upgraded to a real account
)

player_stats (
  player_id uuid primary key references players(id),
  games_played int, current_streak int, max_streak int, last_played_date date,
  best_score int, best_score_date date, total_points bigint,
  hundred_point_answers int,
  rarest_answer_entity_id text, rarest_answer_share double precision, rarest_answer_date date,
  score_histogram jsonb,               -- bucketed final scores, e.g. {"0-99":3,"100-199":7,...}
  family_stats jsonb,                  -- per question family: {"flags":{"n":20,"avg":72},...}
  updated_at timestamptz
)

transfer_codes (code text primary key, player_id uuid, created_at, expires_at, used_at)
```
- `player_stats` is updated in one transaction when a player finishes their 6th question.
  It must also be fully **rebuildable from `answers`** (script: `rebuild_player_stats`), so it's a
  cache, never the only copy.
- Streak: played on consecutive UTC dates; missing a day resets `current_streak`.
- Daily percentile ("better than 84% of players today") computed from that day's final scores.

### Stats page shows
Games played · current / best streak · best score · average · score histogram ·
100-point answers · rarest answer ever (with % of players) · best & worst question family ·
today's percentile.

### Moving devices: transfer code
- Stats page → "Play on another device" → generates an 8-character code (no ambiguous characters
  like 0/O, 1/I) + QR code, valid 24 h, single use.
- `POST /api/identity/claim {code}` on the new device sets the cookie to the original `player_id`.
- If the new device already has its own history, merge it into the original (sum games, recompute
  streaks and bests from `answers`).
- Rate-limit claim attempts.

### Optional account later
- "Save your progress" with email magic link or Google (Supabase Auth). On sign-up, link the
  current `player_id` to the account (`players.account_user_id`). Signing in on any device attaches
  that device to the same player. Anonymous play remains fully supported.

### Privacy
- No personal data is stored for anonymous players. Add a short privacy note and a
  "delete my data" button that removes the player's rows.

## 11. Known risks

- Alias coverage is the #1 fairness issue — keep iterating via `unmatched_log`.
- Airport passenger data is patchy; restrict passenger-based questions to airports with data for a
  recent year, or fall back to OurAirports `large_airport` type.
- Forest data is inconsistent; avoid narrow forest questions.
- Wikidata SPARQL timeouts — split queries by country/type, cache aggressively.

## 12. TODO — deferred work

- [ ] **Popularity from real pageviews (deferred 2026-11-19, revisit before launch / before tuning
  rarity priors).** The Wikimedia pageviews API throttles our client to ~20 requests then a ~30 s
  `Retry-After` (the MediaWiki `prop=pageviews` API too), so ~19k titles would take 4+ hours.
  For now `popularity` is a **sitelinks-based estimate** (`attrs.popularity_source =
  "sitelinks_estimate"`, fixed mapping `DEFAULT_FIT` in `geo_pipeline/popularity.py`). Good enough
  for within-type ranking (easy-floor / tail checks) but not calibrated for the §6 cold-start prior.
  To finish: decide on a contact email/URL for the User-Agent (Wikimedia gives identified clients
  more headroom), then run `cd pipeline && python -m geo_pipeline.popularity --max-minutes 240`
  repeatedly (resumable, cached in `raw/pageviews/`) until complete, then `make load`. Once ≥30
  entities per type have views, the estimate is re-fitted per type automatically.
- [ ] **Grow the question pool before launch (Phase 6).** With 7 families and the rules in §4
  (6 families/day, no repeat within 60 days), 30 days needs ~180 distinct questions; the Phase 2
  templates yield ~220 that pass, so late days fall back (harder/easier slot, repeated family, or
  even the same template twice). The generator logs every fallback. Hard (slot 6) questions are
  the scarcest (13): deep-dive data (volcanoes, climate) is the real fix. New families from Phase 6
  (symbols, landmarks, nature) remove the family-reuse fallbacks.
