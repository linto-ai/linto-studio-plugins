"""TranslateGemma provider: vLLM-backed translation via OpenAI-compatible API."""

import logging

import httpx

from translator.providers.base import TranslationProvider

logger = logging.getLogger(__name__)


class TranslateGemmaProvider(TranslationProvider):
    """Translates text using TranslateGemma via a vLLM endpoint."""

    def __init__(
        self,
        endpoint: str = "",
        model: str = "Infomaniak-AI/vllm-translategemma-4b-it",
        max_tokens: int = 160,
        temperature: float = 0.0,
    ) -> None:
        # Import here to allow non-translategemma configs to skip validation
        if not endpoint:
            from translator.config import (
                TRANSLATEGEMMA_ENDPOINT,
                TRANSLATEGEMMA_MAX_TOKENS,
                TRANSLATEGEMMA_MODEL,
                TRANSLATEGEMMA_TEMPERATURE,
            )

            endpoint = TRANSLATEGEMMA_ENDPOINT
            model = TRANSLATEGEMMA_MODEL
            max_tokens = TRANSLATEGEMMA_MAX_TOKENS
            temperature = TRANSLATEGEMMA_TEMPERATURE

        if not endpoint:
            raise ValueError(
                "TRANSLATEGEMMA_ENDPOINT is required (e.g. http://host:8000)"
            )

        self.endpoint: str = endpoint.rstrip("/")
        self.model: str = model
        self.max_tokens: int = max_tokens
        self.temperature: float = temperature
        self._client: httpx.AsyncClient = httpx.AsyncClient(timeout=30.0)
        # Cumulative token usage, reported by the pipeline stats loop
        self.prompt_tokens: int = 0
        self.completion_tokens: int = 0
        self.requests: int = 0
        self.truncated: int = 0

    async def translate(self, text: str, source_lang: str | None, target_lang: str) -> str:
        # TranslateGemma uses short codes (fr, en, de) not BCP-47 (fr-FR)
        if not source_lang:
            raise ValueError("source_lang is required for translation")
        src = source_lang.split("-")[0]
        tgt = target_lang.split("-")[0]

        prompt = f"<<<source>>>{src}<<<target>>>{tgt}<<<text>>>{text}"

        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }

        try:
            response = await self._client.post(
                f"{self.endpoint}/v1/chat/completions",
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "TranslateGemma API error: %s %s",
                exc.response.status_code,
                exc.response.reason_phrase,
            )
            raise
        except Exception:
            logger.exception("TranslateGemma request failed")
            raise

        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            self.truncated += 1
            logger.warning(
                "TranslateGemma output truncated at max_tokens=%d (input %d chars): "
                "the published translation is incomplete",
                self.max_tokens, len(text),
            )
        usage = data.get("usage") or {}
        self.requests += 1
        self.prompt_tokens += usage.get("prompt_tokens", 0) or 0
        self.completion_tokens += usage.get("completion_tokens", 0) or 0

        return choice["message"]["content"].strip()

    def usage_snapshot(self) -> dict[str, int]:
        return {
            "requests": self.requests,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "truncated": self.truncated,
        }

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()
