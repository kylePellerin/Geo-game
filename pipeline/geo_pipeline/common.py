"""Shared helpers: paths, cached HTTP downloads, Wikidata SPARQL/API access."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import requests

PIPELINE_DIR = Path(__file__).resolve().parents[1]
RAW = PIPELINE_DIR / "raw"
OUT = PIPELINE_DIR / "out"
DATA = PIPELINE_DIR / "data"  # hand-curated, committed inputs

# Wikimedia asks automated clients to identify themselves. Keep this generic (no personal data).
USER_AGENT = "GeoRarityPipeline/0.1 (geography quiz data pipeline; python-requests)"

log = logging.getLogger("geo_pipeline")

_session: requests.Session | None = None


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = USER_AGENT
    return _session


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def download(url: str, dest: Path, refresh: bool = False) -> Path:
    """Download url to dest unless dest already exists (idempotent)."""
    if dest.exists() and not refresh:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading %s", url)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with session().get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            f.writelines(r.iter_content(1 << 20))
    tmp.replace(dest)
    return dest


def _get_with_retry(
    url: str, params: dict[str, Any], tries: int = 6, method: str = "GET"
) -> requests.Response:
    delay = 5.0
    for attempt in range(tries):
        try:
            if method == "POST":
                r = session().post(url, data=params, timeout=180)
            else:
                r = session().get(url, params=params, timeout=180)
        except requests.RequestException as e:
            if attempt == tries - 1:
                raise
            log.warning("request error %s; retrying in %.0fs", e, delay)
        else:
            if r.status_code == 200:
                return r
            if r.status_code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                r.raise_for_status()
            retry_after = r.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                delay = max(delay, float(retry_after))
            log.warning("HTTP %s; retrying in %.0fs", r.status_code, delay)
        time.sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")


def sparql(
    query: str, cache_name: str, refresh: bool = False, lang_key: bool = False
) -> list[dict[str, str]]:
    """Run a Wikidata SPARQL query, caching the flattened bindings as JSON in raw/wikidata/."""
    digest = hashlib.sha1(query.encode()).hexdigest()[:10]
    path = RAW / "wikidata" / f"{cache_name}-{digest}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(4):
        r = _get_with_retry(
            "https://query.wikidata.org/sparql", {"query": query, "format": "json"}, method="POST"
        )
        try:
            # a query that times out mid-stream returns 200 with truncated JSON
            bindings = r.json()["results"]["bindings"]
            break
        except ValueError:
            if attempt == 3:
                raise
            log.warning("truncated SPARQL response for %s; retrying", cache_name)
            time.sleep(10 * (attempt + 1))
    rows = []
    for b in bindings:
        row = {k: v["value"] for k, v in b.items()}
        if lang_key:
            row.update({f"{k}_lang": v["xml:lang"] for k, v in b.items() if "xml:lang" in v})
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows), encoding="utf-8")
    time.sleep(0.5)  # be polite between uncached queries
    return rows


def qid(uri: str | None) -> str | None:
    if not uri:
        return None
    return uri.rsplit("/", 1)[-1]


def chunks(items: list[Any], n: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), n):
        yield items[i : i + n]


# Languages for aliases (PLAN §3: ~15 major languages).
ALIAS_LANGS = [
    "en", "fr", "de", "es", "it", "pt", "nl", "pl", "sv", "tr",
    "id", "vi", "ru", "zh", "ja", "ar", "hi", "ko",
]


def _parse_label_rows(rows: list[dict], out: dict[str, Any]) -> None:
    for r in rows:
        q, kind, text, lang = qid(r["item"]), r["kind"], r["text"], r.get("text_lang", "")
        e = out.setdefault(q, {"labels": {}, "aliases": {}, "enwiki": None})
        if kind == "label":
            e["labels"][lang] = text
        elif kind == "alias":
            if text not in e["aliases"].setdefault(lang, []):
                e["aliases"][lang].append(text)
        else:
            e["enwiki"] = text


def wikidata_entities(qids: Iterable[str], cache_name: str, refresh: bool = False) -> dict:
    """Labels, aliases (ALIAS_LANGS) and enwiki title for QIDs, via SPARQL in batches of 200.

    Cached per QID in raw/wikidata/labels-<cache_name>.json, so adding QIDs only fetches the new
    ones and an interrupted fetch resumes.
    Returns {qid: {"labels": {lang: str}, "aliases": {lang: [str]}, "enwiki": str | None}}.
    """
    store_path = RAW / "wikidata" / f"labels-{cache_name}.json"
    store: dict[str, Any] = {}
    if store_path.exists() and not refresh:
        store = json.loads(store_path.read_text(encoding="utf-8"))
    elif not refresh:
        # seed from older per-batch query caches, if any
        for old in sorted((RAW / "wikidata").glob(f"labels-{cache_name}-*.json")):
            rows = json.loads(old.read_text(encoding="utf-8"))
            _parse_label_rows(rows, store)
    wanted = sorted(set(qids), key=lambda q: int(q[1:]))
    todo = [q for q in wanted if q not in store]
    langs = ", ".join(f'"{lg}"' for lg in ALIAS_LANGS)
    batches = list(chunks(todo, 200))
    if batches:
        log.info("wikidata labels %s: %d cached, %d to fetch", cache_name, len(store), len(todo))
    for i, batch in enumerate(batches):
        if i % 10 == 0:
            log.info("wikidata labels %s: batch %d/%d", cache_name, i + 1, len(batches))
        values = " ".join(f"wd:{q}" for q in batch)
        query = f"""SELECT ?item ?kind ?text WHERE {{
  VALUES ?item {{ {values} }}
  {{ ?item rdfs:label ?text . BIND("label" AS ?kind) }}
  UNION {{ ?item skos:altLabel ?text . BIND("alias" AS ?kind) }}
  UNION {{ ?w schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ;
              schema:name ?text . BIND("enwiki" AS ?kind) }}
  FILTER(LANG(?text) IN ({langs}))
}}"""
        rows = sparql(query, f"labels-{cache_name}", refresh, lang_key=True)
        for q in batch:  # remember QIDs with no labels too, so they aren't refetched
            store.setdefault(q, {"labels": {}, "aliases": {}, "enwiki": None})
        _parse_label_rows(rows, store)
        store_path.parent.mkdir(parents=True, exist_ok=True)
        store_path.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    if not store_path.exists():
        store_path.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    return {q: store.get(q, {"labels": {}, "aliases": {}, "enwiki": None}) for q in wanted}
