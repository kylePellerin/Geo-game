"""Data-quality report, computed from Postgres (so it also validates the load).

Prints Markdown and writes out/quality_report.md.
"""

from __future__ import annotations

from geo_pipeline.common import OUT, setup_logging
from geo_pipeline.db import connect


def table(cur, sql: str) -> str:
    cur.execute(sql)
    cols = [d.name for d in cur.description]
    rows = cur.fetchall()
    if not rows:
        return "_none_\n"

    def fmt(v):
        if isinstance(v, float):
            return f"{v:.1f}"
        return "" if v is None else str(v)

    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]
    return "\n".join(lines) + "\n"


SECTIONS = [
    ("Entities per type", """
SELECT type, count(*) AS n,
  round(100.0 * avg((id LIKE 'Q%')::int), 1) AS pct_qid,
  round(100.0 * avg((lat IS NOT NULL)::int), 1) AS pct_coords,
  round(100.0 * avg((popularity > 0)::int), 1) AS pct_popularity_gt0,
  round(100.0 * avg((attrs ? 'population')::int), 1) AS pct_population,
  round(100.0 * avg((attrs ? 'passengers')::int), 1) AS pct_passengers,
  round(100.0 * avg((country_id IS NOT NULL)::int), 1) AS pct_country
FROM entities GROUP BY type ORDER BY n DESC"""),
    ("Aliases per type", """
SELECT e.type, count(*) AS aliases, round(count(*)::numeric / count(DISTINCT e.id), 1) AS per_entity,
  count(DISTINCT a.alias_norm) AS distinct_norms
FROM aliases a JOIN entities e ON e.id = a.entity_id GROUP BY e.type ORDER BY 1"""),
    ("Relations", "SELECT rel, count(*) AS n FROM relations GROUP BY rel ORDER BY n DESC"),
    ("Countries by continent", """
SELECT attrs->>'continent' AS continent, count(*) AS n FROM entities WHERE type = 'country'
GROUP BY 1 ORDER BY 2 DESC"""),
    ("Country attribute coverage", """
SELECT count(*) AS countries,
  count(*) FILTER (WHERE attrs ? 'flag') AS with_flag,
  count(*) FILTER (WHERE attrs ? 'drives_on') AS with_driving_side,
  count(*) FILTER (WHERE attrs->>'drives_on' = 'left') AS drive_left,
  count(*) FILTER (WHERE (attrs->>'landlocked')::boolean) AS landlocked,
  count(*) FILTER (WHERE (attrs->>'island_nation')::boolean) AS island_nations,
  count(*) FILTER (WHERE attrs->>'un_status' = 'member') AS un_members,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM relations r WHERE r.a = e.id
                   AND r.rel = 'borders')) AS no_land_borders
FROM entities e WHERE type = 'country'"""),
    ("Countries whose capital is not among the cities", """
SELECT c.name, c.attrs->'capital_names' AS capital_names
FROM entities c WHERE c.type = 'country' AND NOT EXISTS (
  SELECT 1 FROM entities ct WHERE ct.type = 'city' AND ct.country_id = c.id
  AND (ct.attrs->>'is_capital')::boolean)
ORDER BY c.name"""),
    ("Cities", """
SELECT count(*) AS cities,
  count(*) FILTER (WHERE (attrs->>'population')::bigint >= 1000000) AS over_1m,
  count(*) FILTER (WHERE (attrs->>'is_capital')::boolean) AS capitals,
  count(*) FILTER (WHERE attrs ? 'territory') AS in_territories
FROM entities WHERE type = 'city'"""),
    ("Biggest cities without a Wikidata QID (top 15)", """
SELECT name, attrs->>'iso2' AS iso2, (attrs->>'population')::bigint AS population
FROM entities WHERE type = 'city' AND id NOT LIKE 'Q%'
ORDER BY 3 DESC NULLS LAST LIMIT 15"""),
    ("Biggest cities with zero popularity (top 10)", """
SELECT name, attrs->>'iso2' AS iso2, (attrs->>'population')::bigint AS population
FROM entities WHERE type = 'city' AND coalesce(popularity, 0) = 0
ORDER BY 3 DESC NULLS LAST LIMIT 10"""),
    ("Airports", """
SELECT attrs->>'airport_type' AS airport_type, count(*) AS n,
  count(*) FILTER (WHERE attrs ? 'iata') AS with_iata,
  count(*) FILTER (WHERE attrs ? 'passengers') AS with_passengers,
  count(*) FILTER (WHERE (attrs->>'passengers_year')::int >= 2022) AS passengers_2022_plus,
  count(*) FILTER (WHERE jsonb_array_length(coalesce(attrs->'named_after', '[]')) > 0)
    AS named_after_person
FROM entities WHERE type = 'airport' GROUP BY 1 ORDER BY 2 DESC"""),
    ("Most-viewed large airports without passenger data (top 15)", """
SELECT name, attrs->>'iata' AS iata, attrs->>'iso2' AS iso2, round(popularity::numeric, 2) AS pop
FROM entities WHERE type = 'airport' AND attrs->>'airport_type' = 'large'
AND NOT attrs ? 'passengers' ORDER BY popularity DESC NULLS LAST LIMIT 15"""),
    ("Countries with passenger data for >= 1 airport", """
SELECT count(DISTINCT country_id) AS countries FROM entities
WHERE type = 'airport' AND attrs ? 'passengers'"""),
    ("Top 10 by popularity per type", """
SELECT type, string_agg(name, ', ' ORDER BY popularity DESC) AS top10 FROM (
  SELECT type, name, popularity, row_number() OVER (PARTITION BY type ORDER BY popularity DESC
    NULLS LAST) AS rn FROM entities) t WHERE rn <= 10 GROUP BY type"""),
    ("Alias collisions within a type (top 20 by popularity of the less popular entity)", """
SELECT e1.type, a1.alias_norm, e1.name AS entity_1, e2.name AS entity_2,
  round(least(e1.popularity, e2.popularity)::numeric, 2) AS min_pop
FROM aliases a1 JOIN aliases a2 ON a1.alias_norm = a2.alias_norm AND a1.entity_id < a2.entity_id
JOIN entities e1 ON e1.id = a1.entity_id JOIN entities e2 ON e2.id = a2.entity_id
WHERE e1.type = e2.type AND e1.type IN ('country', 'airport')
GROUP BY 1, 2, 3, 4, 5 ORDER BY min_pop DESC NULLS LAST LIMIT 20"""),
    ("Collision counts by type", """
SELECT e.type, count(*) AS shared_norms FROM (
  SELECT a.alias_norm, e.type FROM aliases a JOIN entities e ON e.id = a.entity_id
  GROUP BY 1, 2 HAVING count(DISTINCT a.entity_id) > 1) x JOIN (SELECT DISTINCT type FROM entities) e
  USING (type) GROUP BY 1 ORDER BY 1"""),
]


def main() -> None:
    parts = ["# Data-quality report\n"]
    with connect() as conn, conn.cursor() as cur:
        for title, sql in SECTIONS:
            parts.append(f"\n## {title}\n\n" + table(cur, sql))
    text = "".join(parts)
    OUT.mkdir(exist_ok=True)
    (OUT / "quality_report.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    setup_logging()
    main()
