"""Tests for the change gate (pre-translation source text similarity check)."""

from translator.gates.change_gate import should_skip


class TestChangeGate:
    """Test should_skip() decisions with known text pairs."""

    def test_first_partial_always_passes(self):
        """First partial (empty last_source) should never be skipped."""
        assert should_skip("", "Bonjour", threshold=85, min_chars=10) is False

    def test_identical_text_skipped(self):
        """Identical text should be skipped (similarity=100, chars_added=0)."""
        assert should_skip("Bonjour", "Bonjour", threshold=85, min_chars=10) is True

    def test_minor_addition_skipped(self):
        """Small addition to similar text should be skipped."""
        # "Bonjour" -> "Bonjour," : +1 char, very similar
        assert should_skip("Bonjour", "Bonjour,", threshold=85, min_chars=10) is True

    def test_significant_addition_passes(self):
        """Large addition should pass even if prefix is similar."""
        # "Bonjour" -> "Bonjour le monde entier" : +16 chars
        assert (
            should_skip("Bonjour", "Bonjour le monde entier", threshold=85, min_chars=10)
            is False
        )

    def test_dissimilar_text_passes(self):
        """Very different text should pass."""
        assert (
            should_skip(
                "Hello world", "Completely different text here", threshold=85, min_chars=10
            )
            is False
        )

    def test_threshold_boundary_high_similarity_few_chars(self):
        """Just above threshold with few chars added -> skip."""
        # "ça marche" -> "ça marche sur" : similarity ~82%, 4 chars added
        # Use threshold=80 to ensure skip (similarity ~82 > 80 AND 4 < 10)
        assert should_skip("ça marche", "ça marche sur", threshold=80, min_chars=10) is True

    def test_threshold_boundary_enough_chars(self):
        """Above threshold but enough chars added -> pass."""
        # Similarity high but chars_added >= min_chars
        assert (
            should_skip("ça marche", "ça marche sur une carte", threshold=85, min_chars=10)
            is False
        )

    def test_low_threshold_allows_more_skips(self):
        """Lower threshold means more aggressive skipping."""
        # With threshold=50, even moderately similar text is skipped
        assert should_skip("hello", "hello world", threshold=50, min_chars=15) is True

    def test_high_min_chars_allows_more_skips(self):
        """Higher min_chars means more content needed to pass."""
        assert should_skip("abc", "abcdefgh", threshold=50, min_chars=20) is True

    def test_both_conditions_must_be_met(self):
        """Skip only when BOTH similarity > threshold AND chars_added < min_chars."""
        # High similarity but enough chars -> should NOT skip
        assert (
            should_skip("test", "test with many more words added here", threshold=20, min_chars=10)
            is False
        )
