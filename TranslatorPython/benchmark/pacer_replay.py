"""Replay a captured translation stream through the BannerPacer.

Feeds the .../{partial|final}/translations events of a mosquitto_sub capture
("<unix_ts> | <topic> | <json>") into a real BannerPacer driven by a virtual
clock, and writes the paced stream in the same capture format. Pipe the
result into banner_sim.py to measure what a real banner would show.

Usage:
  .venv/bin/python benchmark/pacer_replay.py CAPTURE --cps 16 [--lang en]
      [--channel 900] > paced_capture.log
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from translator.pacer import TICK_S, BannerPacer  # noqa: E402


def parse_capture(path: Path, lang: str, channel: str | None):
    events = []
    with path.open() as f:
        for line in f:
            parts = line.rstrip("\n").split(" | ", 2)
            if len(parts) != 3:
                continue
            topic = parts[1].split("/")
            if len(topic) != 6 or topic[5] != "translations":
                continue
            if channel is not None and topic[3] != channel:
                continue
            try:
                payload = json.loads(parts[2])
            except json.JSONDecodeError:
                continue
            if payload.get("targetLang") != lang:
                continue
            events.append((float(parts[0]), topic[2], topic[3], topic[4], payload))
    events.sort(key=lambda e: e[0])
    return events


async def replay(events, cps: float, out, tail_mode: bool = False) -> BannerPacer:
    clock = {"now": events[0][0]}
    holds = []

    async def emit(session_id, channel_id, action, payload, key):
        topic = f"transcriber/out/{session_id}/{channel_id}/{action}/translations"
        out.write(f"{clock['now']:.6f} | {topic} | {json.dumps(payload, ensure_ascii=False)}\n")

    pacer = BannerPacer(emit, cps=cps, clock=lambda: clock["now"], autostart=False,
                        tail_mode=tail_mode)
    final_in = {}

    for ts, session_id, channel_id, action, payload in events:
        while clock["now"] + TICK_S < ts:
            clock["now"] += TICK_S
            await pacer._tick(clock["now"], TICK_S)
        clock["now"] = ts
        key = f"{session_id}/{channel_id}/{payload.get('targetLang')}"
        if action == "final":
            final_in[(key, payload.get("segmentId"))] = ts
        await pacer.publish(session_id, channel_id, action, payload, key)

    for _ in range(int(120 / TICK_S)):  # drain the tail of the capture
        clock["now"] += TICK_S
        await pacer._tick(clock["now"], TICK_S)
        if not pacer._lanes:
            break
    await pacer.stop()
    return pacer


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("capture", type=Path)
    ap.add_argument("--cps", type=float, default=16.0)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--tail", action="store_true", help="tail_mode (TAIL_LIVE_MS > 0 inputs)")
    args = ap.parse_args()

    events = parse_capture(args.capture, args.lang, args.channel)
    if not events:
        sys.exit(f"no translation events for lang={args.lang}")
    pacer = asyncio.run(replay(events, args.cps, sys.stdout, tail_mode=args.tail))
    s = pacer._stats
    print(
        f"pacer: drips={s.drips} finals={s.finals} stale={s.stale_partials} "
        f"divergent={s.divergent_finals} realigned={s.realigned} burned={s.burned_words} flush_hold={s.flushed_hold} "
        f"flush_backlog={s.flushed_backlog} max_hold={s.max_hold_s:.1f}s "
        f"max_backlog={s.max_backlog}c",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
