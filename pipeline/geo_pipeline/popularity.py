"""Popularity for every entity: English Wikipedia pageviews (12 complete months), with a fallback.

Input: out/*_entities.parquet (attrs.enwiki, attrs.wikidata_sitelinks).
Output: out/popularity.parquet  id, views_12m, popularity, popularity_source

popularity = log10(1 + views_12m). The Wikimedia pageviews API throttles unauthenticated clients
hard (~20 requests, then a ~30 s Retry-After), so fetching is:
  - single-threaded, honouring Retry-After;
  - in priority order (countries, airports, then cities by population);
  - resumable: every result is appended to raw/pageviews/<period>.jsonl;
  - bounded by --max-minutes, so it can be re-run until complete.
Entities not fetched yet get an estimate from Wikidata sitelinks: a per-type least-squares fit of
log10(1+views) on log10(1+sitelinks) over the entities that do have views
(popularity_source = "sitelinks_estimate"). No enwiki article and no sitelinks -> 0 ("none").
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date
from urllib.parse import quote

import numpy as np
import pandas as pd

from geo_pipeline.common import OUT, RAW, log, session, setup_logging

API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org"
TYPE_PRIORITY = {"country": 0, "airport": 1, "city": 2}
# log10(1+views) ~= a + b*log10(1+sitelinks); rough fit (France: ~300 sitelinks, ~3.5M views/yr)
DEFAULT_FIT = (1.0, 2.0)
MIN_FETCHED_PER_TYPE = 50


def period(today: date | None = None) -> tuple[str, str]:
    """The last 12 complete calendar months, as (YYYYMM0100, YYYYMMDD00)."""
    today = today or date.today()
    end_y, end_m = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    start_y, start_m = (end_y - 1, end_m + 1) if end_m < 12 else (end_y, 1)
    last_day = (date(end_y + (end_m == 12), end_m % 12 + 1, 1) - date.resolution).day
    return f"{start_y}{start_m:02d}0100", f"{end_y}{end_m:02d}{last_day:02d}00"


def fetch_views(title: str, start: str, end: str) -> int:
    """Sum of monthly user pageviews; 0 if the API has no data (404)."""
    url = f"{API}/all-access/user/{quote(title.replace(' ', '_'), safe='')}/monthly/{start}/{end}"
    for attempt in range(8):
        r = session().get(url, timeout=60)
        if r.status_code == 200:
            return sum(item["views"] for item in r.json().get("items", []))
        if r.status_code == 404:
            return 0
        if r.status_code in (429, 500, 502, 503, 504):
            wait = float(r.headers.get("retry-after") or 0) or 5 * 2**attempt
            time.sleep(min(wait + 1, 300))
            continue
        r.raise_for_status()
    raise RuntimeError(f"pageviews: gave up on {title!r}")


def priority_order(ents: pd.DataFrame) -> list[str]:
    """Countries, then capitals, then large airports, then everything else by population."""
    attrs = ents["attrs"].map(json.loads)
    tier = [
        0 if t == "country" else 1 if a.get("is_capital") else
        2 if a.get("airport_type") == "large" else 3 + TYPE_PRIORITY.get(t, 9)
        for t, a in zip(ents["type"], attrs)
    ]
    pop = attrs.map(lambda a: a.get("population") or 0)
    order = ents.assign(_t=tier, _p=-pop).sort_values(["_t", "_p"])
    return list(dict.fromkeys(order["enwiki"].dropna()))


def estimate_from_sitelinks(ents: pd.DataFrame) -> pd.Series:
    """Per-type fit of log10(1+views) ~ a + b*log10(1+sitelinks), applied where views are unknown."""
    est = pd.Series(np.nan, index=ents.index)
    for etype, g in ents.groupby("type"):
        x = np.log10(1 + g["sitelinks"].astype(float))
        # fit only on real fetched pageviews (rows without an article have views=0 by definition)
        has_article = g["enwiki"].notna() if "enwiki" in g else True
        known = g["views_12m"].notna() & g["sitelinks"].notna() & has_article
        if known.sum() >= 30:
            b, a = np.polyfit(x[known], np.log10(1 + g.loc[known, "views_12m"]), 1)
        else:
            # not enough data for this type yet: use the pooled fit over all types
            allk = ents["views_12m"].notna() & ents["sitelinks"].notna()
            if "enwiki" in ents:
                allk &= ents["enwiki"].notna()
            if allk.sum() < 30:
                # Too few pageviews fetched to fit (pageviews deferred, see PLAN.md §11): use a
                # fixed monotone mapping. Generator checks only use within-type popularity rank.
                a, b = DEFAULT_FIT
                est[g.index] = (a + b * x).clip(lower=0)
                continue
            b, a = np.polyfit(
                np.log10(1 + ents.loc[allk, "sitelinks"].astype(float)),
                np.log10(1 + ents.loc[allk, "views_12m"]), 1,
            )
        est[g.index] = (a + b * x).clip(lower=0)
    return est


def main(refresh: bool = False, max_minutes: float = 0.0) -> None:
    start, end = period()
    cache_path = RAW / "pageviews" / f"{start[:6]}-{end[:6]}.jsonl"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if refresh and cache_path.exists():
        cache_path.unlink()
    cache: dict[str, int] = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            cache[rec["title"]] = rec["views"]

    ents = pd.concat(
        [pd.read_parquet(p) for p in sorted(OUT.glob("*_entities.parquet"))], ignore_index=True
    ).drop_duplicates("id")
    attrs = ents["attrs"].map(json.loads)
    ents["enwiki"] = attrs.map(lambda a: a.get("enwiki"))
    ents["sitelinks"] = attrs.map(lambda a: a.get("wikidata_sitelinks"))

    todo = [t for t in priority_order(ents) if t not in cache]
    log.info("pageviews %s-%s: %d cached, %d to fetch (budget %.0f min)",
             start, end, len(cache), len(todo), max_minutes)
    deadline = time.monotonic() + max_minutes * 60
    with open(cache_path, "a", encoding="utf-8") as f:
        for i, title in enumerate(todo):
            if time.monotonic() > deadline:
                log.info("time budget reached; %d titles left for the next run", len(todo) - i)
                break
            v = fetch_views(title, start, end)
            cache[title] = v
            f.write(json.dumps({"title": title, "views": v}, ensure_ascii=False) + "\n")
            f.flush()
            if (i + 1) % 200 == 0:
                log.info("pageviews: %d/%d", i + 1, len(todo))

    ents["views_12m"] = ents["enwiki"].map(lambda t: cache.get(t) if t else None).astype(float)
    ents.loc[ents["enwiki"].isna(), "views_12m"] = 0.0  # no article: genuinely no views
    # Real pageviews are used wherever fetched, once a type has enough of them to calibrate the
    # sitelinks fit (so fetched and estimated values share one scale). Below that, the whole type
    # uses the uncalibrated default estimate.
    fetched = ents["views_12m"].notna() & ents["enwiki"].notna()
    ready = fetched.groupby(ents["type"]).transform("sum") >= MIN_FETCHED_PER_TYPE
    ents.loc[~ready & ents["enwiki"].notna(), "views_12m"] = None
    est = estimate_from_sitelinks(ents)
    has_views = ents["views_12m"].notna()
    ents["popularity"] = np.where(has_views, np.log10(1 + ents["views_12m"].fillna(0)), est)
    ents["popularity_source"] = np.where(
        has_views & ents["enwiki"].notna(), "pageviews",
        np.where(has_views, "none", np.where(est.notna(), "sitelinks_estimate", "none")),
    )
    ents["popularity"] = ents["popularity"].fillna(0.0)
    ents.loc[~has_views & est.notna(), "views_12m"] = None
    ents[["id", "views_12m", "popularity", "popularity_source"]].to_parquet(
        OUT / "popularity.parquet", index=False
    )
    summary = ents.groupby(["type", "popularity_source"]).size().unstack(fill_value=0)
    log.info("popularity sources:\n%s", summary.to_string())


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="discard cached pageviews")
    # Pageview fetching is deferred (rate limits; PLAN.md §11), so the default is 0: compute
    # popularity from cached pageviews + sitelinks estimate only. Pass e.g. 240 to crawl.
    p.add_argument("--max-minutes", type=float, default=0.0)
    a = p.parse_args()
    main(a.refresh, a.max_minutes)
