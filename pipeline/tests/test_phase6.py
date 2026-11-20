"""Phase 6 helpers: country shapes, fact cards, derived landmark names."""

from geo_pipeline.facts import fact
from geo_pipeline.ingest.features import _to_unit, derived_names
from geo_pipeline.ingest.shapes import crosses, mainland, outline_path, ring_area


def _square(x0: float, y0: float, size: float) -> list[list[float]]:
    return [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]]


def test_crosses_lines_only_when_land_spans_them() -> None:
    assert crosses([_square(10, -2, 4)]) == ["equator"]
    assert crosses([_square(-1, 50, 3)]) == ["prime_meridian"]
    assert crosses([_square(10, 1, 4)]) == []
    # a ring straddling the antimeridian (lon -179..179) is not on the prime meridian
    assert "prime_meridian" not in crosses([[[179, 0], [-179, 0], [-179, 2], [179, 2]]])


def test_mainland_drops_far_flung_islands() -> None:
    main = _square(0, 40, 10)
    near_island = _square(12, 42, 1)
    overseas = _square(-60, 5, 2)  # French Guiana-style
    kept = mainland([main, near_island, overseas])
    assert main in kept and near_island in kept and overseas not in kept


def test_ring_area_and_outline() -> None:
    assert ring_area(_square(0, 0, 2)) > ring_area(_square(0, 0, 1))
    o = outline_path([_square(0, 0, 2)])
    assert o["d"].startswith("M") and o["d"].endswith("Z")
    assert max(o["w"], o["h"]) <= 200


def test_units() -> None:
    assert _to_unit(1, "Q828224", "elevation_m") == 1000
    assert _to_unit(1000, "Q3710", "elevation_m") == 304.8
    assert _to_unit(5, "Q712226", "area_km2") == 5
    assert _to_unit(5, "Q11573", "area_km2") is None  # metres aren't an area


def test_derived_names() -> None:
    assert derived_names("Yellowstone National Park", "national_park") == ["Yellowstone"]
    assert derived_names("Victoria Falls", "waterfall") == []
    assert derived_names("Mount Fuji (Japan)", "mountain") == ["Mount Fuji"]


def test_facts() -> None:
    names = {"Q1": "Tanzania"}
    assert fact("mountain", "Kilimanjaro", {"elevation_m": 5895, "volcano": True,
                                            "countries": ["Q1"]}, "Tanzania", names, {}) == \
        "Kilimanjaro is a volcano in Tanzania, 5,895 m high."
    assert fact("river", "Nile", {"length_km": 6650, "countries": []}, None, names, {}) is None
    assert fact("animal", "Lion", {}, None, names, {"lion": ["Kenya", "Belgium"]}) == \
        "The lion is a national animal of Belgium and Kenya."
    assert "UNESCO" in fact("landmark", "Petra", {"kind": "famous", "class": "archaeological site",
                                                  "unesco": True}, "Jordan", names, {})


# Questions stay broad (user feedback 2026-11-20: "volcano in Iceland" is too specific, "volcano
# in Asia" is better). Natural features and sights are asked per continent or worldwide; a single
# country only where that country is famous for them, and never a small country.
FEATURE_TYPES = {"mountain", "river", "lake", "island", "landmark"}
BROAD_COUNTRIES = {
    "United States", "Canada", "Australia", "China", "India", "Japan", "Indonesia", "Philippines",
    "Greece", "Italy", "Spain", "France", "United Kingdom", "Germany", "Egypt", "Mexico", "Kenya",
    "Tanzania", "South Africa",
}


def test_feature_questions_stay_broad():
    from geo_pipeline.questions import load_templates

    for t in load_templates():
        if t.entity_type not in FEATURE_TYPES:
            continue
        for name, values in t.params.items():
            for v in values:
                if "country" in name or "place" in name:
                    assert v["name"] in BROAD_COUNTRIES, f"{t.id}: {v['name']} is too specific"
