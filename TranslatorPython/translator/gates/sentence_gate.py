"""Pre-translation gate: detect sentence boundaries (pySBD)."""

import re

import pysbd

# Cache segmenters per language to avoid repeated instantiation
_segmenters: dict[str, pysbd.Segmenter] = {}

# Languages supported by pySBD (rule-based, no model needed)
PYSBD_LANGUAGES: set[str] = {
    "en", "fr", "de", "es", "it", "pt", "nl", "pl",
    "ro", "cs", "da", "sv", "fi", "el", "hu", "bg",
    "hr", "sk", "sl", "et", "lv", "lt",
}

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
