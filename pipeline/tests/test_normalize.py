import pytest

from geo_pipeline.normalize import basic_normalize, normalize


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Côte d'Ivoire", "cote divoire"),
        ("Côte d’Ivoire", "cote divoire"),
        ("  São   Tomé & Príncipe ", "sao tome and principe"),
        ("St. Petersburg", "saint petersburg"),
        ("St Lucia", "saint lucia"),
        ("The Gambia", "gambia"),
        ("Zürich", "zurich"),
        ("Kraków", "krakow"),
        ("Łódź", "lodz"),
        ("Reykjavík", "reykjavik"),
        ("Guinea-Bissau", "guinea bissau"),
        ("Malmö", "malmo"),
        ("Straße", "strasse"),
        ("Washington, D.C.", "washington d c"),
    ],
)
def test_basic_normalize(raw: str, expected: str) -> None:
    assert basic_normalize(raw) == expected


@pytest.mark.parametrize(
    ("raw", "etype", "expected"),
    [
        ("Heathrow Airport", "airport", "heathrow"),
        ("John F. Kennedy International Airport", "airport", "john f kennedy"),
        ("Mt Everest", "mountain", "everest"),
        ("Mount Kilimanjaro", "mountain", "kilimanjaro"),
        ("Yosemite NP", "national_park", "yosemite"),
        ("Yosemite National Park", "national_park", "yosemite"),
        ("the Amazon River", "river", "amazon"),
        ("Lake", "lake", "lake"),
        # type affixes are only stripped for that type
        ("Lake Placid", "city", "lake placid"),
        ("Salt Lake City", "city", "salt lake city"),
        ("Aéroport de Nice Côte d'Azur", "airport", "nice cote dazur"),
        ("Aeropuerto Internacional de El Dorado", "airport", "el dorado"),
        ("Lago di Garda", "lake", "garda"),
        ("De Kooy Airfield", "city", "de kooy airfield"),
    ],
)
def test_normalize_with_type(raw: str, etype: str, expected: str) -> None:
    assert normalize(raw, etype) == expected


def test_bare_affix() -> None:
    from geo_pipeline.normalize import is_bare_affix

    assert is_bare_affix(normalize("Aéroport", "airport"), "airport")
    assert not is_bare_affix(normalize("Heathrow", "airport"), "airport")
    assert not is_bare_affix("lake", "city")


def test_non_latin_scripts_keep_vowel_signs() -> None:
    # Hindi "Moldova" vs "Maldives" must not collapse to the same string
    assert basic_normalize("मोल्डोवा") != basic_normalize("मालदीव")
    assert basic_normalize("Ελλάδα") == "ελλαδα"
    assert basic_normalize("Россия") == "россия"
    assert basic_normalize("Йемен") == basic_normalize("Йемен")
