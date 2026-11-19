from datetime import date

import pytest

from geo_pipeline.flags import classify
from geo_pipeline.ingest.countries import continent_of
from geo_pipeline.popularity import period


@pytest.mark.parametrize(
    ("hex_colour", "name"),
    [
        ("#e1000f", "red"),  # France red
        ("#000091", "blue"),  # France blue
        ("#ffffff", "white"),
        ("#000000", "black"),
        ("#009246", "green"),  # Italy
        ("#ffce00", "yellow"),  # Germany gold
        ("#f6b40e", "yellow"),  # Argentina sun
        ("#ff9933", "orange"),  # India saffron
        ("#74acdf", "blue"),  # Argentina light blue
        ("#8d1b3d", "maroon"),  # Qatar
    ],
)
def test_flag_colour_classification(hex_colour: str, name: str) -> None:
    r, g, b = (int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    assert classify(r, g, b) == name


def test_continent_splits_americas() -> None:
    assert continent_of("Americas", "South America") == "South America"
    assert continent_of("Americas", "Caribbean") == "North America"
    assert continent_of("Americas", "Central America") == "North America"
    assert continent_of("Europe", "Northern Europe") == "Europe"


def test_pageview_period_is_last_12_complete_months() -> None:
    assert period(date(2026, 11, 19)) == ("2025110100", "2026103100")
    assert period(date(2026, 1, 5)) == ("2025010100", "2025123100")
    assert period(date(2024, 3, 1)) == ("2023030100", "2024022900")  # leap year


def test_sitelinks_estimate_fills_only_missing_views() -> None:
    import numpy as np
    import pandas as pd

    from geo_pipeline.popularity import estimate_from_sitelinks

    rng = np.random.default_rng(0)
    sl = rng.integers(1, 300, 60).astype(float)
    views = 10 ** (1 + 1.5 * np.log10(1 + sl)) - 1  # exact power law
    df = pd.DataFrame({"type": "city", "sitelinks": sl, "views_12m": views})
    df.loc[:4, "views_12m"] = np.nan
    est = estimate_from_sitelinks(df)
    expected = 1 + 1.5 * np.log10(1 + sl[:5])
    assert np.allclose(est[:5], expected)
