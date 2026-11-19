# Data sources and attribution

Record the source version, retrieval date, licence and attribution for every dataset used.
Raw downloads are cached in `pipeline/raw/` (gitignored); re-download with `--refresh`.
**Do not use WDPA / Protected Planet.**

## In use (Phase 1)

| Dataset | Used for | Licence / terms | Attribution required | As of (retrieved) |
|---|---|---|---|---|
| [mledoze/countries](https://github.com/mledoze/countries) `countries.json` | Country list, names, translations, borders, landlocked, area, region, languages, currencies | ODbL 1.0 | **Yes** | 2026-11-19 (master) |
| [World Bank API](https://data.worldbank.org/indicator/SP.POP.TOTL) `SP.POP.TOTL` | Country population (latest year, 2025) | CC BY 4.0 | **Yes** | 2026-11-19 (data updated 2026-11-11) |
| [GeoNames](https://www.geonames.org/) `cities15000.zip`, `admin1CodesASCII.txt` | Cities (pop ≥ 15,000), coordinates, population, admin-1 names | CC BY 4.0 | **Yes** | 2026-11-19 |
| [OurAirports](https://ourairports.com/data/) `airports.csv` | Airports (large/medium, IATA, scheduled service), codes, elevation, municipality | Public domain | No (courtesy credit) | 2026-11-19 |
| [Wikidata](https://www.wikidata.org/) SPARQL | QIDs, labels/aliases (18 languages), driving side (P1622), capitals (P36), island nations, GeoNames IDs (P1566), airport codes (P238/P239), passengers (P3872 + P585), named after (P138), population fallback (Taiwan, Vatican) | CC0 | No | 2026-11-19 |
| [Wikimedia pageviews API](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/) | Popularity = log10(1 + enwiki user pageviews, Nov 2025 – Oct 2026) | CC0 (data); follow Wikimedia API etiquette | No | 2026-11-19 |
| [flag-icons](https://github.com/lipis/flag-icons) v7.6.0 (npm) | Flag SVGs for display and for measuring flag colours | MIT | Keep licence notice | 2026-11-19 |

Notes:
- GeoNames `alternatenames` is deliberately not used for aliases (machine romanisations cause
  false fuzzy matches); city aliases come from GeoNames name/asciiname + Wikidata.
- Flag boolean tags (`data/flag_features_draft.yaml`) are AI-drafted from general knowledge and
  require human review in `flags_tags.yaml` before production use.

## Planned (not yet ingested)

| Dataset | Planned use | Licence / terms |
|---|---|---|
| Natural Earth | admin-1, rivers, lakes | Public domain |
| OpenStreetMap | Protected areas, named features | ODbL; attribution required |
| Wikipedia lists of national symbols | National animals, birds, flowers, dishes, sports | CC BY-SA 4.0; share-alike review required |
| Köppen-Geiger climate map | Capital-city climate questions | CC BY 4.0 |
| Smithsonian Global Volcanism Program | Volcano data | Free with attribution; check terms |

## Credits page list (attribution obligations)

- Country data © mledoze/countries contributors, ODbL 1.0.
- Population data: The World Bank, World Development Indicators (CC BY 4.0).
- City data: GeoNames (geonames.org), CC BY 4.0.
- Airport data: OurAirports (public domain).
- Data from Wikidata (CC0) and Wikimedia pageview statistics.
- Flag images: flag-icons by Panayiotis Lipiridis, MIT licence.
