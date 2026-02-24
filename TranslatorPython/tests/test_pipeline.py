"""Tests for the anti-flicker pipeline orchestrator."""

import asyncio

import pytest

from translator.pipeline import Pipeline
from translator.providers.echo import EchoProvider


def _make_transcription(
    seg_id: int = 1,
    text: str = "Bonjour",
    lang: str = "fr-FR",
    translator: str = "test",
    target_lang: str = "en",
) -> dict:
    """Create a transcription packet for testing."""
    return {
        "segmentId": seg_id,
        "astart": "2026-01-01T00:00:00Z",
        "text": text,
        "start": 0,
        "end": 1.0,
        "lang": lang,
        "locutor": None,
        "translations": {},
        "externalTranslations": [
            {"targetLang": target_lang, "translator": translator}
        ],
    }


def _make_targets(translator: str = "test", target_lang: str = "en") -> list[dict]:
    return [{"targetLang": target_lang, "translator": translator}]


class TestPipelineFinal:
    """Test that finals bypass all gates."""

    @pytest.fixture
    def published(self):
        return []

    @pytest.fixture
    def pipeline(self, published):
        async def publish_fn(session_id, channel_id, action, payload, key):
            published.append(
                {"session_id": session_id, "channel_id": channel_id,
                 "action": action, "payload": payload, "key": key}
            )

        return Pipeline(
            provider=EchoProvider(),
            publish_fn=publish_fn,
            debounce_ms=100,
        )

    @pytest.mark.asyncio
    async def test_final_publishes_immediately(self, pipeline, published):
        """Final events should translate and publish immediately."""
        transcription = _make_transcription(text="Bonjour le monde")
        targets = _make_targets()
        await pipeline.handle_final("sess1", "0", transcription, targets)

        assert len(published) == 1
        assert published[0]["action"] == "final"
        assert published[0]["payload"]["text"] == "Bonjour le monde"  # echo
        assert published[0]["payload"]["sourceLang"] == "fr-FR"
        assert published[0]["payload"]["targetLang"] == "en"

    @pytest.mark.asyncio
    async def test_final_clears_state(self, pipeline, published):
        """Final should clear segment state."""
        key = "sess1/0/en"
        transcription = _make_transcription(text="Bonjour")
        targets = _make_targets()

        # Create some state via a partial
        await pipeline.handle_partial("sess1", "0", transcription, targets)
        assert key in pipeline._states

        # Now send final
        await pipeline.handle_final("sess1", "0", transcription, targets)
        assert key not in pipeline._states

    @pytest.mark.asyncio
    async def test_final_cancels_pending_debounce(self, pipeline, published):
        """Final should cancel any pending debounce timer."""
        transcription = _make_transcription(text="Bonjour")
        targets = _make_targets()

        # Start a partial (sets debounce timer)
        await pipeline.handle_partial("sess1", "0", transcription, targets)

        # Immediately send final (should cancel debounce)
        final_transcription = _make_transcription(text="Bonjour le monde.")
        await pipeline.handle_final("sess1", "0", final_transcription, targets)

        # Wait for any would-be debounce to fire
        await asyncio.sleep(0.2)

        # Only the final's publish should be recorded
        final_publishes = [p for p in published if p["action"] == "final"]
        assert len(final_publishes) == 1

    @pytest.mark.asyncio
    async def test_final_multiple_targets(self, pipeline, published):
        """Final with multiple targets should publish for each."""
        transcription = _make_transcription(text="Bonjour")
        transcription["externalTranslations"] = [
            {"targetLang": "en", "translator": "test"},
            {"targetLang": "de", "translator": "test"},
        ]
        targets = [
            {"targetLang": "en", "translator": "test"},
            {"targetLang": "de", "translator": "test"},
        ]
        await pipeline.handle_final("sess1", "0", transcription, targets)
        assert len(published) == 2


class TestPipelinePartial:
    """Test partial flow through the pipeline."""

    @pytest.fixture
    def published(self):
        return []

    @pytest.fixture
    def pipeline(self, published):
        async def publish_fn(session_id, channel_id, action, payload, key):
            published.append(
                {"session_id": session_id, "channel_id": channel_id,
                 "action": action, "payload": payload, "key": key}
            )

        return Pipeline(
            provider=EchoProvider(),
            publish_fn=publish_fn,
            debounce_ms=50,  # Short debounce for faster tests
            change_threshold=85,
            min_new_chars=10,
            stability_threshold=0.6,
            max_hold_seconds=1.0,
            max_consecutive_holds=3,
        )

    @pytest.mark.asyncio
    async def test_first_partial_publishes_after_debounce(self, pipeline, published):
        """First partial should pass change gate and publish after debounce."""
        transcription = _make_transcription(text="Bonjour le monde entier")
        targets = _make_targets()

        await pipeline.handle_partial("sess1", "0", transcription, targets)
        # Nothing published yet (debounce pending)
        assert len(published) == 0

        # Wait for debounce
        await asyncio.sleep(0.15)
        assert len(published) == 1
        assert published[0]["action"] == "partial"

    @pytest.mark.asyncio
    async def test_debounce_cancelled_by_new_partial(self, pipeline, published):
        """New partial should reset the debounce timer."""
        transcription1 = _make_transcription(text="Bonjour le monde entier")
        transcription2 = _make_transcription(
            text="Bonjour le monde entier et bienvenue"
        )
        targets = _make_targets()

        await pipeline.handle_partial("sess1", "0", transcription1, targets)
        await asyncio.sleep(0.02)  # Less than debounce
        await pipeline.handle_partial("sess1", "0", transcription2, targets)

        await asyncio.sleep(0.15)

        # Should have published the second text (first debounce was cancelled)
        assert len(published) >= 1
        last_text = published[-1]["payload"]["text"]
        assert "bienvenue" in last_text

    @pytest.mark.asyncio
    async def test_change_gate_skips_minor_addition(self, pipeline, published):
        """Change gate should skip when source barely changed."""
        transcription1 = _make_transcription(text="Bonjour le monde entier")
        targets = _make_targets()

        # First partial: should eventually publish
        await pipeline.handle_partial("sess1", "0", transcription1, targets)
        await asyncio.sleep(0.15)
        assert len(published) == 1

        # Minor addition (< 10 chars, similar)
        transcription2 = _make_transcription(text="Bonjour le monde entier,")
        await pipeline.handle_partial("sess1", "0", transcription2, targets)
        await asyncio.sleep(0.15)

        # Should still be 1 publish (minor change skipped)
        assert len(published) == 1

    @pytest.mark.asyncio
    async def test_sentence_boundary_triggers_immediate_translate(self, pipeline, published):
        """Sentence boundary should bypass debounce."""
        # First partial with no sentence boundary
        transcription1 = _make_transcription(text="Bonjour le monde entier")
        targets = _make_targets()
        await pipeline.handle_partial("sess1", "0", transcription1, targets)
        await asyncio.sleep(0.15)
        initial_count = len(published)

        # New partial with sentence boundary (period + space)
        transcription2 = _make_transcription(
            text="Bonjour le monde entier. Comment allez"
        )
        await pipeline.handle_partial("sess1", "0", transcription2, targets)

        # Should publish immediately (no debounce wait needed)
        # Give a tiny bit of time for the async path
        await asyncio.sleep(0.02)
        assert len(published) > initial_count

    @pytest.mark.asyncio
    async def test_pipeline_cleanup_on_stop(self, pipeline, published):
        """Pipeline stop should cancel all pending tasks."""
        transcription = _make_transcription(text="Bonjour le monde entier")
        targets = _make_targets()

        await pipeline.handle_partial("sess1", "0", transcription, targets)
        # Debounce task is pending
        state = pipeline._states.get("sess1/0/en")
        assert state is not None
        debounce_task = state.debounce_task
        assert debounce_task is not None

        await pipeline.stop()
        # Allow event loop tick for cancellation to complete
        await asyncio.sleep(0)
        # After stop, tasks should be cancelled or done
        assert debounce_task.done()


class TestPipelineStabilityHold:
    """Test stability gate hold/force-publish behavior.

    Uses a mock provider that returns controllable translations.
    """

    @pytest.fixture
    def published(self):
        return []

    @pytest.fixture
    def translations(self):
        """Queue of translations to return."""
        return []

    @pytest.fixture
    def pipeline(self, published, translations):
        class MockProvider:
            async def translate(self, text, source_lang, target_lang):
                if translations:
                    return translations.pop(0)
                return text

        async def publish_fn(session_id, channel_id, action, payload, key):
            published.append(
                {"session_id": session_id, "channel_id": channel_id,
                 "action": action, "payload": payload, "key": key}
            )

        return Pipeline(
            provider=MockProvider(),
            publish_fn=publish_fn,
            debounce_ms=10,
            stability_threshold=0.6,
            max_hold_seconds=0.3,
            max_consecutive_holds=3,
        )

    @pytest.mark.asyncio
    async def test_hold_on_prefix_break(self, pipeline, published, translations):
        """Unstable prefix should trigger hold."""
        targets = _make_targets()

        # First partial: "it walks on a" -> publishes (first display)
        translations.append("it walks on a")
        t1 = _make_transcription(text="ça marche sur une")
        await pipeline.handle_partial("sess1", "0", t1, targets)
        await asyncio.sleep(0.05)
        assert len(published) == 1
        assert published[0]["payload"]["text"] == "it walks on a"

        # Second partial: "it works on an RTX card" -> prefix break -> HOLD
        translations.append("it works on an RTX card")
        t2 = _make_transcription(text="ça marche sur une carte RTX tout neuf")
        await pipeline.handle_partial("sess1", "0", t2, targets)
        await asyncio.sleep(0.05)

        # Should still be 1 publish (second was held)
        assert len(published) == 1

    @pytest.mark.asyncio
    async def test_max_hold_timer_force_publishes(self, pipeline, published, translations):
        """After max_hold_seconds, held translation should be force-published."""
        targets = _make_targets()

        # First publish
        translations.append("it walks on a")
        t1 = _make_transcription(text="ça marche sur une")
        await pipeline.handle_partial("sess1", "0", t1, targets)
        await asyncio.sleep(0.05)
        assert len(published) == 1

        # Hold (prefix break)
        translations.append("it works on an RTX card")
        t2 = _make_transcription(text="ça marche sur une carte RTX tout neuf")
        await pipeline.handle_partial("sess1", "0", t2, targets)
        await asyncio.sleep(0.05)
        assert len(published) == 1

        # Wait for max_hold_seconds to expire (0.3s)
        await asyncio.sleep(0.4)
        assert len(published) == 2
        assert published[1]["payload"]["text"] == "it works on an RTX card"

    @pytest.mark.asyncio
    async def test_max_consecutive_holds_force_publishes(
        self, pipeline, published, translations
    ):
        """After max_consecutive_holds, should force-publish."""
        targets = _make_targets()

        # First publish (establishes 4-word baseline)
        translations.append("the quick brown fox")
        t1 = _make_transcription(text="premier texte source assez long")
        await pipeline.handle_partial("sess1", "0", t1, targets)
        await asyncio.sleep(0.05)
        assert len(published) == 1

        # Now send 3 partials that all break prefix (each with enough change)
        # consecutive_holds will hit max_consecutive_holds=3 on the 3rd
        base_texts = [
            "deuxieme texte completement different ici",
            "troisieme version du texte toujours differente",
            "quatrieme iteration encore une fois differente",
        ]
        for i, base in enumerate(base_texts):
            translations.append(f"x y z w v{i}")  # Always breaks "the quick brown fox" prefix
            t = _make_transcription(text=base)
            await pipeline.handle_partial("sess1", "0", t, targets)
            await asyncio.sleep(0.05)

        # The 3rd hold should trigger force-publish
        assert len(published) == 2  # Initial + force on 3rd hold
