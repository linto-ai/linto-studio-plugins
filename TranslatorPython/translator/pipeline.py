"""Translation pipeline: prefix freezing + bounded scheduling.

Built around two invariants:

- The unit of translation is the SENTENCE (or bounded chunk), never the
  cumulative segment text. A sentence closed by punctuation is translated
  once, frozen, and never re-generated: the published text is
  `join(frozen translations) + tail translation`.
- By default nothing is re-translated until new punctuation closes a
  sentence (finals excepted). Live tail updates between punctuation marks
  are opt-in (`tail_live_ms > 0`) and go through a latest-wins slot with a
  minimum interval.

Finals always win: they are translated with priority, reuse the frozen
prefix (and the last tail translation when the remainder is identical —
zero request), and are never blocked behind partial work. `handle_final`
returns immediately: the actual work runs as an independent task so a slow
provider can no longer stall the MQTT consumption loop (defect D12).
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from translator.assembler import SegmentAssembler
from translator.gates import change_gate, stability_gate
from translator.providers.base import TranslationProvider
from translator.scheduler import TranslationScheduler

logger = logging.getLogger(__name__)


@dataclass
class ChannelState:
    """Per (session, channel): source segmentation, shared by all target langs."""

    assembler: SegmentAssembler
    segment_id: Any = None
    last_activity: float = 0.0


@dataclass
class KeyState:
    """Per (session, channel, targetLang) segment state."""

    frozen_dst: dict[int, str] = field(default_factory=dict)
    pending_freezes: set[asyncio.Task] = field(default_factory=set)
    submitted_tail_src: str = ""   # change-gate reference, set at SUBMISSION (fixes D3)
    last_tail_src: str = ""        # last COMPLETED tail translation (P7 cache)
    last_tail_dst: str = ""
    tail_version: int = 0
    published_tail_version: int = -1
    last_published_text: str = ""
    has_published: bool = False
    consecutive_holds: int = 0
    finalized: bool = False
    last_activity: float = 0.0


@dataclass
class PipelineStats:
    """Periodic stats for INFO-level logging."""

    partials_received: int = 0
    finals_received: int = 0
    translated: int = 0
    freezes: int = 0
    tail_updates: int = 0
    published: int = 0
    held: int = 0
    skipped_change: int = 0
    finals_reused: int = 0        # P7: zero-request finals
    finals_full_retranslated: int = 0
    assembler_resets: int = 0
    dropped_stale: int = 0

    def reset(self) -> None:
        for f in self.__dataclass_fields__:
            setattr(self, f, 0)


# Type alias for the publish callback
PublishCallback = Callable[[str, str, str, dict[str, Any], str], Coroutine[Any, Any, None]]


class Pipeline:
    """Prefix-freezing translation pipeline.

    Args:
        provider: Translation provider instance.
        publish_fn: Async callback to publish translation to MQTT.
            Signature: (session_id, channel_id, action, payload, key) -> None
        change_threshold: RapidFuzz similarity threshold (0-100), tail only.
        min_new_chars: Min chars added to consider a tail update, tail only.
        stability_threshold: Min prefix stability ratio (0.0-1.0), tail only.
        max_consecutive_holds: Force-publish after N consecutive tail holds.
        translate_partials: False = eco mode, only finals are translated.
        tail_live_ms: 0 = tail updates only at punctuation (default);
            > 0 = live tail updates through a latest-wins slot, at most one
            in flight per key and one per interval.
        soft_chunk_chars: Freeze budget for unpunctuated speech.
        max_concurrent: Global cap on in-flight provider requests.
        state_ttl_s: Purge state for keys inactive longer than this.
        debounce_ms / max_hold_seconds: deprecated, accepted and ignored.
    """

    def __init__(
        self,
        provider: TranslationProvider,
        publish_fn: PublishCallback,
        change_threshold: float = 85.0,
        min_new_chars: int = 10,
        stability_threshold: float = 0.6,
        max_consecutive_holds: int = 2,
        translate_partials: bool = True,
        tail_live_ms: int = 0,
        soft_chunk_chars: int = 220,
        max_concurrent: int = 8,
        state_ttl_s: float = 600.0,
        debounce_ms: int | None = None,      # deprecated
        max_hold_seconds: float | None = None,  # deprecated
    ) -> None:
        self.provider = provider
        self.publish_fn = publish_fn
        self.change_threshold = change_threshold
        self.min_new_chars = min_new_chars
        self.stability_threshold = stability_threshold
        self.max_consecutive_holds = max_consecutive_holds
        self.translate_partials = translate_partials
        self.tail_live_ms = tail_live_ms
        self.soft_chunk_chars = soft_chunk_chars
        self.state_ttl_s = state_ttl_s
        if debounce_ms is not None:
            logger.warning("[pipeline] debounce_ms is deprecated and ignored (use tail_live_ms)")
        if max_hold_seconds is not None:
            logger.warning("[pipeline] max_hold_seconds is deprecated and ignored")

        self.scheduler = TranslationScheduler(
            provider,
            max_concurrent=max_concurrent,
            min_tail_interval_ms=tail_live_ms if tail_live_ms > 0 else 0,
        )

        self._channels: dict[str, ChannelState] = {}   # "{session}/{channel}"
        self._states: dict[str, KeyState] = {}         # "{session}/{channel}/{lang}"
        self._stats = PipelineStats()
        self._stats_task: asyncio.Task[None] | None = None
        self._ttl_task: asyncio.Task[None] | None = None
        # Independent fire-and-forget tasks (freezes, finals)
        self._active_tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ utils

    def _get_key_state(self, key: str) -> KeyState:
        st = self._states.get(key)
        if st is None:
            st = self._states[key] = KeyState()
        st.last_activity = time.monotonic()
        return st

    def _fire_task(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._active_tasks.add(task)
        task.add_done_callback(self._active_tasks.discard)
        return task

    @staticmethod
    def _assemble(st: KeyState, tail_dst: str = "") -> str:
        """Published text = contiguous frozen prefix + current tail translation."""
        parts = []
        i = 0
        while i in st.frozen_dst:
            parts.append(st.frozen_dst[i])
            i += 1
        if tail_dst:
            parts.append(tail_dst)
        return " ".join(parts)

    def _frozen_complete(self, st: KeyState, expected: int) -> bool:
        return all(i in st.frozen_dst for i in range(expected))

    # ------------------------------------------------------------ maintenance

    async def start_stats_logger(self) -> None:
        """Start periodic stats logging (every 60s) and the TTL reaper.

        Idempotent: cancels any previous loops first (fixes D10, duplicated
        stats loops after MQTT reconnections).
        """
        for t in (self._stats_task, self._ttl_task):
            if t and not t.done():
                t.cancel()
        self._stats_task = asyncio.create_task(self._stats_loop())
        self._ttl_task = asyncio.create_task(self._ttl_loop())

    async def _stats_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                s = self._stats
                sched = self.scheduler.snapshot()
                logger.info(
                    "[stats] last 60s: partials=%d finals=%d translated=%d "
                    "(freezes=%d tails=%d) published=%d held=%d skipped_change=%d "
                    "finals_reused=%d finals_full=%d resets=%d stale=%d | "
                    "inflight=%d superseded=%d errors=%d",
                    s.partials_received, s.finals_received, s.translated,
                    s.freezes, s.tail_updates, s.published, s.held,
                    s.skipped_change, s.finals_reused, s.finals_full_retranslated,
                    s.assembler_resets, s.dropped_stale,
                    sched["inflight"], sched["tail_superseded"], sched["errors"],
                )
                usage = getattr(self.provider, "usage_snapshot", None)
                if usage is not None:
                    u = usage()
                    logger.info(
                        "[stats] provider cumulative: requests=%d prompt_tokens=%d "
                        "completion_tokens=%d truncated=%d",
                        u["requests"], u["prompt_tokens"],
                        u["completion_tokens"], u["truncated"],
                    )
                s.reset()
        except asyncio.CancelledError:
            pass

    async def _ttl_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                now = time.monotonic()
                for key, st in list(self._states.items()):
                    if now - st.last_activity > self.state_ttl_s:
                        self._states.pop(key, None)
                        self.scheduler.purge_key(key)
                for ch_key, ch in list(self._channels.items()):
                    if now - ch.last_activity > self.state_ttl_s:
                        self._channels.pop(ch_key, None)
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        """Stop the pipeline and cancel all pending tasks."""
        for t in (self._stats_task, self._ttl_task):
            if t and not t.done():
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        for key in list(self._states):
            self.scheduler.purge_key(key)
        self._states.clear()
        self._channels.clear()
        for task in list(self._active_tasks):
            task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks, return_exceptions=True)
        self._active_tasks.clear()

    # --------------------------------------------------------------- partials

    async def handle_partial(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        targets: list[dict[str, str]],
    ) -> None:
        """Handle a partial transcription event.

        Segmentation is done ONCE per event (shared across target languages);
        newly frozen sentences are translated exactly once per language; the
        unfrozen tail is only translated in live mode (`tail_live_ms > 0`).
        """
        self._stats.partials_received += 1
        if not self.translate_partials:
            return

        source_lang = transcription.get("lang")
        seg_id = transcription.get("segmentId")
        ch_key = f"{session_id}/{channel_id}"

        ch = self._channels.get(ch_key)
        if ch is None or ch.segment_id != seg_id:
            # New segment: fresh assembler. Old per-lang states were purged by
            # the final; if the final never came, void them now.
            if ch is not None:
                for target in targets:
                    stale_key = f"{ch_key}/{target['targetLang']}"
                    self._states.pop(stale_key, None)
                    self.scheduler.purge_key(stale_key)
            ch = self._channels[ch_key] = ChannelState(
                assembler=SegmentAssembler(self.soft_chunk_chars), segment_id=seg_id
            )
        ch.last_activity = time.monotonic()

        result = ch.assembler.update(transcription["text"], source_lang)

        if result.reset:
            self._stats.assembler_resets += 1
            for target in targets:
                key = f"{ch_key}/{target['targetLang']}"
                st = self._states.get(key)
                if st is not None:
                    st.frozen_dst.clear()
                    st.tail_version += 1  # invalidate in-flight tail completions
                self.scheduler.cancel_key(key)

        for target in targets:
            target_lang = target["targetLang"]
            key = f"{ch_key}/{target_lang}"
            st = self._get_key_state(key)

            for idx, sentence in result.newly_frozen:
                task = self._fire_task(
                    self._freeze_and_publish(
                        session_id, channel_id, key, st, idx, sentence,
                        transcription, target_lang,
                    )
                )
                st.pending_freezes.add(task)
                task.add_done_callback(st.pending_freezes.discard)

            if self.tail_live_ms > 0 and result.tail:
                if change_gate.should_skip(
                    st.submitted_tail_src, result.tail,
                    self.change_threshold, self.min_new_chars,
                ):
                    self._stats.skipped_change += 1
                    continue
                st.submitted_tail_src = result.tail
                st.tail_version += 1
                self.scheduler.submit_tail(
                    key, result.tail, source_lang, target_lang, st.tail_version,
                    self._make_tail_callback(session_id, channel_id, key, st, transcription, target_lang),
                )

    async def _freeze_and_publish(
        self,
        session_id: str,
        channel_id: str,
        key: str,
        st: KeyState,
        idx: int,
        sentence: str,
        transcription: dict[str, Any],
        target_lang: str,
    ) -> None:
        try:
            translated = await self.scheduler.freeze(
                key, sentence, transcription.get("lang"), target_lang
            )
        except Exception:
            logger.exception(
                "[pipeline] seg=%s ch=%s lang=%s freeze error idx=%d",
                transcription.get("segmentId"), channel_id, target_lang, idx,
            )
            return
        self._stats.translated += 1
        self._stats.freezes += 1

        if self._states.get(key) is not st:
            self._stats.dropped_stale += 1
            st.frozen_dst[idx] = translated  # the final may still be waiting on it
            return
        st.frozen_dst[idx] = translated
        if st.finalized:
            return  # the final task will assemble and publish

        text = self._assemble(st, st.last_tail_dst)
        payload = self._build_payload(transcription, text, target_lang, final=False)
        logger.debug(
            "[pipeline] seg=%s ch=%s lang=%s action=PUBLISH reason=freeze idx=%d",
            transcription.get("segmentId"), channel_id, target_lang, idx,
        )
        await self.publish_fn(session_id, channel_id, "partial", payload, key)
        st.last_published_text = text
        st.has_published = True
        self._stats.published += 1

    def _make_tail_callback(
        self,
        session_id: str,
        channel_id: str,
        key: str,
        st: KeyState,
        transcription: dict[str, Any],
        target_lang: str,
    ):
        async def on_done(version: int, source_text: str, translated: str) -> None:
            self._stats.translated += 1
            self._stats.tail_updates += 1
            st.last_tail_src = source_text
            st.last_tail_dst = translated
            # Monotonicity guard: stale completions are recorded (cache) but never published
            if (
                self._states.get(key) is not st
                or st.finalized
                or version <= st.published_tail_version
                or version < st.tail_version
            ):
                self._stats.dropped_stale += 1
                return

            text = self._assemble(st, translated)
            # Stability gate on the tail only (the frozen prefix cannot flicker)
            is_stable, stability = stability_gate.check_stability(
                st.last_published_text, text, self.stability_threshold
            )
            if not is_stable and st.has_published:
                st.consecutive_holds += 1
                if st.consecutive_holds < self.max_consecutive_holds:
                    self._stats.held += 1
                    return
            st.consecutive_holds = 0

            payload = self._build_payload(transcription, text, target_lang, final=False)
            await self.publish_fn(session_id, channel_id, "partial", payload, key)
            st.published_tail_version = version
            st.last_published_text = text
            st.has_published = True
            self._stats.published += 1

        return on_done

    # ----------------------------------------------------------------- finals

    async def handle_final(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        targets: list[dict[str, str]],
    ) -> None:
        """Handle a final transcription event.

        Returns IMMEDIATELY (fixes D12): the translation work runs as an
        independent task, so a slow provider never stalls the MQTT loop.
        """
        self._stats.finals_received += 1
        ch_key = f"{session_id}/{channel_id}"

        # Snapshot + detach state synchronously, before any await
        ch = self._channels.pop(ch_key, None)
        frozen_src = list(ch.assembler.frozen_src) if ch else []
        consumed_text = ch.assembler.consumed_text if ch else ""
        lang_states: dict[str, KeyState | None] = {}
        for target in targets:
            key = f"{ch_key}/{target['targetLang']}"
            st = self._states.pop(key, None)
            if st is not None:
                st.finalized = True
            self.scheduler.cancel_key(key)
            lang_states[target["targetLang"]] = st

        self._fire_task(
            self._finalize_all(
                session_id, channel_id, transcription, targets,
                frozen_src, consumed_text, lang_states,
            )
        )

    async def _finalize_all(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        targets: list[dict[str, str]],
        frozen_src: list[str],
        consumed_text: str,
        lang_states: dict[str, KeyState | None],
    ) -> None:
        await asyncio.gather(*[
            self._finalize_target(
                session_id, channel_id, transcription,
                t["targetLang"], frozen_src, consumed_text,
                lang_states.get(t["targetLang"]),
            )
            for t in targets
        ])

    async def _finalize_target(
        self,
        session_id: str,
        channel_id: str,
        transcription: dict[str, Any],
        target_lang: str,
        frozen_src: list[str],
        consumed_text: str,
        st: KeyState | None,
    ) -> None:
        key = f"{session_id}/{channel_id}/{target_lang}"
        final_text = transcription["text"]
        source_lang = transcription.get("lang")

        try:
            translated = await self._final_translation(
                key, final_text, source_lang, target_lang,
                frozen_src, consumed_text, st,
            )
        except Exception:
            logger.exception(
                "[pipeline] seg=%s ch=%s lang=%s translation error on final",
                transcription.get("segmentId"), channel_id, target_lang,
            )
            return

        payload = self._build_payload(transcription, translated, target_lang, final=True)
        logger.debug(
            "[pipeline] seg=%s ch=%s lang=%s action=FORCE reason=\"final arrived\"",
            transcription.get("segmentId"), channel_id, target_lang,
        )
        await self.publish_fn(session_id, channel_id, "final", payload, key)
        self._stats.published += 1
        self.scheduler.purge_key(key)

    async def _final_translation(
        self,
        key: str,
        final_text: str,
        source_lang: str | None,
        target_lang: str,
        frozen_src: list[str],
        consumed_text: str,
        st: KeyState | None,
    ) -> str:
        """Best-effort reuse of frozen/tail translations for the final text."""
        remainder = (
            self._word_prefix_remainder(final_text, consumed_text)
            if st is not None and frozen_src and consumed_text
            else None
        )
        if remainder is not None:
            if st.pending_freezes:
                await asyncio.gather(*st.pending_freezes, return_exceptions=True)
            if self._frozen_complete(st, len(frozen_src)):
                if not remainder:
                    self._stats.finals_reused += 1
                    return self._assemble(st)
                if remainder == " ".join(st.last_tail_src.split()) and st.last_tail_dst:
                    self._stats.finals_reused += 1
                    return self._assemble(st, st.last_tail_dst)
                remainder_dst = await self.scheduler.freeze(
                    key, remainder, source_lang, target_lang
                )
                self._stats.translated += 1
                return self._assemble(st, remainder_dst)

        # The final rewrote the past (or nothing was frozen): one full
        # retranslation — the price of correction, once per segment per lang.
        self._stats.finals_full_retranslated += 1
        translated = await self.scheduler.freeze(key, final_text, source_lang, target_lang)
        self._stats.translated += 1
        return translated

    # ---------------------------------------------------------------- payload

    @staticmethod
    def _word_prefix_remainder(final_text: str, consumed_text: str) -> str | None:
        """Remainder of final_text after consumed_text, compared word-wise.

        Whitespace-insensitive: ASR partials carry a leading space and looser
        spacing than the final. None = consumed is not a prefix of the final
        (the final rewrote frozen text).
        """
        fw = final_text.split()
        cw = consumed_text.split()
        if fw[: len(cw)] != cw:
            return None
        return " ".join(fw[len(cw):])

    @staticmethod
    def _build_payload(
        transcription: dict[str, Any],
        translated_text: str,
        target_lang: str,
        *,
        final: bool,
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
            "final": final,
            "mode": "external",
        }
