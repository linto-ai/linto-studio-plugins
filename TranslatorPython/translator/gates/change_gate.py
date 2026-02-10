"""Pre-translation gate: skip if source text barely changed (RapidFuzz)."""

from rapidfuzz import fuzz


def should_skip(
    last_source: str,
    new_source: str,
    threshold: float,
    min_chars: int,
) -> bool:
    """Return True if the partial should be skipped (not enough change).

    Skip when BOTH conditions are met:
    - similarity > threshold (too similar)
    - chars_added < min_chars (too few new characters)

    Args:
        last_source: Last source text that triggered a translation.
        new_source: Current source text from the partial.
        threshold: RapidFuzz similarity threshold (0-100).
        min_chars: Minimum new characters before considering translation.

    Returns:
        True if the partial should be skipped.
    """
    if not last_source:
        return False  # First partial always passes

    similarity = fuzz.ratio(last_source, new_source)
    chars_added = len(new_source) - len(last_source)

    return similarity > threshold and chars_added < min_chars
