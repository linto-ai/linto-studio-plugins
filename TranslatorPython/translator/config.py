"""Environment variable loading with defaults."""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .envdefault first (base defaults), then .env (overrides)
_base_dir = Path(__file__).resolve().parent.parent
load_dotenv(_base_dir / ".envdefault")
load_dotenv(_base_dir / ".env", override=True)

# Required
TRANSLATOR_NAME: str = os.environ.get("TRANSLATOR_NAME", "")
if not TRANSLATOR_NAME:
    print("TRANSLATOR_NAME environment variable is required", file=sys.stderr)
    sys.exit(1)

# MQTT broker
BROKER_HOST: str = os.environ.get("BROKER_HOST", "localhost")
BROKER_PORT: int = int(os.environ.get("BROKER_PORT", "1883"))

# Provider
TRANSLATION_PROVIDER: str = os.environ.get("TRANSLATION_PROVIDER", "echo")

# TranslateGemma
TRANSLATEGEMMA_ENDPOINT: str = os.environ.get("TRANSLATEGEMMA_ENDPOINT", "")
TRANSLATEGEMMA_MODEL: str = os.environ.get(
    "TRANSLATEGEMMA_MODEL", "Infomaniak-AI/vllm-translategemma-4b-it"
)
# One sentence/chunk (<= SOFT_CHUNK_CHARS source chars) fits well within 160
TRANSLATEGEMMA_MAX_TOKENS: int = int(os.environ.get("TRANSLATEGEMMA_MAX_TOKENS", "160"))
TRANSLATEGEMMA_TEMPERATURE: float = float(os.environ.get("TRANSLATEGEMMA_TEMPERATURE", "0.0"))

# Pipeline (prefix freezing)
TRANSLATE_PARTIALS: bool = os.environ.get("TRANSLATE_PARTIALS", "true").lower() not in (
    "false", "0", "no", "off",
)
SOFT_CHUNK_CHARS: int = int(os.environ.get("SOFT_CHUNK_CHARS", "220"))
TAIL_LIVE_MS: int = int(os.environ.get("TAIL_LIVE_MS", "0"))
MAX_CONCURRENT_TRANSLATIONS: int = int(os.environ.get("MAX_CONCURRENT_TRANSLATIONS", "8"))
STATE_TTL_SECONDS: float = float(os.environ.get("STATE_TTL_SECONDS", "600"))

# Gate thresholds (tail only)
CHANGE_THRESHOLD: float = float(os.environ.get("CHANGE_THRESHOLD", "85"))
MIN_NEW_CHARS: int = int(os.environ.get("MIN_NEW_CHARS", "10"))
STABILITY_THRESHOLD: float = float(os.environ.get("STABILITY_THRESHOLD", "0.6"))
MAX_CONSECUTIVE_HOLDS: int = int(os.environ.get("MAX_CONSECUTIVE_HOLDS", "2"))

# Deprecated (ignored, kept so old deployments don't crash on startup)
PARTIAL_DEBOUNCE_MS: int = int(os.environ.get("PARTIAL_DEBOUNCE_MS", "0"))
MAX_HOLD_SECONDS: float = float(os.environ.get("MAX_HOLD_SECONDS", "0"))
if os.environ.get("PARTIAL_DEBOUNCE_MS") or os.environ.get("MAX_HOLD_SECONDS"):
    print(
        "WARNING: PARTIAL_DEBOUNCE_MS / MAX_HOLD_SECONDS are deprecated and ignored "
        "(prefix-freezing pipeline; see TAIL_LIVE_MS)",
        file=sys.stderr,
    )

# Logging
LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO")

# 24 official EU languages (short codes, consistent with Microsoft translation codes)
EU_LANGUAGES: list[str] = [
    "en", "fr", "de", "es", "it", "pt", "nl", "pl",
    "ro", "cs", "da", "sv", "fi", "el", "hu", "bg",
    "hr", "sk", "sl", "et", "lv", "lt", "mt", "ga",
]
