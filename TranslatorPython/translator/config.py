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
TRANSLATEGEMMA_MAX_TOKENS: int = int(os.environ.get("TRANSLATEGEMMA_MAX_TOKENS", "500"))

# Gate thresholds
CHANGE_THRESHOLD: float = float(os.environ.get("CHANGE_THRESHOLD", "85"))
MIN_NEW_CHARS: int = int(os.environ.get("MIN_NEW_CHARS", "10"))
PARTIAL_DEBOUNCE_MS: int = int(os.environ.get("PARTIAL_DEBOUNCE_MS", "300"))
STABILITY_THRESHOLD: float = float(os.environ.get("STABILITY_THRESHOLD", "0.6"))
MAX_HOLD_SECONDS: float = float(os.environ.get("MAX_HOLD_SECONDS", "2.0"))
MAX_CONSECUTIVE_HOLDS: int = int(os.environ.get("MAX_CONSECUTIVE_HOLDS", "2"))

# Logging
LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO")

# 24 official EU languages (short codes, consistent with Microsoft translation codes)
EU_LANGUAGES: list[str] = [
    "en", "fr", "de", "es", "it", "pt", "nl", "pl",
    "ro", "cs", "da", "sv", "fi", "el", "hu", "bg",
    "hr", "sk", "sl", "et", "lv", "lt", "mt", "ga",
]
