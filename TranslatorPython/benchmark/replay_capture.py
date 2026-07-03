"""Replay a recorded MQTT capture through the REAL translator pipeline and count model calls/tokens.

Feeds real transcriber partial/final events (mosquitto_sub capture, format
"<unix_ts> | <topic> | <json>") into `translator.pipeline.Pipeline` unmodified,
with an instrumented provider that records every model call: input size,
estimated tokens, in-flight concurrency, per-segment accounting.

Time is VIRTUAL: a custom asyncio event loop advances the clock to the next
timer instead of sleeping, so a 1-hour capture replays in seconds of CPU while
debounce/hold/provider-latency semantics stay exact.

Token estimate: FR/EN latin text ~4 chars/token (TranslateGemma is
gemma-based). Reported as `~tok`. A constant per-call chat-template overhead
(~10 tok) is reported separately.

Usage:
  .venv/bin/python benchmark/replay_capture.py CAPTURE_FILE [options]

Examples:
  # current defaults, ideal backend (0 latency)
  ... replay_capture.py mqtt_live.log
  # realistic backend latency
  ... replay_capture.py mqtt_live.log --latency-ms 150 --decode-tps 80
  # tuned ENV
  ... replay_capture.py mqtt_live.log --min-new-chars 40 --debounce-ms 1000
  # lower bound: finals only (future TRANSLATE_PARTIALS=false)
  ... replay_capture.py mqtt_live.log --finals-only
"""

import argparse
import asyncio
import contextvars
import json
import math
import selectors
import statistics
import sys
import time as _time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from translator.pipeline import Pipeline  # noqa: E402
from translator.providers.base import TranslationProvider  # noqa: E402

CHARS_PER_TOKEN = 4.0
CALL_OVERHEAD_TOKENS = 10  # chat template (<start_of_turn> etc.), constant per request


def est_tokens(chars: int) -> int:
    return math.ceil(chars / CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Virtual time event loop
# ---------------------------------------------------------------------------

class _VirtualClock:
    __slots__ = ("t",)

    def __init__(self) -> None:
        self.t = 0.0


class _VirtualSelector:
    """Delegating selector: instead of blocking, advance the virtual clock."""

    def __init__(self, inner: selectors.BaseSelector, clock: _VirtualClock) -> None:
        self._inner = inner
        self._clock = clock

    def select(self, timeout=None):
        ready = self._inner.select(0)
        if ready:
            return ready
        if timeout is None:
            raise RuntimeError("virtual-time deadlock: nothing scheduled, nothing ready")
        if timeout > 0:
            self._clock.t += timeout
        return []

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _VirtualLoop(asyncio.SelectorEventLoop):
    def __init__(self, clock: _VirtualClock) -> None:
        self._vclock = clock
        super().__init__(_VirtualSelector(selectors.DefaultSelector(), clock))

    def time(self) -> float:
        return self._vclock.t


# ---------------------------------------------------------------------------
# Capture parsing
# ---------------------------------------------------------------------------

@dataclass
class Event:
    ts: float
    channel: str
    action: str  # "partial" | "final"
    payload: dict


def parse_capture(path: Path, translator_name: str, channels: set[str] | None,
                  from_s: float | None, to_s: float | None, dedupe: bool = True):
    """Returns (events, capture_translations_counts, skipped_counts).

    dedupe drops consecutive identical payloads per topic: a capture written
    by TWO concurrent mosquitto_sub processes has every message twice
    (~0 ms apart) while the real translator received each message once.
    """
    events: list[Event] = []
    capture_published = {"partial": 0, "final": 0}
    skipped = {"no_target": 0, "empty_text": 0, "no_lang": 0, "capture_dup": 0}
    t_first: float | None = None
    last_payload: dict[str, str] = {}

    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split(" | ", 2)
            if len(parts) != 3:
                continue
            try:
                ts = float(parts[0])
            except ValueError:
                continue
            if dedupe:
                if last_payload.get(parts[1]) == parts[2]:
                    if parts[1].endswith(("/partial", "/final")):
                        skipped["capture_dup"] += 1
                    continue
                last_payload[parts[1]] = parts[2]
            topic = parts[1].split("/")
            # transcriber/out/{session}/{channel}/{action}[/translations]
            if len(topic) == 6 and topic[5] == "translations":
                if channels is None or topic[3] in channels:
                    rel = ts - t_first if t_first is not None else 0.0
                    if (from_s is None or rel >= from_s) and (to_s is None or rel <= to_s):
                        capture_published[topic[4]] = capture_published.get(topic[4], 0) + 1
                continue
            if len(topic) != 5 or topic[4] not in ("partial", "final"):
                continue
            channel = topic[3]
            if channels is not None and channel not in channels:
                continue
            if t_first is None:
                t_first = ts
            rel = ts - t_first
            if from_s is not None and rel < from_s:
                continue
            if to_s is not None and rel > to_s:
                continue
            try:
                payload = json.loads(parts[2])
            except json.JSONDecodeError:
                continue

            # Replicate mqtt_handler filtering, counting each skip
            external = payload.get("externalTranslations")
            targets = [e for e in external or [] if e.get("translator") == translator_name]
            if not targets:
                skipped["no_target"] += 1
                continue
            text = payload.get("text", "")
            if not text or not text.strip():
                skipped["empty_text"] += 1
                continue
            if not payload.get("lang"):
                skipped["no_lang"] += 1
                continue
            payload["_targets"] = targets
            events.append(Event(ts, channel, topic[4], payload))

    return events, capture_published, skipped


# ---------------------------------------------------------------------------
# Instrumented provider
# ---------------------------------------------------------------------------

CALL_CTX: contextvars.ContextVar[tuple] = contextvars.ContextVar("call_ctx", default=("?", None, "?"))


@dataclass
class CallRecord:
    t_req: float
    t_done: float
    channel: str
    segment_id: object
    action: str          # event type that caused the call
    target_lang: str
    src_chars: int
    prompt_chars: int
    in_tokens: int       # est, prompt text only
    out_tokens: int      # est, echo semantics (translation ~ source length)
    inflight_at_start: int


class MeterProvider(TranslationProvider):
    """Echo provider that meters every call and simulates request latency.

    latency = base_ms + out_tokens / decode_tps (if decode_tps > 0)
    """

    def __init__(self, base_latency_ms: float = 0.0, decode_tps: float = 0.0) -> None:
        self.base_latency_s = base_latency_ms / 1000.0
        self.decode_tps = decode_tps
        self.calls: list[CallRecord] = []
        self.inflight = 0
        self.max_inflight = 0
        # last source text sent for a PARTIAL call, per (channel, segment) — for the D6/P7 metric
        self.last_partial_src: dict[tuple, str] = {}
        self.finals_dup = 0  # final calls whose text was already translated as last partial
        self.cancelled = 0   # calls aborted mid-flight (task cancelled)

    async def translate(self, text: str, source_lang: str | None, target_lang: str) -> str:
        loop = asyncio.get_running_loop()
        channel, seg, action = CALL_CTX.get()
        src = (source_lang or "??").split("-")[0]
        tgt = target_lang.split("-")[0]
        prompt = f"<<<source>>>{src}<<<target>>>{tgt}<<<text>>>{text}"
        out_tokens = est_tokens(len(text))

        seg_key = (channel, seg, tgt)
        if action == "partial":
            self.last_partial_src[seg_key] = text
        elif text.strip() == self.last_partial_src.get(seg_key, "\0").strip():
            self.finals_dup += 1

        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        rec = CallRecord(
            t_req=loop.time(), t_done=0.0,
            channel=channel, segment_id=seg, action=action, target_lang=tgt,
            src_chars=len(text), prompt_chars=len(prompt),
            in_tokens=est_tokens(len(prompt)), out_tokens=out_tokens,
            inflight_at_start=self.inflight,
        )
        try:
            latency = self.base_latency_s
            if self.decode_tps > 0:
                latency += out_tokens / self.decode_tps
            if latency > 0:
                await asyncio.sleep(latency)
        except asyncio.CancelledError:
            self.cancelled += 1  # request aborted (key purged) — not counted as a call
            raise
        finally:
            self.inflight -= 1
        rec.t_done = loop.time()
        self.calls.append(rec)
        return text


# ---------------------------------------------------------------------------
# Replay driver
# ---------------------------------------------------------------------------

@dataclass
class PublishLog:
    partials: int = 0
    finals: int = 0

    async def publish(self, session_id, channel_id, action, payload, key):
        if action == "final":
            self.finals += 1
        else:
            self.partials += 1


async def replay(events: list[Event], pipeline: Pipeline, publog: PublishLog,
                 finals_only: bool, languages: list[str] | None,
                 handler_errors: dict[str, int],
                 progress_every_s: float = 600.0) -> None:
    loop = asyncio.get_running_loop()
    session = "replay"
    t0 = events[0].ts
    start = loop.time()
    next_progress = progress_every_s
    wall0 = _time.monotonic()

    for ev in events:
        due = start + (ev.ts - t0)
        delay = due - loop.time()
        if delay > 0:
            await asyncio.sleep(delay)
        if ev.ts - t0 >= next_progress:
            print(f"  [replay] t+{(ev.ts - t0) / 60:5.1f} min "
                  f"(wall {_time.monotonic() - wall0:5.1f}s, calls {len(pipeline.provider.calls)})",
                  file=sys.stderr)
            next_progress += progress_every_s
        if finals_only and ev.action != "final":
            continue
        targets = ([{"targetLang": lg, "translator": "replay"} for lg in languages]
                   if languages else ev.payload["_targets"])
        CALL_CTX.set((ev.channel, ev.payload.get("segmentId"), ev.action))
        try:
            if ev.action == "final":
                # mqtt_handler awaits handle_final in its message loop: a slow
                # backend blocks consumption exactly like this (queued messages
                # then arrive in a burst) — replicated here.
                await pipeline.handle_final(session, ev.channel, ev.payload, targets)
            else:
                await pipeline.handle_partial(session, ev.channel, ev.payload, targets)
        except Exception as exc:  # mqtt_handler catches broadly: message dropped
            k = f"{type(exc).__name__} (lang={ev.payload.get('lang')})"
            handler_errors[k] = handler_errors.get(k, 0) + 1

    # Drain: let debounce timers, holds and in-flight calls finish (virtual time)
    await asyncio.sleep(60.0)
    await pipeline.stop()


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def pctl(sorted_vals, p):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(p / 100 * len(sorted_vals)))]


def summarize(args, events, calls: list[CallRecord], publog: PublishLog,
              pipeline: Pipeline, capture_published, skipped, wall_s: float,
              handler_errors: dict[str, int] | None = None) -> dict:
    t0 = events[0].ts
    window_s = events[-1].ts - t0
    partials_in = sum(1 for e in events if e.action == "partial")
    finals_in = sum(1 for e in events if e.action == "final")

    # Useful tokens = final text of each segment (the archived truth)
    final_tokens_by_seg: dict[tuple, int] = {}
    final_text_by_seg: dict[tuple, str] = {}
    for e in events:
        if e.action == "final":
            k = (e.channel, e.payload.get("segmentId"))
            final_tokens_by_seg[k] = est_tokens(len(e.payload["text"]))
            final_text_by_seg[k] = e.payload["text"]

    calls_partial = [c for c in calls if c.action == "partial"]
    calls_final = [c for c in calls if c.action == "final"]
    total_in = sum(c.in_tokens for c in calls)
    total_out = sum(c.out_tokens for c in calls)
    total_useful = sum(final_tokens_by_seg.values())

    src_sorted = sorted(c.src_chars for c in calls)
    inflight_sorted = sorted(c.inflight_at_start for c in calls)

    # Per-segment accounting
    per_seg: dict[tuple, dict] = {}
    for c in calls:
        k = (c.channel, c.segment_id)
        d = per_seg.setdefault(k, {"calls": 0, "out": 0, "in": 0, "max_src": 0})
        d["calls"] += 1
        d["out"] += c.out_tokens
        d["in"] += c.in_tokens
        d["max_src"] = max(d["max_src"], c.src_chars)
    worst = max(per_seg.items(), key=lambda kv: kv[1]["out"]) if per_seg else (None, {})
    seg_calls = sorted(d["calls"] for d in per_seg.values())

    # Demand rate: 10 s buckets by request time
    buckets: dict[int, int] = {}
    for c in calls:
        buckets[int(c.t_req // 10)] = buckets.get(int(c.t_req // 10), 0) + c.out_tokens
    peak_10s = max(buckets.values()) if buckets else 0

    # 5-min timeline
    timeline = {}
    for c in calls:
        b = int(c.t_req // 300)
        d = timeline.setdefault(b, {"calls": 0, "out": 0})
        d["calls"] += 1
        d["out"] += c.out_tokens

    r = {
        "config": {
            "capture": str(args.capture),
            "channels": args.channels or "all",
            "languages": args.languages or "as-captured",
            "finals_only": args.finals_only,
            "change_threshold": args.change_threshold,
            "min_new_chars": args.min_new_chars,
            "tail_live_ms": args.tail_live_ms,
            "soft_chunk_chars": args.soft_chunk_chars,
            "max_concurrent": args.max_concurrent,
            "translate_partials": not args.no_translate_partials,
            "latency_ms": args.latency_ms,
            "decode_tps": args.decode_tps,
        },
        "window": {
            "duration_min": round(window_s / 60, 1),
            "events_partial": partials_in,
            "events_final": finals_in,
            "skipped_at_ingress": skipped,
            "handler_errors_dropped": handler_errors or {},
            "wall_seconds": round(wall_s, 1),
        },
        "model_calls": {
            "total": len(calls),
            "from_partials": len(calls_partial),
            "from_finals": len(calls_final),
            "finals_identical_to_last_partial_call": pipeline.provider.finals_dup,
            "calls_per_min": round(len(calls) / (window_s / 60), 1),
            "partials_translated_ratio": round(len(calls_partial) / partials_in, 3) if partials_in else 0,
        },
        "input": {
            "total_prompt_tokens_est": total_in,
            "chat_overhead_tokens_est": CALL_OVERHEAD_TOKENS * len(calls),
            "src_chars_mean": round(statistics.mean(src_sorted), 1) if calls else 0,
            "src_chars_p50": pctl(src_sorted, 50),
            "src_chars_p95": pctl(src_sorted, 95),
            "src_chars_max": src_sorted[-1] if calls else 0,
            "longest_input_tokens_est": est_tokens(src_sorted[-1]) if calls else 0,
        },
        "output": {
            "total_out_tokens_est": total_out,
            "useful_final_tokens_est": total_useful,
            "overhead_ratio": round(total_out / total_useful, 1) if total_useful else None,
            "avg_out_tokens_per_call": round(total_out / len(calls), 1) if calls else 0,
            "demand_tok_s_avg": round(total_out / window_s, 1),
            "demand_tok_s_peak_10s": round(peak_10s / 10, 1),
        },
        "concurrency": {
            "max_inflight": pipeline.provider.max_inflight,
            "inflight_p95_at_call": pctl(inflight_sorted, 95),
            "cancelled_inflight": pipeline.provider.cancelled,
        },
        "per_segment": {
            "segments_with_calls": len(per_seg),
            "calls_per_segment_mean": round(statistics.mean(seg_calls), 1) if seg_calls else 0,
            "calls_per_segment_p95": pctl(seg_calls, 95),
            "calls_per_segment_max": seg_calls[-1] if seg_calls else 0,
            "worst_segment": {
                "key": f"{worst[0][0]}/seg{worst[0][1]}" if worst[0] else None,
                "calls": worst[1].get("calls"),
                "out_tokens_est": worst[1].get("out"),
                "max_src_chars": worst[1].get("max_src"),
                "useful_tokens_est": final_tokens_by_seg.get(worst[0], None) if worst[0] else None,
            },
        },
        "pipeline_published": {"partials": publog.partials, "finals": publog.finals},
        "pipeline_stats": {
            f: getattr(pipeline._stats, f)
            for f in pipeline._stats.__dataclass_fields__
        } if hasattr(pipeline._stats, "__dataclass_fields__") else {},
        "scheduler_stats": pipeline.scheduler.snapshot() if hasattr(pipeline, "scheduler") else {},
        "capture_reference_published": capture_published,
        "timeline_5min": {
            f"{b * 5:>3}-{b * 5 + 5} min": {"calls": d["calls"], "out_tok_s": round(d["out"] / 300, 1)}
            for b, d in sorted(timeline.items())
        },
    }
    return r


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("capture", type=Path)
    ap.add_argument("--translator-name", default="gemma")
    ap.add_argument("--channels", help="comma-separated channel ids (default: all)")
    ap.add_argument("--from-min", type=float, default=None)
    ap.add_argument("--to-min", type=float, default=None)
    ap.add_argument("--languages", help="override target langs, comma-separated (e.g. en,de,es)")
    ap.add_argument("--finals-only", action="store_true", help="drop partials (TRANSLATE_PARTIALS=false floor)")
    # pipeline knobs (defaults = .envdefault values)
    ap.add_argument("--change-threshold", type=float, default=85.0)
    ap.add_argument("--min-new-chars", type=int, default=10)
    ap.add_argument("--stability-threshold", type=float, default=0.6)
    ap.add_argument("--max-consecutive-holds", type=int, default=2)
    ap.add_argument("--tail-live-ms", type=int, default=0,
                    help="0 = punctuation-driven only; >0 = live tail updates (latest-wins)")
    ap.add_argument("--soft-chunk-chars", type=int, default=220)
    ap.add_argument("--max-concurrent", type=int, default=8)
    ap.add_argument("--no-translate-partials", action="store_true",
                    help="eco mode: only finals are translated (pipeline-level)")
    # provider latency model
    ap.add_argument("--latency-ms", type=float, default=0.0, help="base request latency")
    ap.add_argument("--decode-tps", type=float, default=0.0, help="per-request decode tok/s (0=off)")
    ap.add_argument("--no-dedupe", action="store_true",
                    help="keep consecutive duplicate capture lines (default: dedupe)")
    ap.add_argument("--json", type=Path, default=None, help="write full JSON report here")
    args = ap.parse_args()

    channels = set(args.channels.split(",")) if args.channels else None
    languages = args.languages.split(",") if args.languages else None
    from_s = args.from_min * 60 if args.from_min is not None else None
    to_s = args.to_min * 60 if args.to_min is not None else None

    events, capture_published, skipped = parse_capture(
        args.capture, args.translator_name, channels, from_s, to_s,
        dedupe=not args.no_dedupe)
    if not events:
        sys.exit("no events matched")
    print(f"parsed {len(events)} events "
          f"({sum(1 for e in events if e.action == 'partial')} partials, "
          f"{sum(1 for e in events if e.action == 'final')} finals), "
          f"window {(events[-1].ts - events[0].ts) / 60:.1f} min", file=sys.stderr)

    provider = MeterProvider(args.latency_ms, args.decode_tps)
    publog = PublishLog()
    pipeline = Pipeline(
        provider=provider,
        publish_fn=publog.publish,
        change_threshold=args.change_threshold,
        min_new_chars=args.min_new_chars,
        stability_threshold=args.stability_threshold,
        max_consecutive_holds=args.max_consecutive_holds,
        translate_partials=not args.no_translate_partials,
        tail_live_ms=args.tail_live_ms,
        soft_chunk_chars=args.soft_chunk_chars,
        max_concurrent=args.max_concurrent,
    )

    clock = _VirtualClock()
    loop = _VirtualLoop(clock)
    asyncio.set_event_loop(loop)
    wall0 = _time.monotonic()
    handler_errors: dict[str, int] = {}
    try:
        loop.run_until_complete(replay(events, pipeline, publog, args.finals_only, languages, handler_errors))
    finally:
        loop.close()
    wall_s = _time.monotonic() - wall0

    report = summarize(args, events, provider.calls, publog, pipeline,
                       capture_published, skipped, wall_s, handler_errors)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.json:
        args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
