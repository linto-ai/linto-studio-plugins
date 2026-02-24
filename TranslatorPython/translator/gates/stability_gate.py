"""Post-translation gate: reject if prefix flickers (word-level stability check)."""


def check_stability(
    last_published: str,
    new_translation: str,
    threshold: float,
) -> tuple[bool, float]:
    """Check if the new translation preserves the displayed prefix.

    Compares word-level prefix of the new translation against what is
    currently displayed. Returns whether the prefix is stable enough
    to publish.

    Args:
        last_published: Text currently displayed on screen for this segment.
        new_translation: New translation result to evaluate.
        threshold: Minimum fraction of displayed prefix words that must
            be preserved (0.0-1.0).

    Returns:
        Tuple of (is_stable, stability_ratio).
        is_stable=True means OK to publish.
    """
    if not last_published:
        return (True, 1.0)  # First display always passes

    last_words = last_published.split()
    new_words = new_translation.split()

    if len(last_words) <= 2:
        return (True, 1.0)  # Short text always updatable

    # Find common prefix length
    common = 0
    for i in range(min(len(last_words), len(new_words))):
        if last_words[i] == new_words[i]:
            common += 1
        else:
            break

    stability = common / len(last_words) if last_words else 1.0
    return (stability >= threshold, stability)
