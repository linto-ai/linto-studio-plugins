"""Tests for the SegmentAssembler (prefix freezing)."""

import pytest

from translator.assembler import SegmentAssembler


def grow(asm, text, lang="fr-FR", step_words=1):
    """Feed the text word by word (cumulative), return all results."""
    words = text.split(" ")
    results = []
    for i in range(1, len(words) + 1, step_words):
        results.append(asm.update(" ".join(words[:i]), lang))
    if (len(words)) % step_words:
        results.append(asm.update(text, lang))
    return results


class TestFreezeOnPunctuation:
    def test_no_punctuation_no_freeze(self):
        asm = SegmentAssembler()
        r = asm.update("Bonjour tout le monde", "fr-FR")
        assert r.newly_frozen == []
        assert r.tail == "Bonjour tout le monde"

    def test_sentence_end_freezes_immediately(self):
        asm = SegmentAssembler()
        r = asm.update("Bonjour tout le monde.", "fr-FR")
        assert [s for _, s in r.newly_frozen] == ["Bonjour tout le monde."]
        assert r.tail == ""

    def test_two_sentences_incremental(self):
        asm = SegmentAssembler()
        asm.update("Bonjour tout le monde.", "fr-FR")
        r = asm.update("Bonjour tout le monde. Il fait", "fr-FR")
        assert r.newly_frozen == []  # first sentence already frozen
        assert r.tail == "Il fait"
        r = asm.update("Bonjour tout le monde. Il fait beau aujourd'hui.", "fr-FR")
        assert [s for _, s in r.newly_frozen] == ["Il fait beau aujourd'hui."]
        assert r.tail == ""

    def test_frozen_never_regresses(self):
        asm = SegmentAssembler()
        text = "Première phrase. Deuxième phrase. Troisième phrase en cours"
        for r in grow(asm, text):
            pass
        assert asm.frozen_src == ["Première phrase.", "Deuxième phrase."]
        assert asm.update(text, "fr-FR").newly_frozen == []  # idempotent

    def test_indices_are_global_and_increasing(self):
        asm = SegmentAssembler()
        r1 = asm.update("Un. Deux.", "fr-FR")
        r2 = asm.update("Un. Deux. Trois.", "fr-FR")
        indices = [i for i, _ in r1.newly_frozen] + [i for i, _ in r2.newly_frozen]
        assert indices == [0, 1, 2]

    def test_trailing_digit_period_not_frozen(self):
        asm = SegmentAssembler()
        r = asm.update("Le prix est de 3.", "fr-FR")
        # "3." may be the start of "3.5" — must stay in the tail
        assert r.newly_frozen == []
        assert r.tail == "Le prix est de 3."

    def test_exclamation_and_question(self):
        asm = SegmentAssembler()
        r = asm.update("Vraiment ! Tu es sûr ?", "fr-FR")
        assert [s for _, s in r.newly_frozen] == ["Vraiment !", "Tu es sûr ?"]


class TestSoftChunking:
    def test_long_unpunctuated_tail_is_chunked(self):
        asm = SegmentAssembler(soft_chunk_chars=50)
        words = "mot" + " mot" * 40  # ~160 chars, no punctuation
        r = asm.update(words, "fr-FR")
        assert r.newly_frozen, "long unpunctuated text must be soft-chunked"
        assert len(r.tail) <= 50
        # chunks + tail reconstruct the text (modulo separating spaces)
        rebuilt = " ".join([s for _, s in r.newly_frozen] + [r.tail])
        assert rebuilt.split() == words.split()

    def test_chunk_prefers_comma(self):
        asm = SegmentAssembler(soft_chunk_chars=40)
        text = "un deux trois quatre cinq, six sept huit neuf dix onze douze"
        r = asm.update(text, "fr-FR")
        assert r.newly_frozen
        assert r.newly_frozen[0][1].endswith("cinq,")

    def test_933_char_segment_bounded(self):
        # Real-world shape: long continuous speech, zero punctuation
        asm = SegmentAssembler(soft_chunk_chars=220)
        words = ("le petit chat regarde la grande maison " * 24).strip()[:933]
        r = asm.update(words, "fr-FR")
        for _, chunk in r.newly_frozen:
            assert len(chunk) <= 220
        assert len(r.tail) <= 220


class TestReset:
    def test_rewritten_prefix_resets(self):
        asm = SegmentAssembler()
        asm.update("Bonjour tout le monde.", "fr-FR")
        assert asm.frozen_src
        r = asm.update("Bonsoir tout le monde.", "fr-FR")  # ASR rewrote the past
        assert r.reset is True
        assert asm.resets == 1
        assert [s for _, s in r.newly_frozen] == ["Bonsoir tout le monde."]

    def test_pure_growth_is_not_reset(self):
        asm = SegmentAssembler()
        asm.update("Bonjour.", "fr-FR")
        r = asm.update("Bonjour. Comment ça va", "fr-FR")
        assert r.reset is False


class TestLangRobustness:
    def test_unsupported_pysbd_lang_does_not_raise(self):
        # pt is NOT supported by pySBD; Voxtral misdetects pt-BR on French speech
        asm = SegmentAssembler()
        r = asm.update("Ola tudo bem. Segunda frase", "pt-BR")
        assert [s for _, s in r.newly_frozen] == ["Ola tudo bem."]
        assert r.tail == "Segunda frase"

    def test_none_lang_falls_back(self):
        asm = SegmentAssembler()
        r = asm.update("Hello there. How are", None)
        assert [s for _, s in r.newly_frozen] == ["Hello there."]
