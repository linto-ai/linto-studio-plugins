"""Banner pacer: paced output stage between the Pipeline and MQTT.

The subtitle banner renders the last 2 lines of the latest payload text.
Sentence-sized publishes therefore skip whole lines (measured on prod
captures: median burst 79 chars, 47% of messages exceed one full banner).
When BANNER_CPS > 0 this stage replaces direct publishing:

- partial texts feed a per-(session/channel/lang) lane; a tick loop drips
  them as growing prefixes at reading speed, so the banner rolls line by
  line and displayed text is never rewritten;
- the canonical final is HELD until the drip catches up, then published
  verbatim (same text, same segmentId): the banner redraw is identical and
  persistence sees the exact same message, a few seconds later;
- the drip rate scales with backlog and two hard bounds (max hold per
  final, max backlog) guarantee the display can never drift behind.

Unsent text is replaceable: only the published prefix is immutable.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

TICK_S = 0.25
# Rate factor = 1 + backlog / (2 * CATCHUP_CHARS), capped. Calibrated on the
# real banner: Arial 40px measures ~17 px/char, so a 1080p window shows
# ~100 chars/line ((1920-200)/17). At the cap a full line stays visible
# 100 / (16 * 3) >= 2 s during catch-up (1.4 s on a 1366 laptop's 68c lines).
CATCHUP_CHARS = 40
MAX_FACTOR = 3.0
MAX_HOLD_S = 15.0          # a final never waits longer than this
MAX_BACKLOG_CHARS = 600    # beyond this, oldest finished segments are flushed
STALL_S = 30.0             # head with no final and no progress: dropped
# Pause after each published final before dripping the next segment: the
# banner keeps only the final's last line on screen when the next partial
# arrives, so its closing lines need this long to be readable.
SETTLE_S = 0.5


def _common_word_prefix_chars(a: str, b: str) -> int:
    """Char length, in b's own spacing, of the longest common word prefix."""
    if not a or not b:
        return 0
    n = 0
    for x, y in zip(a.split(), b.split()):
        if x != y:
            break
        n += 1
    i = 0
    for _ in range(n):
        while i < len(b) and b[i] == " ":
            i += 1
        while i < len(b) and b[i] != " ":
            i += 1
    return i


@dataclass
class _Segment:
    seg_id: Any
    template: dict[str, Any]          # latest partial payload, drip template
    target_text: str = ""
    sent_offset: int = 0              # chars of target_text already published
    drip_limit: int = 0               # admissible chars (tail agreement gate)
    prev_hyp: str = ""                # previous raw hypothesis (tail mode)
    final_payload: dict[str, Any] | None = None
    final_at: float = 0.0             # clock when the final arrived
    last_progress: float = 0.0

    def drip_end(self) -> int:
        return min(len(self.target_text), self.drip_limit)


@dataclass
class _Lane:
    """One subtitle track: (session, channel, targetLang)."""

    session_id: str
    channel_id: str
    key: str
    segments: list[_Segment] = field(default_factory=list)
    budget: float = 0.0
    settle_until: float = 0.0

    def backlog(self) -> int:
        return sum(len(s.target_text) - s.sent_offset for s in self.segments)


@dataclass
class _PacerStats:
    drips: int = 0
    finals: int = 0
    stale_partials: int = 0
    divergent_finals: int = 0
    realigned: int = 0        # tail mode: displayed text contradicted mid-segment
    burned_words: int = 0     # tail mode: words displayed in a superseded version
    flushed_hold: int = 0
    flushed_backlog: int = 0
    dropped_stalled: int = 0
    max_hold_s: float = 0.0
    max_backlog: int = 0

    def reset(self) -> None:
        for f in self.__dataclass_fields__:
            setattr(self, f, 0.0 if f == "max_hold_s" else 0)


class BannerPacer:
    """Drips translation partials at reading speed, holds finals until caught up.

    Drop-in for the pipeline publish callback: wire
    `pipeline.publish_fn = pacer.publish` and give the real MQTT callback
    as `publish_fn`. The tick task starts lazily on first publish.

    tail_mode (for TAIL_LIVE_MS > 0 inputs, where partial texts include a
    live tail that gets rewritten): tail words are only dripped once two
    consecutive hypotheses agree on them, and a rewrite that contradicts
    already-displayed words realigns word-wise (the display keeps going,
    the contradicted words are counted as burned) instead of stalling.
    """

    def __init__(self, publish_fn, cps: float, clock=time.monotonic,
                 autostart: bool = True, tail_mode: bool = False) -> None:
        self.publish_fn = publish_fn
        self.cps = cps
        self.clock = clock
        self.tail_mode = tail_mode
        self._lanes: dict[str, _Lane] = {}
        self._stats = _PacerStats()
        self._task: asyncio.Task[None] | None = None
        self._stopped = not autostart

    # ---------------------------------------------------------------- intake

    async def publish(
        self,
        session_id: str,
        channel_id: str,
        action: str,
        payload: dict[str, Any],
        key: str,
    ) -> None:
        """Pipeline-facing entry point (same signature as publish_translation)."""
        lane = self._lanes.get(key)
        if lane is None:
            lane = self._lanes[key] = _Lane(session_id, channel_id, key)
        now = self.clock()
        seg = self._get_segment(lane, payload, now)
        sent_prefix = seg.target_text[: seg.sent_offset]
        text = payload.get("text") or ""

        if action == "final":
            seg.final_payload = payload
            seg.final_at = now
            if text.startswith(sent_prefix):
                seg.target_text = text
            else:
                # The final rewrote already-displayed text: it will be
                # published as-is when it reaches the head (one visible jump).
                self._stats.divergent_finals += 1
                seg.target_text = sent_prefix
            seg.drip_limit = len(seg.target_text)
            seg.last_progress = now
        elif not self.tail_mode:
            # Only the published prefix is immutable; anything unsent may be
            # replaced. Texts not extending the prefix are stale (freeze
            # completions racing out of order): dropped, the final decides.
            if text.startswith(sent_prefix):
                seg.template = payload
                seg.target_text = text
                seg.drip_limit = len(text)
                seg.last_progress = now
            else:
                self._stats.stale_partials += 1
        else:
            self._ingest_tail_partial(seg, payload, text, sent_prefix, now)

        self._ensure_task()

    def _ingest_tail_partial(
        self, seg: _Segment, payload: dict[str, Any], text: str,
        sent_prefix: str, now: float,
    ) -> None:
        if text.startswith(sent_prefix):
            seg.target_text = text
        else:
            # The rewrite contradicts displayed words: keep them on screen
            # (append-only), realign word-wise and continue with the rest.
            sent_words = sent_prefix.split()
            hyp_words = text.split()
            self._stats.realigned += 1
            self._stats.burned_words += sum(
                1 for a, b in zip(sent_words, hyp_words) if a != b
            ) + max(0, len(sent_words) - len(hyp_words))
            rest = hyp_words[len(sent_words):]
            seg.target_text = sent_prefix + (" " + " ".join(rest) if rest else "")
        # Agreement gate: only words confirmed by two consecutive hypotheses
        # may be dripped; the moving end of the tail stays in the queue.
        agreed = _common_word_prefix_chars(seg.prev_hyp, text)
        seg.drip_limit = max(seg.sent_offset, min(agreed, len(seg.target_text)))
        seg.prev_hyp = text
        seg.template = payload
        seg.last_progress = now

    def _get_segment(self, lane: _Lane, payload: dict[str, Any], now: float) -> _Segment:
        seg_id = payload.get("segmentId")
        for seg in lane.segments:
            if seg.seg_id == seg_id:
                return seg
        seg = _Segment(seg_id=seg_id, template=payload, last_progress=now)
        # A final can outrace the next segment's first freeze (independent
        # tasks in the pipeline): keep lanes ordered by segmentId when possible.
        pos = len(lane.segments)
        if isinstance(seg_id, int):
            for i, other in enumerate(lane.segments):
                if isinstance(other.seg_id, int) and other.seg_id > seg_id:
                    pos = i
                    break
        lane.segments.insert(pos, seg)
        return seg

    # ----------------------------------------------------------------- ticks

    def _ensure_task(self) -> None:
        if self._task is None or self._task.done():
            if not self._stopped:
                self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        last = self.clock()
        last_log = last
        try:
            while True:
                await asyncio.sleep(TICK_S)
                now = self.clock()
                await self._tick(now, now - last)
                last = now
                if now - last_log >= 60:
                    self._log_stats()
                    last_log = now
        except asyncio.CancelledError:
            pass

    async def _tick(self, now: float, dt: float) -> None:
        for key, lane in list(self._lanes.items()):
            await self._tick_lane(lane, now, dt)
            if not lane.segments:
                del self._lanes[key]

    async def _tick_lane(self, lane: _Lane, now: float, dt: float) -> None:
        backlog = lane.backlog()
        self._stats.max_backlog = max(self._stats.max_backlog, backlog)
        factor = min(MAX_FACTOR, 1.0 + backlog / (2 * CATCHUP_CHARS))
        lane.budget += dt * self.cps * factor

        await self._enforce_bounds(lane, now)
        if now < lane.settle_until:
            lane.budget = 0.0
            return

        while lane.segments:
            head = lane.segments[0]
            if self._advance(head, lane):
                await self._publish_drip(lane, head)
            if head.sent_offset >= len(head.target_text) and head.final_payload:
                await self._publish_final(lane, head, now)
                continue
            break
        if lane.segments:
            head = lane.segments[0]
            if head.sent_offset >= head.drip_end() and not head.final_payload:
                # Nothing drippable (caught up, or tail words unconfirmed):
                # don't bank budget, the next text must not burst out at once.
                lane.budget = 0.0
                if (now - head.last_progress > STALL_S) and len(lane.segments) > 1:
                    # Final never came (lost upstream): unblock the lane.
                    self._stats.dropped_stalled += 1
                    logger.warning(
                        "[pacer] %s seg=%s stalled %.0fs without final, dropping",
                        lane.key, head.seg_id, now - head.last_progress,
                    )
                    lane.segments.pop(0)
        else:
            lane.budget = 0.0

    async def _enforce_bounds(self, lane: _Lane, now: float) -> None:
        # Hard bound 1: a final is never held longer than MAX_HOLD_S.
        while lane.segments:
            head = lane.segments[0]
            if not head.final_payload:
                break
            held = now - head.final_at
            if head.sent_offset >= len(head.target_text) or held > MAX_HOLD_S:
                if held > MAX_HOLD_S and head.sent_offset < len(head.target_text):
                    self._stats.flushed_hold += 1
                    logger.warning(
                        "[pacer] %s seg=%s final held %.1fs > %.0fs, flushing",
                        lane.key, head.seg_id, held, MAX_HOLD_S,
                    )
                await self._publish_final(lane, head, now)
            else:
                break
        # Hard bound 2: total backlog stays bounded; flush oldest finished
        # segments first (their final is ready, the jump is one redraw).
        while lane.backlog() > MAX_BACKLOG_CHARS:
            head = lane.segments[0] if lane.segments else None
            if head is None or not head.final_payload:
                break
            self._stats.flushed_backlog += 1
            logger.warning(
                "[pacer] %s backlog %dc > %dc, flushing seg=%s",
                lane.key, lane.backlog(), MAX_BACKLOG_CHARS, head.seg_id,
            )
            await self._publish_final(lane, head, now)

    def _advance(self, seg: _Segment, lane: _Lane) -> bool:
        """Move sent_offset forward whole words within the lane budget."""
        text = seg.target_text
        limit = seg.drip_end()
        moved = False
        while seg.sent_offset < limit:
            end = seg.sent_offset
            while end < len(text) and text[end] == " ":
                end += 1
            while end < len(text) and text[end] != " ":
                end += 1
            cost = end - seg.sent_offset
            if cost <= 0 or cost > lane.budget or end > limit:
                break
            lane.budget -= cost
            seg.sent_offset = end
            seg.last_progress = self.clock()
            moved = True
        return moved

    async def _publish_drip(self, lane: _Lane, seg: _Segment) -> None:
        payload = {
            **seg.template,
            "text": seg.target_text[: seg.sent_offset],
            "final": False,
        }
        await self.publish_fn(lane.session_id, lane.channel_id, "partial", payload, lane.key)
        self._stats.drips += 1

    async def _publish_final(self, lane: _Lane, seg: _Segment, now: float) -> None:
        await self.publish_fn(
            lane.session_id, lane.channel_id, "final", seg.final_payload, lane.key
        )
        self._stats.finals += 1
        self._stats.max_hold_s = max(self._stats.max_hold_s, now - seg.final_at)
        lane.segments.remove(seg)
        lane.settle_until = now + SETTLE_S

    # ------------------------------------------------------------- lifecycle

    async def stop(self) -> None:
        """Flush every pending final and stop the tick task."""
        self._stopped = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        now = self.clock()
        for lane in list(self._lanes.values()):
            for seg in list(lane.segments):
                if seg.final_payload:
                    await self._publish_final(lane, seg, now)
        self._lanes.clear()

    def _log_stats(self) -> None:
        s = self._stats
        logger.info(
            "[pacer] last 60s: drips=%d finals=%d stale=%d divergent=%d "
            "realigned=%d burned=%d flush_hold=%d flush_backlog=%d stalled=%d "
            "max_hold=%.1fs max_backlog=%dc",
            s.drips, s.finals, s.stale_partials, s.divergent_finals,
            s.realigned, s.burned_words, s.flushed_hold, s.flushed_backlog,
            s.dropped_stalled, s.max_hold_s, s.max_backlog,
        )
        s.reset()
