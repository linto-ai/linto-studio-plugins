import argparse
import os
from dataclasses import dataclass


@dataclass
class Config:
    session_id: str
    session_api_url: str
    broker_host: str
    broker_port: int
    broker_username: str | None
    broker_password: str | None
    partial_interval: float
    final_delay: float
    inter_segment: float
    translation_delay: float
    corpus_file: str | None
    no_loop: bool
    quiet: bool


def parse_args(argv: list[str] | None = None) -> Config:
    parser = argparse.ArgumentParser(
        description="MQTT mock producer for live transcription sessions"
    )
    parser.add_argument(
        "--session-id", required=True, help="UUID of the session to mock"
    )
    parser.add_argument(
        "--session-api-url",
        default=os.environ.get("SESSION_API_HOST", "http://localhost:8000"),
        help="Session-API base URL (default: $SESSION_API_HOST or http://localhost:8000)",
    )
    parser.add_argument(
        "--partial-interval",
        type=float,
        default=0.3,
        help="Seconds between partial messages (default: 0.3)",
    )
    parser.add_argument(
        "--final-delay",
        type=float,
        default=0.5,
        help="Seconds before final after last partial (default: 0.5)",
    )
    parser.add_argument(
        "--inter-segment",
        type=float,
        default=1.5,
        help="Seconds between segments (default: 1.5)",
    )
    parser.add_argument(
        "--translation-delay",
        type=float,
        default=0.2,
        help="Seconds before publishing translations (default: 0.2)",
    )
    parser.add_argument(
        "--corpus-file",
        default=None,
        help="Path to text file with one sentence per line (default: built-in corpus)",
    )
    parser.add_argument(
        "--no-loop",
        action="store_true",
        help="Stop after one pass through the corpus instead of looping",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Reduce logging to startup and errors only",
    )

    args = parser.parse_args(argv)

    return Config(
        session_id=args.session_id,
        session_api_url=args.session_api_url.rstrip("/"),
        broker_host=os.environ.get("BROKER_HOST", "localhost"),
        broker_port=int(os.environ.get("BROKER_PORT", "1883")),
        broker_username=os.environ.get("BROKER_USERNAME") or None,
        broker_password=os.environ.get("BROKER_PASSWORD") or None,
        partial_interval=args.partial_interval,
        final_delay=args.final_delay,
        inter_segment=args.inter_segment,
        translation_delay=args.translation_delay,
        corpus_file=args.corpus_file,
        no_loop=args.no_loop,
        quiet=args.quiet,
    )
