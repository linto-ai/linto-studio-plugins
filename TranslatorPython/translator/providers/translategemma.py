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
        max_tokens: int = 500,
    ) -> None:
        # Import here to allow non-translategemma configs to skip validation
        if not endpoint:
            from translator.config import (
                TRANSLATEGEMMA_ENDPOINT,
                TRANSLATEGEMMA_MAX_TOKENS,
                TRANSLATEGEMMA_MODEL,
            )

            endpoint = TRANSLATEGEMMA_ENDPOINT
            model = TRANSLATEGEMMA_MODEL
            max_tokens = TRANSLATEGEMMA_MAX_TOKENS

        if not endpoint:
            raise ValueError(
                "TRANSLATEGEMMA_ENDPOINT is required (e.g. http://host:8000)"
            )

        self.endpoint: str = endpoint.rstrip("/")
        self.model: str = model
        self.max_tokens: int = max_tokens
        self._client: httpx.AsyncClient = httpx.AsyncClient(timeout=30.0)

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
        }

        try:
            response = await self._client.post(
                f"{self.endpoint}/v1/chat/completions",
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"].strip()
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

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()
