# Data policy

These decisions apply to the data pipeline and should be revisited when source coverage or legal
requirements change.

- **Countries:** include UN member states and observers, plus Kosovo and Taiwan. Store an explicit
  allowlist so the resulting set is reproducible.
- **Numeric attributes:** record the source and an `as_of` year for every time-sensitive value.
  The game should reveal that year when showing the relevant answer.
- **National parks:** include entities identified as national parks by Wikidata and qualifying
  OSM protected-area tags. Do not use WDPA / Protected Planet. Preserve each source's classification
  and avoid implying that country-level definitions are uniform.
- **Commercial use:** use only sources whose terms permit the intended use; preserve ODbL and CC BY
  attribution obligations in `SOURCES.md` and the credits page.
- **Historical puzzles:** freeze the valid answer IDs when a puzzle is generated. Later data updates
  must not change previously published answer sets.

## Decisions made in Phase 1

- **Country set (197):** the 193 UN members + observers Vatican City and Palestine + allowlist
  Kosovo and Taiwan (`OBSERVERS` / `ALLOWLIST` in `ingest/countries.py`). Western Sahara is not a
  country entity. `attrs.un_status` is `member | observer | non_member`.
- **Country QIDs:** chosen by ISO alpha-2 (P297); where several items share a code, the most-linked
  one wins, with explicit overrides (`QID_OVERRIDES`: Netherlands = Q55, not the Kingdom Q29999).
- **Territories:** cities/airports in dependent territories (Puerto Rico, Hong Kong, Greenland,
  Aruba…) get `country_id` = sovereign country and keep `attrs.territory` = territory ISO code.
  Question templates must decide explicitly whether territories count ("a city in the USA").
- **Territories as answers (2026-11-22, playtest: "Greenland didn't count"):** the 46 inhabited
  dependent territories in mledoze (Greenland, Puerto Rico, Hong Kong, Faroe Islands, Bermuda…)
  are also type `country` entities, with `attrs.un_status = "territory"`, `attrs.is_territory`
  and `attrs.sovereign` (QID, from Wikidata P17; null for Western Sahara). Left out: Antarctica,
  Bouvet, Heard & McDonald, US Minor Outlying Islands, French Southern Lands, British Indian Ocean
  Territory, South Georgia (no permanent population). So every country question *recognises*
  them, but a template only *accepts* them with `territories: true` (continent/region, population,
  area, letters, languages, euro, map lines); the question then shows "Territories count too".
  Elsewhere a territory answer is real-but-wrong with "X is a territory of Y, this one is countries
  only". Territories are never in borders, matching or ordering rounds, and cities keep
  `country_id` = sovereign. Where a territory's QID was also an island (Greenland Q223), the
  island facet gets the id `Q…#island`, like city-states' `Q…#region`.
- **Continents:** from mledoze region; Americas split into North America (incl. Central America
  and Caribbean) and South America. Russia and Türkiye are in Europe/Asia respectively, as mledoze
  has them; transcontinental membership is not modelled yet.
- **Borders:** land borders from mledoze, kept only when listed by both countries.
- **Driving side:** Wikidata P1622, ignoring statements with an end date.
- **Population "as of":** countries = World Bank latest year (2025) or Wikidata with its point in
  time; cities = GeoNames (no year given, treat as "recent estimate").
- **Cities:** GeoNames cities15000 minus PPLX (city sections), PPLH, PPLQ, PPLW.
- **Airports:** OurAirports `large_airport` + `medium_airport` with an IATA code and scheduled
  service. Passenger counts only with a Wikidata point-in-time year; `passengers_year` is shown.
- **Popularity:** target is `log10(1 + enwiki user pageviews over the last 12 complete months)`.
  **Currently deferred** (see PLAN.md §12): popularity is estimated from Wikidata sitelinks and
  marked `attrs.popularity_source = "sitelinks_estimate"`.
- **Flags:** colours are measured from flag-icons SVGs (main ≥ 2 % of area, minor ≥ 0.3 %);
  feature tags are AI-drafted. `flags_tags.yaml` must be human-reviewed (`reviewed: true`) before
  the loader uses it without `--allow-unreviewed-flags`.
