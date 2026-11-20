"""Load normalised Parquet outputs into Postgres (idempotent upsert).

- entities: upsert by id. Entities that disappeared from the sources are reported, and deleted only
  with --prune and only if no puzzle, answer or stat references them.
- aliases: for each loaded entity, non-manual aliases are replaced; kind='manual' (added from the
  admin page) are kept. alias_norm = normalize(alias, entity type).
- relations: replaced per (a, rel) for loaded entities; rows whose ends don't exist are skipped.
- flags: attrs.flag merged from flags_tags.yaml (only if reviewed, unless --allow-unreviewed-flags).
"""

from __future__ import annotations

import argparse
import json

import pandas as pd
import yaml

from geo_pipeline.common import OUT, PIPELINE_DIR, log, setup_logging
from geo_pipeline.db import connect
from geo_pipeline.normalize import is_bare_affix, normalize

FLAGS_FILE = PIPELINE_DIR / "flags_tags.yaml"


def read_all(kind: str) -> pd.DataFrame:
    frames = [pd.read_parquet(p) for p in sorted(OUT.glob(f"*_{kind}.parquet"))]
    if not frames:
        raise SystemExit(f"no out/*_{kind}.parquet files; run the ingest scripts first")
    return pd.concat(frames, ignore_index=True)


def merge_flags(ents: pd.DataFrame, allow_unreviewed: bool) -> pd.DataFrame:
    if not FLAGS_FILE.exists():
        log.warning("%s missing; countries loaded without attrs.flag", FLAGS_FILE.name)
        return ents
    doc = yaml.safe_load(FLAGS_FILE.read_text(encoding="utf-8"))
    if not doc.get("reviewed") and not allow_unreviewed:
        log.warning("flags_tags.yaml not marked reviewed: skipping flags "
                    "(use --allow-unreviewed-flags for development)")
        return ents
    flags = doc["flags"]
    by_iso2 = {}
    for iso2, tags in flags.items():
        by_iso2[iso2] = {k: v for k, v in tags.items() if k != "name"}
        by_iso2[iso2]["reviewed"] = bool(doc.get("reviewed"))

    def add(row: pd.Series) -> str:
        attrs = json.loads(row["attrs"])
        if row["type"] == "country" and attrs.get("iso2") in by_iso2:
            attrs["flag"] = by_iso2[attrs["iso2"]]
        return json.dumps(attrs, ensure_ascii=False)

    ents = ents.copy()
    ents["attrs"] = ents.apply(add, axis=1)
    return ents


def clean_aliases(al: pd.DataFrame, ents: pd.DataFrame, types: pd.Series) -> pd.DataFrame:
    """Drop aliases that would make matching ambiguous or unfair.

    1. empty, or nothing but a type word ("aeroport");
    2. <= 2 characters unless a code (other-language fragments like "ri", "bd");
    3. equal to the main label of a *different* entity of the same type, unless it is also this
       entity's label ("China" as an alias of Taiwan; but both Romes keep "rome").
    The entity's display name is always kept as a label.
    """
    names = pd.DataFrame({
        "entity_id": ents["id"], "alias": ents["name"], "kind": "label",
    })
    al = pd.concat([al, names], ignore_index=True)
    al["alias_norm"] = [normalize(a, types[e]) for a, e in zip(al["alias"], al["entity_id"])]
    al["type"] = al["entity_id"].map(types)
    bare = pd.Series(
        [is_bare_affix(n, t) for n, t in zip(al["alias_norm"], al["type"])], index=al.index
    )
    short = (al["alias_norm"].str.len() <= 2) & (al["kind"] != "code")
    al = al[(al["alias_norm"] != "") & ~bare & ~short]

    is_label = al["kind"] == "label"
    label_owners = al[is_label].groupby(["type", "alias_norm"])["entity_id"].agg(set)
    own_labels = set(zip(al.loc[is_label, "entity_id"], al.loc[is_label, "alias_norm"]))
    keep = [
        (eid, norm) in own_labels or eid in label_owners.get((t, norm), {eid}) or
        (t, norm) not in label_owners.index
        for eid, norm, t in zip(al["entity_id"], al["alias_norm"], al["type"])
    ]
    dropped = len(al) - sum(keep)
    al = al[keep]
    log.info("alias cleaning: dropped %d aliases that clash with another entity's label", dropped)
    return al.drop(columns="type").drop_duplicates(["entity_id", "alias_norm", "kind"])


def main(allow_unreviewed_flags: bool = False, prune: bool = False) -> None:
    ents = read_all("entities")
    al = read_all("aliases")
    rel = read_all("relations")
    pop_path = OUT / "popularity.parquet"
    if pop_path.exists():
        pop = pd.read_parquet(pop_path).set_index("id")
        ents["popularity"] = ents["id"].map(pop["popularity"])
        views = ents["id"].map(pop["views_12m"])
        source = ents["id"].map(pop["popularity_source"])
        ents["attrs"] = [
            json.dumps(
                {**json.loads(a),
                 **({"popularity_source": s} if isinstance(s, str) else {}),
                 **({"views_12m": int(v)} if pd.notna(v) else {})},
                ensure_ascii=False,
            )
            for a, v, s in zip(ents["attrs"], views, source)
        ]
    else:
        log.warning("no popularity.parquet; popularity left NULL (run geo_pipeline.popularity)")
        ents["popularity"] = None
    ents = merge_flags(ents, allow_unreviewed_flags)

    types = ents.set_index("id")["type"]
    al = clean_aliases(al[al["entity_id"].isin(types.index)].copy(), ents, types)
    ids = set(ents["id"])
    bad = ~(rel["a"].isin(ids) & rel["b"].isin(ids))
    if bad.any():
        log.warning("skipping %d relations with unknown ends", int(bad.sum()))
    rel = rel[~bad].drop_duplicates(["a", "rel", "b"])

    # countries first so country_id references resolve
    ents = ents.sort_values("type", key=lambda s: s != "country")

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TEMP TABLE stage_entities (LIKE entities INCLUDING DEFAULTS) ON COMMIT DROP;
            CREATE TEMP TABLE stage_aliases (LIKE aliases) ON COMMIT DROP;
            CREATE TEMP TABLE stage_relations (LIKE relations INCLUDING DEFAULTS) ON COMMIT DROP;
        """)
        with cur.copy(
            "COPY stage_entities (id, type, name, country_id, lat, lon, attrs, popularity, sources)"
            " FROM STDIN"
        ) as cp:
            for r in ents.itertuples(index=False):
                cp.write_row([
                    r.id, r.type, r.name, r.country_id,
                    None if r.lat != r.lat else r.lat, None if r.lon != r.lon else r.lon,
                    r.attrs, None if r.popularity is None or r.popularity != r.popularity
                    else float(r.popularity),
                    list(r.sources) if r.sources is not None else None,
                ])
        with cur.copy("COPY stage_aliases (entity_id, alias, alias_norm, kind) FROM STDIN") as cp:
            for r in al.itertuples(index=False):
                cp.write_row([r.entity_id, r.alias, r.alias_norm, r.kind])
        with cur.copy("COPY stage_relations (a, rel, b, attrs) FROM STDIN") as cp:
            for r in rel.itertuples(index=False):
                cp.write_row([r.a, r.rel, r.b, r.attrs])

        # country_id is deferred via two passes: insert without it, then set it.
        cur.execute("""
            INSERT INTO entities (id, type, name, lat, lon, attrs, popularity, sources)
            SELECT id, type, name, lat, lon, attrs, popularity, sources FROM stage_entities
            ON CONFLICT (id) DO UPDATE SET
              type = EXCLUDED.type, name = EXCLUDED.name, lat = EXCLUDED.lat,
              lon = EXCLUDED.lon, attrs = EXCLUDED.attrs, popularity = EXCLUDED.popularity,
              sources = EXCLUDED.sources;
            UPDATE entities e SET country_id = s.country_id
              FROM stage_entities s WHERE e.id = s.id
              AND e.country_id IS DISTINCT FROM s.country_id;
            DELETE FROM aliases a USING stage_entities s
              WHERE a.entity_id = s.id AND a.kind <> 'manual';
            INSERT INTO aliases SELECT * FROM stage_aliases ON CONFLICT DO NOTHING;
            DELETE FROM relations r USING (SELECT DISTINCT a, rel FROM stage_relations) s
              WHERE r.a = s.a AND r.rel = s.rel;
            INSERT INTO relations SELECT * FROM stage_relations ON CONFLICT DO NOTHING;
        """)
        cur.execute(
            "SELECT count(*) FROM entities e WHERE NOT EXISTS "
            "(SELECT 1 FROM stage_entities s WHERE s.id = e.id)"
        )
        stale = cur.fetchone()[0]
        if prune and stale:
            # only entities no puzzle, answer or stat references (past puzzles stay intact)
            cur.execute("""
                DELETE FROM entities e
                WHERE NOT EXISTS (SELECT 1 FROM stage_entities s WHERE s.id = e.id)
                  AND NOT EXISTS (SELECT 1 FROM puzzle_questions q WHERE e.id = ANY(q.valid_entity_ids))
                  AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.matched_entity_id = e.id)
                  AND NOT EXISTS (SELECT 1 FROM answer_counts c WHERE c.entity_id = e.id)
                  AND NOT EXISTS (SELECT 1 FROM player_stats p WHERE p.rarest_answer_entity_id = e.id)
                  AND NOT EXISTS (SELECT 1 FROM entities c WHERE c.country_id = e.id AND c.id <> e.id)
            """)
            log.info("pruned %d stale entities", cur.rowcount)
            stale -= cur.rowcount
        cur.execute("ANALYZE entities; ANALYZE aliases; ANALYZE relations;")
    log.info("loaded %d entities, %d aliases, %d relations", len(ents), len(al), len(rel))
    if stale:
        log.warning("%d entities in the DB are no longer in any source (kept)", stale)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--allow-unreviewed-flags", action="store_true")
    p.add_argument("--prune", action="store_true",
                   help="delete entities no longer in any source, if nothing references them")
    a = p.parse_args()
    main(a.allow_unreviewed_flags, a.prune)
