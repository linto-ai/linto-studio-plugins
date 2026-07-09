"""Simulate a subtitle banner over a captured translation stream and measure readability.

Feeds real translation payloads (mosquitto_sub capture, format
"<unix_ts> | <topic> | <json>", topics .../{partial|final}/translations) into two
banner renderers and reports viewer-centric metrics:

- naive: what a direct rendering of each payload does today. Window = last
  `--lines` wrapped lines of the latest text. Measures flicker (visible lines
  rewritten in place), lines scrolled out before the minimum reading time, and
  lines of text that never got displayed at all (finals dumping more than one
  window at once).
- rollup: committed-text-only, paced display (broadcast roll-up). Only the
  stable prefix of each payload is ever displayed (payload `stableChars` when
  present, else cut at the last strong punctuation; finals are fully stable).
  Committed text feeds a word FIFO drained at reading speed (`--cps`), wrapped
  at `--width`, one line scrolling at a time. Displayed text is never rewritten
  by construction; the cost is latency, which is measured.

Usage:
  .venv/bin/python benchmark/banner_sim.py CAPTURE_FILE [--lang en] [--channel 900]
      [--width 42] [--lines 2] [--cps 16] [--min-read 1.5] [--catchup-depth 200]
"""

import argparse
import json
import re
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

STRONG_PUNCT = re.compile(r"[.!?…][\"')\]]*")


def wrap(text: str, width: int) -> list[str]:
    """Word wrap, no hyphenation; overlong words are hard-cut."""
    lines: list[str] = []
    cur = ""
    for word in text.split():
        while len(word) > width:
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:width])
            word = word[width:]
        if not cur:
            cur = word
        elif len(cur) + 1 + len(word) <= width:
            cur += " " + word
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def stable_boundary(payload: dict) -> int:
    """Char offset of the end of the stable prefix in payload['text']."""
    text = payload.get("text", "")
    if payload.get("final"):
        return len(text)
    sc = payload.get("stableChars")
    if isinstance(sc, int) and 0 <= sc <= len(text):
        return sc
    last = 0
    for m in STRONG_PUNCT.finditer(text):
        last = m.end()
    return last


@dataclass
class Event:
    ts: float
    segment_id: object
    final: bool
    payload: dict


def parse_capture(path: Path, lang: str, channel: str | None) -> list[Event]:
    events: list[Event] = []
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
            events.append(Event(
                ts=float(parts[0]),
                segment_id=payload.get("segmentId"),
                final=topic[4] == "final",
                payload=payload,
            ))
    events.sort(key=lambda e: e.ts)
    return events


# ---------------------------------------------------------------------------
# Naive renderer: window = last N wrapped lines of the latest payload text
# ---------------------------------------------------------------------------

@dataclass
class NaiveStats:
    updates: int = 0
    line_rewrites: int = 0          # a visible line's content changed in place
    lines_lost_early: int = 0       # left the window before min_read seconds
    lines_never_shown: int = 0      # wrapped lines that never entered the window
    lines_shown_total: int = 0


def simulate_naive(events: list[Event], width: int, nlines: int, min_read: float) -> NaiveStats:
    st = NaiveStats()
    window: list[str] = []           # visible lines, top to bottom
    shown_since: dict[int, float] = {}   # slot index -> ts it got its current text
    seg_max_line_shown: dict[object, int] = {}
    seg_line_count: dict[object, int] = {}

    for ev in events:
        text = ev.payload.get("text", "")
        lines = wrap(text, width)
        seg_line_count[ev.segment_id] = max(seg_line_count.get(ev.segment_id, 0), len(lines))
        first_shown = max(0, len(lines) - nlines)
        prev_max = seg_max_line_shown.get(ev.segment_id, -1)
        if prev_max >= 0 and first_shown > prev_max + 1:
            st.lines_never_shown += first_shown - (prev_max + 1)
        seg_max_line_shown[ev.segment_id] = max(prev_max, len(lines) - 1)
        new_window = lines[first_shown:]

        st.updates += 1
        # Compare with the old window: pure roll-up progression means every old
        # visible line either survives verbatim, is extended (bottom line still
        # growing), or scrolls out the top after having been readable.
        for i, old in enumerate(window):
            survives = any(new == old or new.startswith(old) for new in new_window)
            if survives:
                continue
            age = ev.ts - shown_since.get(i, ev.ts)
            if any(old.startswith(new) or _midway_change(old, new) for new in new_window):
                st.line_rewrites += 1
            if age < min_read:
                st.lines_lost_early += 1
        for i, new in enumerate(new_window):
            old_idx = _find_slot(window, new)
            if old_idx is None:
                shown_since[i] = ev.ts
                st.lines_shown_total += 1
            else:
                shown_since[i] = shown_since.get(old_idx, ev.ts)
        window = new_window
    return st


def _find_slot(window: list[str], new: str) -> int | None:
    for i, old in enumerate(window):
        if new == old or new.startswith(old):
            return i
    return None


def _midway_change(old: str, new: str) -> bool:
    """Same visual slot, different content sharing a prefix: an in-place edit."""
    if old == new or new.startswith(old) or old.startswith(new):
        return False
    common = 0
    for a, b in zip(old, new):
        if a != b:
            break
        common += 1
    return common >= min(8, len(old) // 2)


# ---------------------------------------------------------------------------
# Rollup renderer: committed text only, paced drain, roll-up scrolling
# ---------------------------------------------------------------------------

@dataclass
class RollupStats:
    committed_chars: int = 0
    divergent_finals: int = 0
    rewrites: int = 0               # must stay 0: displayed text is append-only
    lines_lost_early: int = 0       # must stay 0 given cps/width/min_read
    latencies: list[float] = field(default_factory=list)
    max_fifo_chars: int = 0
    residual_chars: int = 0         # still queued when the capture ends
    lines_shown_total: int = 0


class RollupBanner:
    def __init__(self, width: int, nlines: int, cps: float, min_read: float,
                 catchup_depth: int, stats: RollupStats) -> None:
        self.width = width
        self.nlines = nlines
        self.base_cps = cps
        self.min_read = min_read
        self.catchup_depth = catchup_depth
        self.stats = stats
        self.fifo: list[tuple[str, float]] = []   # (word, arrival_ts)
        self.fifo_chars = 0
        self.cur_line = ""
        self.closed: list[tuple[str, float]] = []  # (line, close_ts)
        self.budget = 0.0
        self.committed: dict[object, str] = {}

    def commit(self, seg: object, payload: dict, ts: float) -> None:
        text = payload.get("text", "")
        boundary = stable_boundary(payload)
        stable = text[:boundary]
        prev = self.committed.get(seg, "")
        if not stable:
            return
        if stable.startswith(prev):
            new = stable[len(prev):]
        else:
            # the final rewrote frozen text: word-level remainder, else drop
            fw, pw = stable.split(), prev.split()
            if fw[: len(pw)] == pw:
                new = " " + " ".join(fw[len(pw):])
            else:
                self.stats.divergent_finals += 1
                new = ""
        self.committed[seg] = stable
        for word in new.split():
            self.fifo.append((word, ts))
            self.fifo_chars += len(word) + 1
        self.stats.committed_chars += len(new)
        self.stats.max_fifo_chars = max(self.stats.max_fifo_chars, self.fifo_chars)

    def drain_until(self, now: float, last: float) -> None:
        # Step in small ticks so lines close at realistic times even across
        # long gaps between MQTT events (continuous display, event-driven sim).
        t = last
        while t < now:
            step = min(0.25, now - t)
            t += step
            cps = self.base_cps
            if self.fifo_chars > self.catchup_depth:
                cps *= 1.5
            self.budget += step * cps
            self._pop_words(t)
            if not self.fifo:
                self.budget = 0.0

    def _pop_words(self, t_display: float) -> None:
        while self.fifo and self.budget >= len(self.fifo[0][0]) + 1:
            word, arrival = self.fifo.pop(0)
            self.budget -= len(word) + 1
            self.fifo_chars -= len(word) + 1
            self.stats.latencies.append(t_display - arrival)
            if not self.cur_line:
                self.cur_line = word
            elif len(self.cur_line) + 1 + len(word) <= self.width:
                self.cur_line += " " + word
            else:
                self._close_line(t_display)
                self.cur_line = word

    def _close_line(self, ts: float) -> None:
        self.closed.append((self.cur_line, ts))
        self.stats.lines_shown_total += 1
        # the line scrolled out of the window is the one nlines back
        if len(self.closed) >= self.nlines + 1:
            _, closed_ts = self.closed[-(self.nlines + 1)]
            visible = ts - closed_ts
            if visible < self.min_read:
                self.stats.lines_lost_early += 1


def simulate_rollup(events: list[Event], width: int, nlines: int, cps: float,
                    min_read: float, catchup_depth: int) -> RollupStats:
    stats = RollupStats()
    banner = RollupBanner(width, nlines, cps, min_read, catchup_depth, stats)
    if not events:
        return stats
    last = events[0].ts
    for ev in events:
        banner.drain_until(ev.ts, last)
        last = ev.ts
        banner.commit(ev.segment_id, ev.payload, ev.ts)
    # drain what remains at reading speed
    end = last
    while banner.fifo:
        end += 1.0
        banner.drain_until(end, end - 1.0)
    stats.residual_chars = 0
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("capture", type=Path)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--width", type=int, default=42)
    ap.add_argument("--lines", type=int, default=2)
    ap.add_argument("--cps", type=float, default=16.0)
    ap.add_argument("--min-read", type=float, default=1.5)
    ap.add_argument("--catchup-depth", type=int, default=100)
    args = ap.parse_args()

    events = parse_capture(args.capture, args.lang, args.channel)
    if not events:
        sys.exit(f"no translation events for lang={args.lang} channel={args.channel}")
    span = events[-1].ts - events[0].ts
    n_seg = len({e.segment_id for e in events})
    print(f"capture: {len(events)} translation events, {n_seg} segments, "
          f"{span / 60:.1f} min, lang={args.lang}")
    print(f"banner: {args.lines} lines x {args.width} chars, {args.cps} cps, "
          f"min readable {args.min_read}s\n")

    nv = simulate_naive(events, args.width, args.lines, args.min_read)
    print("[naive] direct rendering of each payload (current behaviour)")
    print(f"  window updates            {nv.updates}")
    print(f"  visible line rewrites     {nv.line_rewrites}   <- flicker")
    print(f"  lines lost before {args.min_read}s    {nv.lines_lost_early}   <- unreadable scroll")
    print(f"  lines never displayed     {nv.lines_never_shown}   <- final bursts")
    print(f"  lines shown               {nv.lines_shown_total}\n")

    ru = simulate_rollup(events, args.width, args.lines, args.cps,
                         args.min_read, args.catchup_depth)
    lat = ru.latencies
    print("[rollup] committed-only, paced roll-up")
    print(f"  committed chars           {ru.committed_chars}")
    print(f"  visible line rewrites     {ru.rewrites}")
    print(f"  lines lost before {args.min_read}s    {ru.lines_lost_early}")
    print(f"  divergent finals          {ru.divergent_finals}")
    print(f"  lines shown               {ru.lines_shown_total}")
    if lat:
        print(f"  display latency p50/p95/max  "
              f"{statistics.median(lat):.1f}s / "
              f"{statistics.quantiles(lat, n=20)[18]:.1f}s / {max(lat):.1f}s")
    print(f"  max FIFO depth            {ru.max_fifo_chars} chars")


if __name__ == "__main__":
    main()
