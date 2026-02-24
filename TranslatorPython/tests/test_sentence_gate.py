"""Tests for the sentence gate (pySBD sentence boundary detection)."""

from translator.gates.sentence_gate import (
    PYSBD_LANGUAGES,
    count_complete_sentences,
    get_segmenter,
    has_new_sentence,
)


class TestGetSegmenter:
    """Test segmenter caching and language support."""

    def test_supported_language_returns_segmenter(self):
        seg = get_segmenter("fr")
        assert seg is not None

    def test_bcp47_code_extracts_short(self):
        seg = get_segmenter("fr-FR")
        assert seg is not None

    def test_unsupported_language_returns_none(self):
        assert get_segmenter("mt") is None  # Maltese not in pySBD
        assert get_segmenter("ga") is None  # Irish not in pySBD

    def test_caching(self):
        seg1 = get_segmenter("en")
        seg2 = get_segmenter("en")
        assert seg1 is seg2


class TestCountCompleteSentences:
    """Test sentence counting across languages."""

    def test_french_single_complete_sentence(self):
        # pySBD needs text after the period to split into 2 segments
        # "Bonjour le monde. " alone is 1 segment; adding trailing text triggers split
        text = "Bonjour le monde. Comment"
        assert count_complete_sentences(text, "fr") >= 1

    def test_french_no_complete_sentence(self):
        text = "Bonjour le monde"
        assert count_complete_sentences(text, "fr") == 0

    def test_english_two_sentences(self):
        text = "Hello world. How are you? I am fine"
        count = count_complete_sentences(text, "en")
        assert count >= 2

    def test_english_incomplete(self):
        text = "Hello world"
        assert count_complete_sentences(text, "en") == 0

    def test_german_sentence_boundary(self):
        text = "Hallo Welt. Wie geht es"
        assert count_complete_sentences(text, "de") >= 1

    def test_spanish_sentence_boundary(self):
        text = "Hola mundo. Como estas"
        assert count_complete_sentences(text, "es") >= 1

    def test_unsupported_language_punctuation_fallback(self):
        """Unsupported language uses regex fallback."""
        text = "Kif inti. Tajjeb? Sewwa"
        # Maltese (mt) not in pySBD, falls back to punctuation regex
        count = count_complete_sentences(text, "mt")
        assert count >= 1  # At least "Kif inti. " triggers the regex

    def test_empty_text(self):
        assert count_complete_sentences("", "en") == 0


class TestHasNewSentence:
    """Test incremental sentence boundary detection."""

    def test_no_new_boundary(self):
        has_new, count = has_new_sentence("Hello world", "en", 0)
        assert has_new is False
        assert count == 0

    def test_new_boundary_detected(self):
        has_new, count = has_new_sentence("Hello world. How are you", "en", 0)
        assert has_new is True
        assert count >= 1

    def test_same_count_no_new(self):
        """If sentence count hasn't changed, no new boundary."""
        has_new, count = has_new_sentence("Hello world. How are you", "en", 1)
        assert has_new is False

    def test_incremental_detection(self):
        """Simulate incremental text growth."""
        # Step 1: no boundary
        _, count1 = has_new_sentence("Bonjour", "fr", 0)
        assert count1 == 0

        # Step 2: still no boundary
        _, count2 = has_new_sentence("Bonjour le monde", "fr", count1)
        assert count2 == 0

        # Step 3: boundary detected
        has_new, count3 = has_new_sentence("Bonjour le monde. Comment", "fr", count2)
        assert has_new is True
        assert count3 >= 1
