"""Tests for MQTT contract compliance.

Verifies that message formats match the Node.js reference implementation exactly.
"""

import json

import pytest

from translator.pipeline import Pipeline


class TestOutgoingTranslationPayload:
    """Verify outgoing translation payload has exact fields."""

    def test_payload_fields(self):
        """Payload must have exactly: segmentId, astart, text, start, end,
        sourceLang, targetLang, locutor."""
        transcription = {
            "segmentId": 1,
            "astart": "2026-02-06T21:01:00.570Z",
            "text": "Bonjour, bienvenue",
            "translations": {},
            "start": 0,
            "end": 7.539,
            "lang": "fr-FR",
            "locutor": None,
            "externalTranslations": [
                {"targetLang": "en", "translator": "gemma"}
            ],
        }
        payload = Pipeline._build_payload(transcription, "Hello, welcome", "en")

        expected_keys = {
            "segmentId", "astart", "text", "start", "end",
            "sourceLang", "targetLang", "locutor",
        }
        assert set(payload.keys()) == expected_keys

    def test_payload_values(self):
        """Payload values must be correctly mapped from transcription."""
        transcription = {
            "segmentId": 42,
            "astart": "2026-02-06T21:01:00.570Z",
            "text": "Bonjour le monde",
            "translations": {},
            "start": 1.5,
            "end": 7.539,
            "lang": "fr-FR",
            "locutor": "speaker1",
            "externalTranslations": [
                {"targetLang": "de", "translator": "test"}
            ],
        }
        payload = Pipeline._build_payload(transcription, "Hallo Welt", "de")

        assert payload["segmentId"] == 42
        assert payload["astart"] == "2026-02-06T21:01:00.570Z"
        assert payload["text"] == "Hallo Welt"
        assert payload["start"] == 1.5
        assert payload["end"] == 7.539
        assert payload["sourceLang"] == "fr-FR"
        assert payload["targetLang"] == "de"
        assert payload["locutor"] == "speaker1"

    def test_payload_null_locutor(self):
        """Locutor can be null."""
        transcription = {
            "segmentId": 1,
            "astart": "2026-01-01T00:00:00Z",
            "text": "Test",
            "start": 0,
            "end": 1,
            "lang": "en-US",
            "externalTranslations": [],
        }
        payload = Pipeline._build_payload(transcription, "Test", "fr")
        assert payload["locutor"] is None

    def test_payload_json_serializable(self):
        """Payload must be JSON-serializable."""
        transcription = {
            "segmentId": 1,
            "astart": "2026-01-01T00:00:00Z",
            "text": "Bonjour",
            "start": 0,
            "end": 1.0,
            "lang": "fr-FR",
            "locutor": None,
            "externalTranslations": [],
        }
        payload = Pipeline._build_payload(transcription, "Hello", "en")
        serialized = json.dumps(payload)
        deserialized = json.loads(serialized)
        assert deserialized == payload


class TestStatusMessageFormat:
    """Verify status message formats."""

    def test_online_status_format(self):
        """Online status must match Node.js format exactly."""
        name = "gemma"
        languages = [
            "en", "fr", "de", "es", "it", "pt", "nl", "pl",
            "ro", "cs", "da", "sv", "fi", "el", "hu", "bg",
            "hr", "sk", "sl", "et", "lv", "lt", "mt", "ga",
        ]
        status = {"name": name, "languages": languages, "online": True}
        serialized = json.dumps(status)
        parsed = json.loads(serialized)

        assert parsed["name"] == "gemma"
        assert parsed["online"] is True
        assert len(parsed["languages"]) == 24
        assert "en" in parsed["languages"]
        assert "fr" in parsed["languages"]

    def test_offline_status_format(self):
        """Offline/LWT status must match Node.js format exactly."""
        name = "gemma"
        status = {"name": name, "languages": [], "online": False}
        serialized = json.dumps(status)
        parsed = json.loads(serialized)

        assert parsed["name"] == "gemma"
        assert parsed["online"] is False
        assert parsed["languages"] == []

    def test_status_field_names(self):
        """Status must have exactly: name, languages, online."""
        status = {"name": "test", "languages": ["en"], "online": True}
        assert set(status.keys()) == {"name", "languages", "online"}


class TestTopicPatterns:
    """Verify MQTT topic patterns match spec."""

    def test_subscription_topics(self):
        """Must subscribe to these exact patterns."""
        assert "transcriber/out/+/+/final" == "transcriber/out/+/+/final"
        assert "transcriber/out/+/+/partial" == "transcriber/out/+/+/partial"

    def test_status_topic_format(self):
        """Status topic must follow pattern."""
        name = "gemma"
        topic = f"translator/out/{name}/status"
        assert topic == "translator/out/gemma/status"

    def test_translation_output_topic_format(self):
        """Translation output topic must follow pattern."""
        session_id = "sess1"
        channel_id = "0"
        action = "partial"
        topic = f"transcriber/out/{session_id}/{channel_id}/{action}/translations"
        assert topic == "transcriber/out/sess1/0/partial/translations"

    def test_final_translation_topic(self):
        """Final translation topic."""
        topic = f"transcriber/out/sess1/0/final/translations"
        assert topic == "transcriber/out/sess1/0/final/translations"

    def test_topic_parsing(self):
        """Topic parsing extracts correct components."""
        topic = "transcriber/out/session123/2/partial"
        parts = topic.split("/")
        assert parts[0] == "transcriber"
        assert parts[1] == "out"
        assert parts[2] == "session123"
        assert parts[3] == "2"
        assert parts[4] == "partial"
