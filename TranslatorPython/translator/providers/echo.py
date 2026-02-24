"""Echo provider: returns input text unchanged. For testing."""

from translator.providers.base import TranslationProvider


class EchoProvider(TranslationProvider):
    """Returns the input text unchanged."""

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return text
