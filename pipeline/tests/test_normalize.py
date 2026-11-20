from pathlib import Path

import pytest
import yaml

from geo_pipeline.normalize import is_bare_affix, normalize

CASES = yaml.safe_load((Path(__file__).parent / "normalize_cases.yaml").read_text("utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["in"] for c in CASES])
def test_golden_normalisation(case: dict) -> None:
    assert normalize(case["in"], case.get("type")) == case["out"]


def test_non_latin_scripts_keep_vowel_signs() -> None:
    # Hindi "Moldova" vs "Maldives" must not collapse to the same string
    assert normalize("मोल्डोवा") != normalize("मालदीव")


def test_bare_affix() -> None:
    assert is_bare_affix(normalize("Aéroport", "airport"), "airport")
    assert not is_bare_affix(normalize("Heathrow", "airport"), "airport")
    assert not is_bare_affix("lake", "city")
