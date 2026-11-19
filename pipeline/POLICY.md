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
