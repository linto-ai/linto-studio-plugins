"""Segment assembler: prefix freezing of the cumulative partial text.

Maintains, for one (session, channel) segment stream, the decomposition of the
cumulative ASR text into `(frozen sentences..., tail)`:

- a sentence closed by strong punctuation is FROZEN: it will be translated
  exactly once and never re-segmented nor re-translated;
- the tail is whatever follows the last frozen sentence (usually the sentence
  currently being spoken);
- when the tail grows beyond `soft_chunk_chars` without any punctuation
  (continuous speech, ASR not punctuating), it is soft-chunked at the last
  weak separator (comma, then space) so unpunctuated speech still freezes.

Pure and synchronous: no I/O, fully unit-testable. One instance per
(session, channel); the segmentation is language-source-driven, so all target
languages share it.
"""

import logging
import re
from dataclasses import dataclass, field

from translator.gates import sentence_gate

logger = logging.getLogger(__name__)

# Tail ends a sentence: strong punctuation, optionally followed by closing
# quotes/brackets and trailing spaces. NOT preceded by a digit ("3." may be
# the start of "3.5").
_TAIL_COMPLETE_RE = re.compile(r"(?<![0-9])[.!?…]['\"»”’)\]]*\s*$")
# Weak separators for soft-chunking, by preference order.
_WEAK_CUT_RE = re.compile(r"[,;:]\s")


@dataclass
class AssemblerResult:
    """Outcome of one update() call."""

    newly_frozen: list[tuple[int, str]] = field(default_factory=list)  # (global index, text)
    tail: str = ""
    reset: bool = False  # the ASR rewrote already-frozen text: all frozen state is void


class SegmentAssembler:
    """Decomposes a cumulative segment text into frozen sentences + tail."""

    def __init__(self, soft_chunk_chars: int = 220) -> None:
        self.soft_chunk_chars = soft_chunk_chars
        self.frozen_src: list[str] = []
        self.resets = 0
        self._consumed_text: str = ""  # exact prefix of the cumulative text already frozen

    @property
    def consumed_len(self) -> int:
        return len(self._consumed_text)

    @property
    def consumed_text(self) -> str:
        """Exact prefix of the cumulative text covered by the frozen sentences."""
        return self._consumed_text

    def update(self, cumulative_text: str, lang: str | None) -> AssemblerResult:
        result = AssemblerResult()

        # Guard: the ASR rewrote text we already froze — void everything and
        # start over from the current cumulative text (rare).
        if self._consumed_text and not cumulative_text.startswith(self._consumed_text):
            logger.warning(
                "[assembler] consumed prefix rewritten (%d chars), resetting segment state",
                len(self._consumed_text),
            )
            self.resets += 1
            self.frozen_src = []
            self._consumed_text = ""
            result.reset = True

        base = len(self._consumed_text)
        remaining = cumulative_text[base:]
        if not remaining.strip():
            result.tail = ""
            return result

        spans = self._segment_spans(remaining, lang)  # covers all of `remaining`

        # All spans except the last are complete sentences. The last one is
        # complete too if it ends with strong punctuation.
        last_start, _ = spans[-1]
        last_text = remaining[last_start:]
        if _TAIL_COMPLETE_RE.search(last_text):
            complete = spans
            tail_abs_start = base + len(remaining)
        else:
            complete = spans[:-1]
            tail_abs_start = base + last_start

        for start, end in complete:
            sentence = remaining[start:end].strip()
            if sentence:
                result.newly_frozen.append((len(self.frozen_src), sentence))
                self.frozen_src.append(sentence)

        tail = cumulative_text[tail_abs_start:]

        # Soft-chunking: unpunctuated tail longer than the budget gets cut at
        # the last weak separator (comma…), else the last space, and frozen.
        while len(tail) > self.soft_chunk_chars:
            window = tail[: self.soft_chunk_chars]
            cut = 0
            for m in _WEAK_CUT_RE.finditer(window):
                cut = m.end()
            if cut == 0:
                cut = window.rfind(" ") + 1
            if cut <= 0:
                break  # one giant token, nothing sane to cut on
            chunk = tail[:cut].strip()
            if chunk:
                result.newly_frozen.append((len(self.frozen_src), chunk))
                self.frozen_src.append(chunk)
            tail_abs_start += cut
            tail = tail[cut:]

        self._consumed_text = cumulative_text[:tail_abs_start]
        result.tail = tail.strip()
        return result

    @staticmethod
    def _segment_spans(text: str, lang: str | None) -> list[tuple[int, int]]:
        """Sentence spans over `text` via pySBD (char_span), regex fallback.

        Never raises: any segmentation failure degrades to "one single span".
        """
        short = lang.split("-")[0] if lang else None
        if short in sentence_gate.PYSBD_LANGUAGES:
            try:
                import pysbd

                key = f"span:{short}"
                seg = _span_segmenters.get(key)
                if seg is None:
                    seg = pysbd.Segmenter(language=short, clean=False, char_span=True)
                    _span_segmenters[key] = seg
                spans = [(s.start, s.end) for s in seg.segment(text)]
                if spans:
                    return spans
            except Exception:
                logger.exception("[assembler] pySBD failed on lang=%s, falling back", lang)
        # Regex fallback: split after strong punctuation + space
        spans: list[tuple[int, int]] = []
        start = 0
        for m in re.finditer(r"(?<![0-9])[.!?…]['\"»”’)\]]*\s+", text):
            spans.append((start, m.end()))
            start = m.end()
        spans.append((start, len(text)))
        return spans


_span_segmenters: dict[str, object] = {}
