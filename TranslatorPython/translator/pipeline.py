"""Anti-flicker pipeline orchestrator.

Manages per-segment state and routes transcription events through
the gating pipeline (change gate -> sentence gate -> debounce ->
translate -> stability gate -> publish/hold).

Key design: debounce timers are DECOUPLED from translation tasks.
Cancelling a debounce timer does NOT cancel an in-flight HTTP translation.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from translator.gates import change_gate, sentence_gate, stability_gate
from translator.providers.base import TranslationProvider

logger = logging.getLogger(__name__)


@dataclass
class SegmentState:
    """Per-segment, per-target-language pipeline state."""

    last_translated_source: str = ""
    last_published_text: str = ""
    last_sentence_count: int = 0
    debounce_task: asyncio.Task[None] | None = None
    hold_task: asyncio.Task[None] | None = None
    held_translation: str | None = None
    consecutive_holds: int = 0
    has_published: bool = False


@dataclass
class PipelineStats:
    """Periodic stats for INFO-level logging."""

    partials_received: int = 0
    translated: int = 0
    published: int = 0
    held: int = 0
    skipped_change: int = 0
    skipped_sentence: int = 0

    def reset(self) -> None:
        self.partials_received = 0
        self.translated = 0
        self.published = 0
        self.held = 0
        self.skipped_change = 0
        self.skipped_sentence = 0


# Type alias for the publish callback
PublishCallback = Callable[[str, str, str, dict[str, Any], str], Coroutine[Any, Any, None]]


class Pipeline:
    """Anti-flicker translation pipeline.

    Args:
        provider: Translation provider instance.
        publish_fn: Async callback to publish translation to MQTT.
            Signature: (session_id, channel_id, action, payload, key) -> None
        change_threshold: RapidFuzz similarity threshold (0-100).
        min_new_chars: Min chars added to trigger translation.
        debounce_ms: Debounce delay for mid-sentence partials.
        stability_threshold: Min prefix stability ratio (0.0-1.0).
        max_hold_seconds: Max time to hold a rejected translation.
        max_consecutive_holds: Force-publish after N consecutive holds.
    """

    def __init__(
        self,
        provider: TranslationProvider,
        publish_fn: PublishCallback,
        change_threshold: float = 85.0,
        min_new_chars: int = 10,
        debounce_ms: int = 500,
        stability_threshold: float = 0.6,
        max_hold_seconds: float = 3.0,
        max_consecutive_holds: int = 3,
    ) -> None:
        self.provider = provider
        self.publish_fn = publish_fn
        self.change_threshold = change_threshold
        self.min_new_chars = min_new_chars
        self.debounce_ms = debounce_ms
        self.stability_threshold = stability_threshold
        self.max_hold_seconds = max_hold_seconds
        self.max_consecutive_holds = max_consecutive_holds

        # State keyed by "{sessionId}/{channelId}/{targetLang}"
        self._states: dict[str, SegmentState] = {}
        self._stats = PipelineStats()
        self._stats_task: asyncio.Task[None] | None = None
        # Track independent fire-and-forget translation tasks
        self._active_tasks: set[asyncio.Task] = set()

    def _get_state(self, key: str) -> SegmentState:
        if key not in self._states:
            self._states[key] = SegmentState()
        return self._states[key]

    def _clear_state(self, key: str) -> None:
        """Clear segment state. Only cancels debounce/hold timers, NOT in-flight translations."""
        state = self._states.pop(key, None)
        if state:
            if state.debounce_task and not state.debounce_task.done():
                state.debounce_task.cancel()
            if state.hold_task and not state.hold_task.done():
                state.hold_task.cancel()

    def _cancel_debounce(self, state: SegmentState) -> None:
        """Cancel ONLY the debounce timer. In-flight translations continue."""
        if state.debounce_task and not state.debounce_task.done():
            state.debounce_task.cancel()
            state.debounce_task = None

    def _fire_task(self, coro) -> asyncio.Task:
        """Create a tracked fire-and-forget task."""
        task = asyncio.create_task(coro)
        self._active_tasks.add(task)
        task.add_done_callback(self._active_tasks.discard)
        return task

    async def start_stats_logger(self) -> None:
        """Start periodic stats logging (every 60s at INFO level)."""
        self._stats_task = asyncio.create_task(self._stats_loop())

    async def _stats_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                s = self._stats
                logger.info(
                    "[stats] last 60s: partials_received=%d translated=%d "
                    "published=%d held=%d skipped_change=%d skipped_sentence=%d",
                    s.partials_received,
                    s.translated,
                    s.published,
                    s.held,
                    s.skipped_change,
                    s.skipped_sentence,
                )
                s.reset()
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        """Stop the pipeline and cancel all pending tasks."""
        if self._stats_task and not self._stats_task.done():
            self._stats_task.cancel()
            try:
                await self._stats_task
            except asyncio.CancelledError:
                pass
        # Cancel all pending debounce and hold tasks
        for key in list(self._states.keys()):
            self._clear_state(key)
        # Cancel active translation tasks
        for task in list(self._active_tasks):
            task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks, return_exceptions=True)
        self._active_tasks.clear()

    async def handle_final(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        targets: list[dict[str, str]],
    ) -> None:
        """Handle a final transcription event.

        Finals always bypass all gates: translate all targets in PARALLEL
        and publish immediately, then clear state.
        """
        # First, cancel all pending debounce/hold for all targets
        for target in targets:
            key = f"{session_id}/{channel_id}/{target['targetLang']}"
            self._clear_state(key)

        async def _translate_target(target: dict[str, str]) -> None:
            target_lang = target["targetLang"]
            key = f"{session_id}/{channel_id}/{target_lang}"
            try:
                translated = await self.provider.translate(
                    transcription["text"],
                    transcription.get("lang"),
                    target_lang,
                )
                self._stats.translated += 1
            except Exception:
                logger.exception(
                    "[pipeline] seg=%s ch=%s lang=%s translation error on final",
                    transcription.get("segmentId"),
                    channel_id,
                    target_lang,
                )
                return

            payload = self._build_payload(transcription, translated, target_lang)
            logger.debug(
                "[pipeline] seg=%s ch=%s lang=%s action=FORCE reason=\"final arrived\"",
                transcription.get("segmentId"),
                channel_id,
                target_lang,
            )
            await self.publish_fn(session_id, channel_id, "final", payload, key)
            self._stats.published += 1

        # Translate ALL targets in parallel
        await asyncio.gather(*[_translate_target(t) for t in targets])

    async def handle_partial(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        targets: list[dict[str, str]],
    ) -> None:
        """Handle a partial transcription event.

        Partials go through the full gating pipeline:
        change gate -> sentence gate -> debounce -> translate -> stability gate.
        """
        self._stats.partials_received += 1
        source_text = transcription["text"]
        source_lang = transcription.get("lang")
        seg_id = transcription.get("segmentId")

        for target in targets:
            target_lang = target["targetLang"]
            key = f"{session_id}/{channel_id}/{target_lang}"
            state = self._get_state(key)

            # PRE-GATE 1: Change Gate
            if change_gate.should_skip(
                state.last_translated_source,
                source_text,
                self.change_threshold,
                self.min_new_chars,
            ):
                similarity_info = f"threshold={self.change_threshold}"
                chars_added = len(source_text) - len(state.last_translated_source)
                logger.debug(
                    "[pipeline] seg=%s ch=%s lang=%s action=SKIP gate=change "
                    "reason=\"similarity>%s chars_added=%d\"",
                    seg_id, channel_id, target_lang,
                    similarity_info, chars_added,
                )
                self._stats.skipped_change += 1
                continue

            # PRE-GATE 2: Sentence Boundary
            new_boundary, new_count = sentence_gate.has_new_sentence(
                source_text, source_lang, state.last_sentence_count
            )
            state.last_sentence_count = new_count

            if new_boundary:
                logger.debug(
                    "[pipeline] seg=%s ch=%s lang=%s sentence boundary detected, "
                    "translating immediately",
                    seg_id, channel_id, target_lang,
                )
                # Cancel debounce timer only — any in-flight translation continues
                self._cancel_debounce(state)
                # Fire translation as INDEPENDENT task (non-blocking, not cancellable by next partial)
                self._fire_task(
                    self._translate_and_check(
                        session_id, channel_id, transcription, target_lang, key, state
                    )
                )
            else:
                # No sentence boundary: reset debounce timer
                self._cancel_debounce(state)
                state.debounce_task = asyncio.create_task(
                    self._debounce_then_fire(
                        session_id, channel_id, transcription, target_lang, key, state
                    )
                )

    async def _debounce_then_fire(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        target_lang: str,
        key: str,
        state: SegmentState,
    ) -> None:
        """Wait for debounce period, then fire translation as INDEPENDENT task.

        If this task is cancelled (new partial arrived), only the sleep is cancelled.
        Any translation that already started continues running independently.
        """
        try:
            await asyncio.sleep(self.debounce_ms / 1000.0)
        except asyncio.CancelledError:
            return  # Timer cancelled by new partial — that's fine

        # Timer fired! Spawn translation as independent fire-and-forget task.
        # This task is NOT cancellable by the next partial's debounce reset.
        self._fire_task(
            self._translate_and_check(
                session_id, channel_id, transcription, target_lang, key, state
            )
        )

    async def _translate_and_check(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        target_lang: str,
        key: str,
        state: SegmentState,
    ) -> None:
        """Translate and run post-gate stability check.

        Safe to run as an independent task. Guards against stale state
        (e.g. if a final arrived and cleared the state while we were translating).
        """
        # Guard: if state was cleared (final arrived), skip
        if key not in self._states:
            return

        source_text = transcription["text"]
        seg_id = transcription.get("segmentId")

        try:
            translated = await self.provider.translate(
                source_text,
                transcription.get("lang"),
                target_lang,
            )
            self._stats.translated += 1
            state.last_translated_source = source_text
        except Exception:
            logger.exception(
                "[pipeline] seg=%s ch=%s lang=%s translation error on partial",
                seg_id, channel_id, target_lang,
            )
            return

        # Guard again: state might have been cleared during the async translate call
        if key not in self._states:
            return

        logger.debug(
            "[pipeline] seg=%s ch=%s lang=%s action=TRANSLATE source=\"%s\"",
            seg_id, channel_id, target_lang, source_text,
        )

        # POST-GATE: Stability Check
        is_stable, stability = stability_gate.check_stability(
            state.last_published_text,
            translated,
            self.stability_threshold,
        )

        if is_stable or not state.has_published:
            # First display or stable prefix: publish
            reason = "first display" if not state.has_published else f"stability={stability:.2f}"
            logger.debug(
                "[pipeline] seg=%s ch=%s lang=%s action=PUBLISH %s",
                seg_id, channel_id, target_lang, reason,
            )

            payload = self._build_payload(transcription, translated, target_lang)
            await self.publish_fn(session_id, channel_id, "partial", payload, key)

            state.last_published_text = translated
            state.has_published = True
            state.consecutive_holds = 0
            state.held_translation = None
            # Cancel any pending hold timer
            if state.hold_task and not state.hold_task.done():
                state.hold_task.cancel()
                state.hold_task = None
            self._stats.published += 1
        else:
            # Unstable prefix: hold
            state.consecutive_holds += 1

            # Find the prefix break for logging
            last_words = state.last_published_text.split()
            new_words = translated.split()
            break_idx = 0
            for i in range(min(len(last_words), len(new_words))):
                if last_words[i] != new_words[i]:
                    break_idx = i
                    break

            old_word = last_words[break_idx] if break_idx < len(last_words) else "?"
            new_word = new_words[break_idx] if break_idx < len(new_words) else "?"

            logger.debug(
                "[pipeline] seg=%s ch=%s lang=%s action=HOLD stability=%.2f "
                "prefix_break=\"%s->%s\" consecutive=%d",
                seg_id, channel_id, target_lang, stability,
                old_word, new_word, state.consecutive_holds,
            )
            self._stats.held += 1

            # Force-publish if max consecutive holds exceeded
            if state.consecutive_holds >= self.max_consecutive_holds:
                logger.debug(
                    "[pipeline] seg=%s ch=%s lang=%s action=FORCE "
                    "reason=\"max_consecutive_holds=%d\"",
                    seg_id, channel_id, target_lang,
                    self.max_consecutive_holds,
                )
                payload = self._build_payload(transcription, translated, target_lang)
                await self.publish_fn(session_id, channel_id, "partial", payload, key)
                state.last_published_text = translated
                state.consecutive_holds = 0
                state.held_translation = None
                if state.hold_task and not state.hold_task.done():
                    state.hold_task.cancel()
                    state.hold_task = None
                self._stats.published += 1
            else:
                # Hold the translation and start max-hold timer
                state.held_translation = translated
                if state.hold_task and not state.hold_task.done():
                    state.hold_task.cancel()
                state.hold_task = asyncio.create_task(
                    self._max_hold_timer(
                        session_id, channel_id, transcription, target_lang, key, state
                    )
                )

    async def _max_hold_timer(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        target_lang: str,
        key: str,
        state: SegmentState,
    ) -> None:
        """Force-publish held translation after max_hold_seconds."""
        try:
            await asyncio.sleep(self.max_hold_seconds)
        except asyncio.CancelledError:
            return

        if state.held_translation is not None and key in self._states:
            seg_id = transcription.get("segmentId")
            logger.debug(
                "[pipeline] seg=%s ch=%s lang=%s action=FORCE "
                "reason=\"max_hold_seconds=%.1f\"",
                seg_id, channel_id, target_lang, self.max_hold_seconds,
            )
            payload = self._build_payload(
                transcription, state.held_translation, target_lang
            )
            await self.publish_fn(session_id, channel_id, "partial", payload, key)
            state.last_published_text = state.held_translation
            state.has_published = True
            state.consecutive_holds = 0
            state.held_translation = None
            self._stats.published += 1

    @staticmethod
    def _build_payload(
        transcription: dict[str, Any],
        translated_text: str,
        target_lang: str,
    ) -> dict[str, Any]:
        """Build the outgoing translation payload matching the MQTT contract."""
        return {
            "segmentId": transcription["segmentId"],
            "astart": transcription.get("astart"),
            "text": translated_text,
            "start": transcription.get("start"),
            "end": transcription.get("end"),
            "sourceLang": transcription.get("lang"),
            "targetLang": target_lang,
            "locutor": transcription.get("locutor"),
        }
