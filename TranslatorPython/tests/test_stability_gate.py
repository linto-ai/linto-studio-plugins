"""Tests for the stability gate (post-translation prefix stability check)."""

from translator.gates.stability_gate import check_stability


class TestStabilityGate:
    """Test prefix stability calculation and hold/publish decisions."""

    def test_first_display_always_passes(self):
        """Nothing displayed yet -> always publish."""
        is_stable, ratio = check_stability("", "Hello world", threshold=0.6)
        assert is_stable is True
        assert ratio == 1.0

    def test_pure_append_passes(self):
        """New words appended at end -> prefix preserved -> publish."""
        is_stable, ratio = check_stability(
            "it walks on", "it walks on a map", threshold=0.6
        )
        assert is_stable is True
        assert ratio == 1.0

    def test_prefix_break_triggers_hold(self):
        """Prefix word changed -> stability below threshold -> hold."""
        is_stable, ratio = check_stability(
            "it walks on", "it works on a", threshold=0.6
        )
        assert is_stable is False
        # "it" matches, "walks" != "works" -> common=1, ratio=1/3=0.33
        assert abs(ratio - 1 / 3) < 0.01

    def test_short_text_always_passes(self):
        """1-2 word displayed text always allows update."""
        is_stable, ratio = check_stability("it", "it works", threshold=0.6)
        assert is_stable is True
        assert ratio == 1.0

    def test_two_words_always_passes(self):
        """Exactly 2 words displayed -> always passes."""
        is_stable, ratio = check_stability("it walks", "it works on", threshold=0.6)
        assert is_stable is True

    def test_high_stability_passes(self):
        """Most prefix preserved -> publish."""
        # "the quick brown fox" -> "the quick brown cat jumped"
        # common prefix = 3 words ("the quick brown"), ratio = 3/4 = 0.75
        is_stable, ratio = check_stability(
            "the quick brown fox",
            "the quick brown cat jumped",
            threshold=0.6,
        )
        assert is_stable is True
        assert abs(ratio - 0.75) < 0.01

    def test_low_stability_holds(self):
        """Significant prefix disruption -> hold."""
        # "a b c d e" -> "x y c d e f" : common=0, ratio=0/5=0.0
        is_stable, ratio = check_stability(
            "a b c d e", "x y c d e f", threshold=0.6
        )
        assert is_stable is False
        assert ratio == 0.0

    def test_exact_threshold_boundary_passes(self):
        """Stability exactly at threshold should pass."""
        # 3 words match out of 5 -> ratio=0.6
        is_stable, ratio = check_stability(
            "a b c d e", "a b c x y z", threshold=0.6
        )
        assert is_stable is True
        assert abs(ratio - 0.6) < 0.01

    def test_just_below_threshold_holds(self):
        """Stability just below threshold should hold."""
        # 2 words match out of 5 -> ratio=0.4
        is_stable, ratio = check_stability(
            "a b c d e", "a b x y z", threshold=0.6
        )
        assert is_stable is False
        assert abs(ratio - 0.4) < 0.01

    def test_completely_different_text(self):
        """Completely different translation -> hold."""
        is_stable, ratio = check_stability(
            "hello world everyone", "bonjour le monde", threshold=0.6
        )
        assert is_stable is False
        assert ratio == 0.0

    def test_new_translation_shorter(self):
        """New translation shorter than last -> still check prefix."""
        # "it walks on the road" -> "it walks" : common=2, ratio=2/5=0.4
        is_stable, ratio = check_stability(
            "it walks on the road", "it walks", threshold=0.6
        )
        assert is_stable is False
        assert abs(ratio - 0.4) < 0.01
