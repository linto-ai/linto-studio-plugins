"""Tests for the prefix-freezing Pipeline."""

import asyncio

import pytest

from translator.pipeline import Pipeline
from translator.providers.base import TranslationProvider


class FakeProvider(TranslationProvider):
    def __init__(self, latency: float = 0.0) -> None:
        self.latency = latency
        self.calls: list[str] = []

    async def translate(self, text, source_lang, target_lang):
        self.calls.append(text)
        if self.latency:
            await asyncio.sleep(self.latency)
        return f"T({text})"


class PublishLog:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def publish(self, session_id, channel_id, action, payload, key):
        self.events.append((action, payload))


def trans(text, seg=1, lang="fr-FR"):
    return {
        "segmentId": seg,
        "astart": "2026-01-01T00:00:00Z",
        "text": text,
        "start": 0,
        "end": 1.0,
        "lang": lang,
        "locutor": None,
    }


TARGETS = [{"targetLang": "en", "translator": "test"}]


def make_pipeline(provider, publog, **kw):
    return Pipeline(provider=provider, publish_fn=publog.publish, **kw)


async def drain(pipeline, delay=0.05):
    await asyncio.sleep(delay)


class TestPunctuationDriven:
    async def test_no_punctuation_no_translation(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Bonjour tout le"), TARGETS)
        await p.handle_partial("s", "c", trans("Bonjour tout le monde sans ponctuation"), TARGETS)
        await drain(p)
        assert prov.calls == []
        assert log.events == []

    async def test_sentence_close_translates_once(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Bonjour tout le monde."), TARGETS)
        await drain(p)
        assert prov.calls == ["Bonjour tout le monde."]
        assert log.events[-1][0] == "partial"
        assert log.events[-1][1]["text"] == "T(Bonjour tout le monde.)"

    async def test_frozen_sentence_never_retranslated(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Première phrase."), TARGETS)
        await drain(p)
        for growth in ["Première phrase. Suite", "Première phrase. Suite du texte",
                       "Première phrase. Suite du texte sans fin"]:
            await p.handle_partial("s", "c", trans(growth), TARGETS)
        await drain(p)
        assert prov.calls == ["Première phrase."]  # ONE call total

    async def test_second_sentence_appends(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Un."), TARGETS)
        await drain(p)
        await p.handle_partial("s", "c", trans("Un. Deux."), TARGETS)
        await drain(p)
        assert prov.calls == ["Un.", "Deux."]
        assert log.events[-1][1]["text"] == "T(Un.) T(Deux.)"

    async def test_published_prefix_is_monotone(self):
        prov, log = FakeProvider(latency=0.01), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Un. Deux. Trois."), TARGETS)
        await drain(p, 0.2)
        texts = [e[1]["text"] for e in log.events]
        assert texts, "expected publications"
        for prev, cur in zip(texts, texts[1:]):
            assert cur.startswith(prev)


class TestEcoMode:
    async def test_translate_partials_false_only_finals(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log, translate_partials=False)
        await p.handle_partial("s", "c", trans("Une phrase complète."), TARGETS)
        await drain(p)
        assert prov.calls == []
        await p.handle_final("s", "c", trans("Une phrase complète."), TARGETS)
        await drain(p)
        assert prov.calls == ["Une phrase complète."]
        assert log.events[-1][0] == "final"


class TestTailLive:
    async def test_tail_translated_in_live_mode(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log, tail_live_ms=1, min_new_chars=5)
        await p.handle_partial("s", "c", trans("Bonjour tout le monde"), TARGETS)
        await drain(p)
        assert prov.calls == ["Bonjour tout le monde"]
        assert log.events[-1][1]["text"] == "T(Bonjour tout le monde)"

    async def test_tail_change_gate_reference_at_submission(self):
        # Reference must move at SUBMISSION (D3 fix): resubmitting a barely
        # different text while a translation is in flight must be gated out.
        prov, log = FakeProvider(latency=0.05), PublishLog()
        p = make_pipeline(prov, log, tail_live_ms=1, min_new_chars=10)
        await p.handle_partial("s", "c", trans("Bonjour tout le monde"), TARGETS)
        await p.handle_partial("s", "c", trans("Bonjour tout le mondes"), TARGETS)
        await drain(p, 0.2)
        assert prov.calls == ["Bonjour tout le monde"]


class TestFinals:
    async def test_final_reuses_frozen_and_tail(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log, tail_live_ms=1, min_new_chars=1)
        await p.handle_partial("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        calls_before = len(prov.calls)  # frozen "Une phrase." + tail "Et la suite"
        await p.handle_final("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        assert len(prov.calls) == calls_before  # P7: ZERO new request
        assert log.events[-1][0] == "final"
        assert log.events[-1][1]["text"] == "T(Une phrase.) T(Et la suite)"

    async def test_final_translates_only_remainder(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)  # tail live OFF
        await p.handle_partial("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        assert prov.calls == ["Une phrase."]
        await p.handle_final("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        assert prov.calls == ["Une phrase.", "Et la suite"]
        assert log.events[-1][1]["text"] == "T(Une phrase.) T(Et la suite)"

    async def test_final_reuse_despite_leading_space(self):
        # Real-world shape: Voxtral partials carry a leading space, finals don't.
        # The frozen-prefix reuse must survive whitespace differences.
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans(" Une phrase. Et la suite"), TARGETS)
        await drain(p)
        assert prov.calls == ["Une phrase."]
        await p.handle_final("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        assert prov.calls == ["Une phrase.", "Et la suite"]  # remainder only
        assert log.events[-1][1]["text"] == "T(Une phrase.) T(Et la suite)"

    async def test_final_rewritten_full_retranslation(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Une phrase. Et la suite"), TARGETS)
        await drain(p)
        rewritten = "Une phrase, et la suite."  # final rewrote frozen text
        await p.handle_final("s", "c", trans(rewritten), TARGETS)
        await drain(p)
        assert prov.calls[-1] == rewritten  # one full retranslation
        assert log.events[-1][1]["text"] == f"T({rewritten})"

    async def test_final_does_not_block_caller(self):
        # D12 fix: handle_final must return immediately even with a slow provider
        prov, log = FakeProvider(latency=0.5), PublishLog()
        p = make_pipeline(prov, log)
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        await p.handle_final("s", "c", trans("Une phrase complète."), TARGETS)
        assert loop.time() - t0 < 0.1
        await drain(p, 0.7)
        assert log.events[-1][0] == "final"

    async def test_final_publishes_all_targets(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        targets = [
            {"targetLang": "en", "translator": "t"},
            {"targetLang": "de", "translator": "t"},
        ]
        await p.handle_final("s", "c", trans("Phrase."), targets)
        await drain(p)
        finals = [e for e in log.events if e[0] == "final"]
        assert {e[1]["targetLang"] for e in finals} == {"en", "de"}


class TestSegmentLifecycle:
    async def test_new_segment_resets_state(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Phrase un.", seg=1), TARGETS)
        await drain(p)
        await p.handle_partial("s", "c", trans("Phrase deux.", seg=2), TARGETS)
        await drain(p)
        assert prov.calls == ["Phrase un.", "Phrase deux."]
        # segment 2 publication must NOT contain segment 1 text
        assert log.events[-1][1]["text"] == "T(Phrase deux.)"
        assert log.events[-1][1]["segmentId"] == 2

    async def test_asr_rewrite_resets_and_refreezes(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Bonjour monde."), TARGETS)
        await drain(p)
        await p.handle_partial("s", "c", trans("Bonsoir monde."), TARGETS)  # rewrite
        await drain(p)
        assert prov.calls == ["Bonjour monde.", "Bonsoir monde."]
        assert log.events[-1][1]["text"] == "T(Bonsoir monde.)"


class TestRobustness:
    async def test_unsupported_lang_does_not_crash(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Ola tudo bem.", lang="pt-BR"), TARGETS)
        await drain(p)
        assert prov.calls == ["Ola tudo bem."]  # regex fallback froze it

    async def test_provider_error_on_freeze_does_not_crash(self):
        class Failing(FakeProvider):
            async def translate(self, text, source_lang, target_lang):
                raise RuntimeError("down")

        prov, log = Failing(), PublishLog()
        p = make_pipeline(prov, log)
        await p.handle_partial("s", "c", trans("Une phrase."), TARGETS)
        await drain(p)
        assert log.events == []  # nothing published, no exception escaped

    async def test_stats_logger_idempotent(self):
        prov, log = FakeProvider(), PublishLog()
        p = make_pipeline(prov, log)
        await p.start_stats_logger()
        first = p._stats_task
        await p.start_stats_logger()  # reconnection: must cancel previous (D10)
        await asyncio.sleep(0)
        assert first.cancelled() or first.done()
        await p.stop()
