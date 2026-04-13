from pathlib import Path

BUILTIN_CORPUS = [
    "Ladies and gentlemen, welcome to this afternoon's session.",
    "We will begin with a brief overview of the agenda.",
    "The first topic on our list is the quarterly financial report.",
    "As you can see from the figures, revenue has increased by twelve percent.",
    "This growth is primarily driven by our expansion into new markets.",
    "Let me now turn to the second topic, which is our sustainability initiative.",
    "We have committed to reducing our carbon footprint by thirty percent by 2030.",
    "Are there any questions before we move on to the next point?",
    "I would like to highlight three key achievements from last quarter.",
    "Thank you for your attention, we will now take a short break.",
]


def load_corpus(corpus_file: str | None) -> list[str]:
    if corpus_file is None:
        return BUILTIN_CORPUS

    path = Path(corpus_file)
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        raise ValueError(f"Corpus file {corpus_file} is empty")
    return lines
