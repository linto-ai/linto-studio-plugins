"""Translation scheduler: bounded, ordered access to the provider.

Every provider request goes through here. Two kinds of work:

- freeze(key, text): translation of a frozen sentence/chunk. Sequential per
  key (FIFO via per-key lock) so frozen translations complete in order;
  awaitable by the caller.
- submit_tail(key, text, version, on_done): translation of the current tail.
  Latest-wins slot: at most ONE tail request in flight per key; while it runs,
  newer texts overwrite the pending slot; on completion the newest pending is
  fired, at most once every `min_tail_interval_ms`.

A global semaphore (`max_concurrent`) caps the total number of in-flight
provider requests for the whole process: demand can no longer diverge when
the backend slows down.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from translator.providers.base import TranslationProvider

logger = logging.getLogger(__name__)

# on_done(version, source_text, translated_text) — async
TailCallback = Callable[[int, str, str], Awaitable[None]]


@dataclass
class _TailSlot:
    pending: tuple[str, str, str, int, TailCallback] | None = None  # text, src, tgt, version, cb
    runner: asyncio.Task | None = None
    last_fire: float = float("-inf")


@dataclass
class SchedulerStats:
    freezes: int = 0
    tails: int = 0
    tail_superseded: int = 0  # pending texts overwritten before being sent
    errors: int = 0


class TranslationScheduler:
    def __init__(
        self,
        provider: TranslationProvider,
        max_concurrent: int = 8,
        min_tail_interval_ms: int = 1000,
    ) -> None:
        self.provider = provider
        self._sem = asyncio.Semaphore(max_concurrent)
        self.max_concurrent = max_concurrent
        self.min_tail_interval_s = min_tail_interval_ms / 1000.0
        self._key_locks: dict[str, asyncio.Lock] = {}
        self._tails: dict[str, _TailSlot] = {}
        self.stats = SchedulerStats()
        self.inflight = 0

    async def _translate(self, text: str, src_lang: str | None, tgt_lang: str) -> str:
        async with self._sem:
            self.inflight += 1
            try:
                return await self.provider.translate(text, src_lang, tgt_lang)
            finally:
                self.inflight -= 1

    async def freeze(self, key: str, text: str, src_lang: str | None, tgt_lang: str) -> str:
        """Translate a frozen sentence. FIFO per key, bounded globally."""
        lock = self._key_locks.setdefault(key, asyncio.Lock())
        async with lock:
            self.stats.freezes += 1
            return await self._translate(text, src_lang, tgt_lang)

    def submit_tail(
        self,
        key: str,
        text: str,
        src_lang: str | None,
        tgt_lang: str,
        version: int,
        on_done: TailCallback,
    ) -> None:
        """Latest-wins tail translation. Never more than one in flight per key."""
        slot = self._tails.setdefault(key, _TailSlot())
        if slot.pending is not None:
            self.stats.tail_superseded += 1
        slot.pending = (text, src_lang, tgt_lang, version, on_done)
        if slot.runner is None or slot.runner.done():
            slot.runner = asyncio.create_task(self._run_tail(key, slot))

    async def _run_tail(self, key: str, slot: _TailSlot) -> None:
        try:
            while slot.pending is not None:
                loop = asyncio.get_running_loop()
                wait = slot.last_fire + self.min_tail_interval_s - loop.time()
                if wait > 0:
                    await asyncio.sleep(wait)
                if slot.pending is None:
                    return
                text, src, tgt, version, on_done = slot.pending
                slot.pending = None
                slot.last_fire = loop.time()
                self.stats.tails += 1
                try:
                    translated = await self._translate(text, src, tgt)
                except Exception:
                    self.stats.errors += 1
                    logger.exception("[scheduler] tail translation failed key=%s", key)
                    continue
                try:
                    await on_done(version, text, translated)
                except Exception:
                    logger.exception("[scheduler] tail on_done failed key=%s", key)
        except asyncio.CancelledError:
            pass

    def cancel_key(self, key: str) -> None:
        """Drop any pending (not yet fired) tail for this key."""
        slot = self._tails.get(key)
        if slot is not None:
            slot.pending = None

    def purge_key(self, key: str) -> None:
        """Forget all per-key structures (segment/session over)."""
        self.cancel_key(key)
        slot = self._tails.pop(key, None)
        if slot and slot.runner and not slot.runner.done():
            slot.runner.cancel()
        lock = self._key_locks.get(key)
        if lock is not None and not lock.locked():
            self._key_locks.pop(key, None)

    def snapshot(self) -> dict[str, Any]:
        return {
            "inflight": self.inflight,
            "freezes": self.stats.freezes,
            "tails": self.stats.tails,
            "tail_superseded": self.stats.tail_superseded,
            "errors": self.stats.errors,
        }
