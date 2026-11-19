"""Text normalisation shared by alias loading and (later) the matcher. See PLAN §5 step 1.

The same function must be applied to aliases at load time and to player input at match time.
"""

from __future__ import annotations

import re
import unicodedata

# Characters that NFKD does not decompose into base + combining mark.
_TRANSLIT = str.maketrans(
    {
        "ß": "ss", "æ": "ae", "Æ": "ae", "ø": "o", "Ø": "o", "œ": "oe", "Œ": "oe",
        "đ": "d", "Đ": "d", "ð": "d", "þ": "th", "ł": "l", "Ł": "l", "ı": "i",
        "’": "'", "‘": "'", "`": "'", "´": "'", "–": "-", "—": "-",
    }
)

# Type-specific suffixes/prefixes dropped from both aliases and input. Longest first.
TYPE_AFFIXES: dict[str, list[str]] = {
    "airport": [
        "international airport", "intl airport", "regional airport", "airport",
        "international", "internacional", "intl", "aeropuerto", "aeroporto", "aeroport",
        "flughafen", "aerodrome",
    ],
    "national_park": ["national park", "np", "park"],
    "river": ["river", "rio", "riviere"],
    "lake": ["lake", "lago", "lac"],
    "mountain": ["mountain", "mount", "mt", "monte", "mont"],
    "forest": ["national forest", "forest"],
    "island": ["islands", "island", "isla", "isle"],
    "volcano": ["volcano", "volcan", "mount", "mt"],
}

_LEADING_PREPOSITIONS = ["de la", "del", "de", "d", "di", "da", "do", "du", "of"]
_AFFIX_WORDS = {
    t: {w for a in affixes for w in [a, *a.split()]} for t, affixes in TYPE_AFFIXES.items()
}

_ABBREV = [
    (re.compile(r"\bst\b\.?"), "saint"),
    (re.compile(r"\bste\b\.?"), "sainte"),
    (re.compile(r"\bft\b\.?"), "fort"),
]


def _is_mark(c: str) -> bool:
    return unicodedata.category(c).startswith("M")


def basic_normalize(text: str) -> str:
    """Type-agnostic normalisation: accents, case, punctuation, whitespace, abbreviations."""
    s = text.translate(_TRANSLIT)
    s = unicodedata.normalize("NFKD", s)
    # Strip accents only from Latin/Greek/Cyrillic letters. In Indic and other scripts the
    # combining marks are vowels, and removing them merges distinct names.
    out, prev_alphabetic = [], False
    for c in s:
        if _is_mark(c):
            if prev_alphabetic:
                continue
        else:
            prev_alphabetic = ord(c) < 0x0530
        out.append(c)
    s = unicodedata.normalize("NFC", "".join(out))
    s = s.lower().translate(_TRANSLIT)
    s = s.replace("&", " and ")
    # apostrophes vanish (Côte d'Ivoire -> cote divoire); other punctuation becomes space
    s = s.replace("'", "")
    for pattern, repl in _ABBREV:
        s = pattern.sub(repl, s)
    # punctuation -> space; keep letters, digits and (non-Latin) combining vowel signs
    s = "".join(
        c if (c.isalnum() or c.isspace() or _is_mark(c)) and c != "_" else " "
        for c in s
    )
    s = re.sub(r"\s+", " ", s).strip()
    s = s.removeprefix("the ")
    return s


def normalize(text: str, entity_type: str | None = None) -> str:
    """Full normalisation, including dropping type affixes for entity_type.

    Never reduces a string to empty: "Lake" stays "lake".
    """
    s = basic_normalize(text)
    affixes = TYPE_AFFIXES.get(entity_type or "", [])
    changed = True
    while changed and affixes:
        changed = False
        for a in affixes:
            if s.endswith(" " + a):
                s, changed = s[: -len(a) - 1].strip(), True
            elif s.startswith(a + " "):
                s, changed = s[len(a) + 1 :].strip(), True
                # "Aéroport de Nice", "Lago di Garda", "Mount of Olives" -> drop the preposition
                for prep in _LEADING_PREPOSITIONS:
                    if s.startswith(prep + " ") and len(s) > len(prep) + 1:
                        s = s[len(prep) + 1 :]
                        break
            s = s.removeprefix("the ")
    return s


def is_bare_affix(norm: str, entity_type: str | None) -> bool:
    """True if a normalised alias is nothing but a type word ("aeroport", "lake")."""
    return norm in _AFFIX_WORDS.get(entity_type or "", set())
