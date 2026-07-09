"""Tests for the BannerPacer paced output stage."""

from translator.pacer import (
    MAX_BACKLOG_CHARS,
    MAX_FACTOR,
    MAX_HOLD_S,
    BannerPacer,
)

KEY = "s/c/en"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class PublishLog:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def publish(self, session_id, channel_id, action, payload, key):
        self.events.append((action, payload))

    def partials(self):
        return [p for a, p in self.events if a == "partial"]

    def finals(self):
        return [p for a, p in self.events if a == "final"]


def payload(text, seg=1, final=False):
    return {
        "segmentId": seg,
        "astart": "2026-01-01T00:00:00Z",
        "text": text,
        "start": 0,
        "end": 1.0,
        "sourceLang": "fr-FR",
        "targetLang": "en",
        "locutor": None,
        "final": final,
        "mode": "external",
    }


def make(cps=16.0):
    clock = FakeClock()
    log = PublishLog()
    pacer = BannerPacer(log.publish, cps=cps, clock=clock, autostart=False)
    return pacer, log, clock


async def feed(pacer, action, pl):
    await pacer.publish("s", "c", action, pl, KEY)


async def tick(pacer, clock, dt=0.25):
    clock.now += dt
    await pacer._tick(clock.now, dt)


async def run_until_final(pacer, log, clock, max_ticks=200):
    for _ in range(max_ticks):
        await tick(pacer, clock)
        if log.finals():
            return
    raise AssertionError("final never published")


# Max chars a single tick may reveal: budget at max catch-up plus one word
# that overshoots the budget boundary.
TICK_BUDGET = 0.25 * 16.0 * MAX_FACTOR
WORD_SLACK = 20


class TestDrip:
    async def test_monotonic_prefixes_then_verbatim_final(self):
        pacer, log, clock = make()
        text = "Hello everyone, and welcome to this first presentation."
        await feed(pacer, "partial", payload(text))
        final = payload(text, final=True)
        await feed(pacer, "final", final)
        await run_until_final(pacer, log, clock)

        parts = [p["text"] for p in log.partials()]
        assert parts, "expected drip partials"
        for prev, cur in zip(parts, parts[1:]):
            assert cur.startswith(prev) and len(cur) > len(prev)
        for t in parts:
            assert text.startswith(t)
        assert parts[-1] == text
        # final is the canonical payload, untouched
        assert log.finals() == [final]
        assert log.events[-1][0] == "final"
        # drip payloads keep the template fields
        drip = log.partials()[0]
        assert drip["segmentId"] == 1 and drip["mode"] == "external"
        assert drip["final"] is False

    async def test_no_burst_bigger_than_tick_budget(self):
        pacer, log, clock = make()
        text = " ".join(["word"] * 60)  # 299 chars
        await feed(pacer, "final", payload(text, final=True))
        shown = 0
        for _ in range(300):
            before = shown
            await tick(pacer, clock)
            parts = log.partials()
            shown = len(parts[-1]["text"]) if parts else 0
            assert shown - before <= TICK_BUDGET + WORD_SLACK
            if log.finals():
                break
        assert log.finals(), "final never published"
        # 299 chars at 12 chars/tick max: pacing must spread over many ticks
        assert len(log.partials()) >= 15

    async def test_catchup_scales_with_backlog(self):
        # A large backlog must drain faster than the base rate.
        pacer, log, clock = make()
        text = " ".join(["word"] * 50)
        await feed(pacer, "final", payload(text, final=True))
        n = 0
        while not log.finals():
            await tick(pacer, clock)
            n += 1
            assert n < 1000
        base_ticks = len(text) / (0.25 * 16.0)  # ticks at 1x
        assert n < base_ticks * 0.75

    async def test_no_banking_during_silence(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("Short one.", seg=1))
        await feed(pacer, "final", payload("Short one.", seg=1, final=True))
        await run_until_final(pacer, log, clock)
        # long silence, then a new segment: no accumulated budget burst
        for _ in range(240):
            await tick(pacer, clock)
        log.events.clear()
        await feed(pacer, "partial", payload(" ".join(["word"] * 40), seg=2))
        await tick(pacer, clock)
        parts = log.partials()
        if parts:
            assert len(parts[-1]["text"]) <= TICK_BUDGET + WORD_SLACK


class TestBounds:
    async def test_final_flushed_after_max_hold(self):
        pacer, log, clock = make()
        text = " ".join(["word"] * 50)
        await feed(pacer, "partial", payload(text))
        await tick(pacer, clock)
        final = payload(text, final=True)
        await feed(pacer, "final", final)
        clock.now += MAX_HOLD_S + 1
        await pacer._tick(clock.now, 0.25)
        assert log.finals() == [final]
        assert pacer._stats.flushed_hold == 1

    async def test_backlog_flush_keeps_order(self):
        pacer, log, clock = make()
        text = " ".join(["word"] * 40)  # ~199c per segment
        for seg in range(1, 6):
            await feed(pacer, "partial", payload(text, seg=seg))
            await feed(pacer, "final", payload(text, seg=seg, final=True))
        await tick(pacer, clock)
        flushed = [p["segmentId"] for p in log.finals()]
        assert len(flushed) >= 2, "backlog above cap must flush oldest segments"
        assert flushed == sorted(flushed)
        # what remains is at most the cap
        lane = list(pacer._lanes.values())[0]
        assert lane.backlog() <= MAX_BACKLOG_CHARS

    async def test_stalled_head_without_final_dropped(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("No final ever comes here.", seg=1))
        for _ in range(40):
            await tick(pacer, clock)
        assert not log.finals()
        await feed(pacer, "partial", payload("Next segment.", seg=2))
        clock.now += 31
        await pacer._tick(clock.now, 0.25)
        await run_until_final_seg2(pacer, log, clock)

    async def test_stop_flushes_pending_finals(self):
        pacer, log, clock = make()
        text = " ".join(["word"] * 50)
        final = payload(text, final=True)
        await feed(pacer, "partial", payload(text))
        await feed(pacer, "final", final)
        await tick(pacer, clock)
        await pacer.stop()
        assert log.finals() == [final]


async def run_until_final_seg2(pacer, log, clock, max_ticks=200):
    await feed(pacer, "final", payload("Next segment.", seg=2, final=True))
    for _ in range(max_ticks):
        await tick(pacer, clock)
        if any(p["segmentId"] == 2 for p in log.finals()):
            return
    raise AssertionError("seg2 final never published")


class TestDivergence:
    async def test_divergent_final_published_directly(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("Hello world and more text here."))
        for _ in range(4):
            await tick(pacer, clock)
        sent = log.partials()[-1]["text"]
        assert sent
        final = payload("Completely different rewrite.", final=True)
        await feed(pacer, "final", final)
        await run_until_final(pacer, log, clock)
        assert log.finals() == [final]
        assert pacer._stats.divergent_finals == 1
        # nothing garbled was dripped after the divergence
        for p in log.partials():
            assert p["text"].startswith(sent[: len(p["text"])]) or \
                "Hello world".startswith(p["text"][:11])

    async def test_stale_partial_dropped(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("Hello world, this goes on."))
        for _ in range(4):
            await tick(pacer, clock)
        sent = log.partials()[-1]["text"]
        await feed(pacer, "partial", payload("Hzzz"))  # racing stale freeze
        assert pacer._stats.stale_partials == 1
        await feed(pacer, "final", payload("Hello world, this goes on.", final=True))
        await run_until_final(pacer, log, clock)
        for p in log.partials():
            assert "Hello world, this goes on.".startswith(p["text"])
        assert sent  # displayed prefix was never rewritten

    async def test_empty_partial_is_harmless(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload(""))
        await feed(pacer, "partial", payload("Real text now."))
        await feed(pacer, "final", payload("Real text now.", final=True))
        await run_until_final(pacer, log, clock)
        assert log.finals()[0]["text"] == "Real text now."


class TestOrdering:
    async def test_segments_serialize_on_the_wire(self):
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("One two three.", seg=1))
        await feed(pacer, "final", payload("One two three.", seg=1, final=True))
        await feed(pacer, "partial", payload("Four five six.", seg=2))
        await feed(pacer, "final", payload("Four five six.", seg=2, final=True))
        for _ in range(100):
            await tick(pacer, clock)
            if len(log.finals()) == 2:
                break
        seq = [(a, p["segmentId"]) for a, p in log.events]
        final1 = seq.index(("final", 1))
        assert all(s == 1 for _, s in seq[:final1])
        assert all(s == 2 for _, s in seq[final1 + 1:])

    async def test_final_outracing_next_segment_partial(self):
        # Pipeline finals run as independent tasks: final(1) may reach the
        # pacer after partial(2). The wire order must stay 1 then 2.
        pacer, log, clock = make()
        await feed(pacer, "partial", payload("Second segment text.", seg=2))
        await feed(pacer, "final", payload("First segment.", seg=1, final=True))
        for _ in range(100):
            await tick(pacer, clock)
            if len(log.finals()) == 1:
                break
        assert log.finals()[0]["segmentId"] == 1
        for p in log.partials():
            if p["segmentId"] == 2:
                assert ("final", 1) in [(a, q["segmentId"]) for a, q in log.events[
                    : log.events.index(("partial", p))
                ]]
                break

    async def test_lanes_are_independent(self):
        clock = FakeClock()
        log = PublishLog()
        pacer = BannerPacer(log.publish, cps=16.0, clock=clock, autostart=False)
        await pacer.publish("s", "c", "final", payload("English text here.", seg=1, final=True), "s/c/en")
        await pacer.publish("s", "c", "final", payload("Texte allemand ici.", seg=1, final=True), "s/c/de")
        for _ in range(50):
            clock.now += 0.25
            await pacer._tick(clock.now, 0.25)
            if len(log.finals()) == 2:
                break
        assert {p["text"] for p in log.finals()} == {
            "English text here.", "Texte allemand ici.",
        }
