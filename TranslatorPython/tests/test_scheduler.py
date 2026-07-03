"""Tests for the TranslationScheduler (latest-wins, FIFO, global cap)."""

import asyncio

import pytest

from translator.providers.base import TranslationProvider
from translator.scheduler import TranslationScheduler


class FakeProvider(TranslationProvider):
    """Controllable-latency provider recording concurrency."""

    def __init__(self, latency: float = 0.0) -> None:
        self.latency = latency
        self.calls: list[str] = []
        self.inflight = 0
        self.max_inflight = 0

    async def translate(self, text, source_lang, target_lang):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        self.calls.append(text)
        if self.latency:
            await asyncio.sleep(self.latency)
        self.inflight -= 1
        return f"T({text})"


@pytest.mark.asyncio
async def test_freeze_returns_translation():
    sched = TranslationScheduler(FakeProvider())
    out = await sched.freeze("k", "Bonjour.", "fr", "en")
    assert out == "T(Bonjour.)"


@pytest.mark.asyncio
async def test_freeze_fifo_per_key():
    prov = FakeProvider(latency=0.01)
    sched = TranslationScheduler(prov, max_concurrent=8)
    results = []

    async def do(text):
        results.append(await sched.freeze("k", text, "fr", "en"))

    await asyncio.gather(do("un"), do("deux"), do("trois"))
    assert prov.calls == ["un", "deux", "trois"]  # FIFO order preserved


@pytest.mark.asyncio
async def test_global_semaphore_caps_concurrency():
    prov = FakeProvider(latency=0.02)
    sched = TranslationScheduler(prov, max_concurrent=3)
    await asyncio.gather(*[
        sched.freeze(f"k{i}", f"t{i}", "fr", "en") for i in range(10)
    ])
    assert prov.max_inflight <= 3


@pytest.mark.asyncio
async def test_tail_latest_wins():
    prov = FakeProvider(latency=0.02)
    sched = TranslationScheduler(prov, max_concurrent=8, min_tail_interval_ms=0)
    done: list[tuple[int, str]] = []

    async def on_done(version, src, dst):
        done.append((version, dst))

    # v1 fires; v2-v4 are superseded while v1 is in flight; v5 fires last
    sched.submit_tail("k", "texte v1", "fr", "en", 1, on_done)
    await asyncio.sleep(0.005)  # let v1 actually start
    for v in range(2, 6):
        sched.submit_tail("k", f"texte v{v}", "fr", "en", v, on_done)
    await asyncio.sleep(0.2)

    assert prov.calls[0] == "texte v1"
    assert prov.calls[-1] == "texte v5"
    assert len(prov.calls) == 2  # never more than first + latest
    assert done[-1] == (5, "T(texte v5)")
    assert sched.stats.tail_superseded == 3


@pytest.mark.asyncio
async def test_tail_single_inflight_per_key():
    prov = FakeProvider(latency=0.03)
    sched = TranslationScheduler(prov, max_concurrent=8, min_tail_interval_ms=0)

    async def on_done(version, src, dst):
        pass

    for v in range(20):
        sched.submit_tail("k", f"v{v}", "fr", "en", v, on_done)
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.2)
    assert prov.max_inflight == 1


@pytest.mark.asyncio
async def test_tail_min_interval():
    prov = FakeProvider()
    sched = TranslationScheduler(prov, max_concurrent=8, min_tail_interval_ms=50)

    async def on_done(version, src, dst):
        pass

    t0 = asyncio.get_event_loop().time()
    sched.submit_tail("k", "a", "fr", "en", 1, on_done)
    await asyncio.sleep(0.01)
    sched.submit_tail("k", "b", "fr", "en", 2, on_done)
    while len(prov.calls) < 2:
        await asyncio.sleep(0.01)
    assert asyncio.get_event_loop().time() - t0 >= 0.05


@pytest.mark.asyncio
async def test_cancel_key_drops_pending():
    prov = FakeProvider(latency=0.05)
    sched = TranslationScheduler(prov, max_concurrent=8, min_tail_interval_ms=0)

    async def on_done(version, src, dst):
        pass

    sched.submit_tail("k", "en vol", "fr", "en", 1, on_done)
    await asyncio.sleep(0.01)
    sched.submit_tail("k", "jamais envoyé", "fr", "en", 2, on_done)
    sched.cancel_key("k")
    await asyncio.sleep(0.2)
    assert "jamais envoyé" not in prov.calls


@pytest.mark.asyncio
async def test_provider_error_does_not_kill_runner():
    class FailOnce(FakeProvider):
        async def translate(self, text, source_lang, target_lang):
            if text == "boom":
                raise RuntimeError("provider down")
            return await super().translate(text, source_lang, target_lang)

    prov = FailOnce()
    sched = TranslationScheduler(prov, max_concurrent=8, min_tail_interval_ms=0)
    done = []

    async def on_done(version, src, dst):
        done.append(version)

    sched.submit_tail("k", "boom", "fr", "en", 1, on_done)
    await asyncio.sleep(0.05)
    sched.submit_tail("k", "ok", "fr", "en", 2, on_done)
    await asyncio.sleep(0.05)
    assert done == [2]
    assert sched.stats.errors == 1
