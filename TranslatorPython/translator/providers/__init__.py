from translator.providers.echo import EchoProvider
from translator.providers.translategemma import TranslateGemmaProvider

PROVIDERS: dict[str, type] = {
    "echo": EchoProvider,
    "translategemma": TranslateGemmaProvider,
}


def load_provider(name: str, **kwargs):
    """Load a translation provider by name."""
    cls = PROVIDERS.get(name)
    if cls is None:
        raise ValueError(
            f"Unknown provider '{name}'. Available: {list(PROVIDERS.keys())}"
        )
    return cls(**kwargs)
