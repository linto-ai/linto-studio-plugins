"""Pre-translation gate: detect sentence boundaries (pySBD)."""

import re

import pysbd
from pysbd.languages import LANGUAGE_CODES

# Cache segmenters per language to avoid repeated instantiation
_segmenters: dict[str, pysbd.Segmenter] = {}

# Languages actually supported by the installed pySBD, derived from pySBD
# itself. A hardcoded list here used to include codes pySBD doesn't know
# (pt, ro, cs, sv, fi, hu, hr, sl, et, lv, lt): Segmenter() then raised
# ValueError and the whole message was dropped by the MQTT handler — the ASR
# sometimes misdetects the language (e.g. pt-BR on French speech), so this
# must fall back to the regex path, never raise.
PYSBD_LANGUAGES: set[str] = set(LANGUAGE_CODES.keys())

# Compiled fallback regex for unsupported languages
_PUNCT_BOUNDARY_RE = re.compile(r"[.!?;]\s")


def get_segmenter(lang: str | None) -> pysbd.Segmenter | None:
    """Get a cached pySBD segmenter for the given language.

    Args:
        lang: BCP-47 or short language code (e.g. "fr-FR" or "fr"), or None.

    Returns:
        Segmenter instance or None if language unsupported by pySBD.
    """
    if not lang:
        return None
    short = lang.split("-")[0]
    if short not in PYSBD_LANGUAGES:
        return None
    if short not in _segmenters:
        _segmenters[short] = pysbd.Segmenter(language=short, clean=False)
    return _segmenters[short]


def count_complete_sentences(text: str, lang: str | None) -> int:
    """Count complete sentences in text.

    The last segment from pySBD is the current incomplete sentence,
    so complete sentences = total segments - 1.

    Args:
        text: Source text to analyze.
        lang: BCP-47 or short language code.

    Returns:
        Number of complete sentences.
    """
    segmenter = get_segmenter(lang)
    if segmenter:
        sentences = segmenter.segment(text)
        return max(0, len(sentences) - 1)
    # Fallback: punctuation regex for unsupported languages
    boundaries = _PUNCT_BOUNDARY_RE.findall(text)
    return len(boundaries)


def has_new_sentence(text: str, lang: str | None, prev_count: int) -> tuple[bool, int]:
    """Check if new complete sentences appeared since last check.

    Args:
        text: Source text to analyze.
        lang: BCP-47 or short language code.
        prev_count: Sentence count at last check.

    Returns:
        Tuple of (has_new_boundary, current_count).
    """
    current = count_complete_sentences(text, lang)
    return (current > prev_count, current)
