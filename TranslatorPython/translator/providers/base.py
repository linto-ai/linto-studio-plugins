"""Abstract translation provider interface."""

from abc import ABC, abstractmethod


class TranslationProvider(ABC):
    """Base class for all translation providers."""

    @abstractmethod
    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        """Translate text from source_lang to target_lang.

        Args:
            text: Source text to translate.
            source_lang: BCP-47 source language code (e.g. "fr-FR").
            target_lang: Short target language code (e.g. "en").

        Returns:
            Translated text.
        """
        ...
