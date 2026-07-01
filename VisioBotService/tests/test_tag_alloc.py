"""Standalone tests for LiveKitBot's per-stream tag allocator (Bug #4) and the
mid-call rename propagation (Bug #7).

Runs WITHOUT the heavy runtime deps (livekit / websockets are not installed in
CI for the pure-logic tests), by stubbing those modules in sys.modules before
importing bot.livekit_bot. The LiveKitBot instance is built with __new__ so the
real __init__ (which opens a Room / WS) never runs; only the tag-allocator state
and two collaborator stubs are wired up by hand.

Run:  python3 VisioBotService/tests/test_tag_alloc.py
(or via pytest:  pytest VisioBotService/tests/test_tag_alloc.py)
"""
import os
import sys
import types

# --- make `bot` importable and stub the not-installed runtime deps -----------
_HERE = os.path.dirname(os.path.abspath(__file__))
_SVC = os.path.dirname(_HERE)  # VisioBotService/
if _SVC not in sys.path:
    sys.path.insert(0, _SVC)


def _stub(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# livekit / livekit.api
_lk = _stub("livekit")
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
             RoomOptions=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
# websockets (imported by transcriber_stream)
_stub("websockets", connect=None)

from bot.livekit_bot import LiveKitBot, OVERFLOW_TAG  # noqa: E402


# --- helpers -----------------------------------------------------------------
class _RecordingTranscriber:
    """Captures send_participant(...) calls and exposes per_stream."""

    def __init__(self, per_stream=False):
        self.per_stream = per_stream
        self.calls = []  # list of (action, pid, name, tag)

    def send_participant(self, action, pid, name, tag=None):
        self.calls.append((action, pid, name, tag))


class _NoopMixer:
    def remove_participant(self, ident):
        pass

    def update_name(self, ident, name):
        pass


class _P:
    def __init__(self, identity, name=None):
        self.identity = identity
        self.name = name


def _make_bot(per_stream=False):
    """A LiveKitBot with only the tag-allocator state + stub collaborators."""
    bot = LiveKitBot.__new__(LiveKitBot)
    bot._tags = {}
    bot._free_tags = []
    bot._next_tag = 0
    bot._participants = {}
    bot.transcriber = _RecordingTranscriber(per_stream=per_stream)
    bot.mixer = _NoopMixer()
    return bot


# --- tests -------------------------------------------------------------------
def test_sequential_allocation_and_stability():
    bot = _make_bot()
    assert bot._tag_for("alice") == 0
    assert bot._tag_for("bob") == 1
    assert bot._tag_for("carol") == 2
    # known identity returns a STABLE tag (idempotent)
    assert bot._tag_for("alice") == 0
    assert bot._tag_for("bob") == 1
    print("ok: sequential allocation + stable known-identity tag")


def test_overflow_tag_is_reserved_and_no_wrap():
    bot = _make_bot()
    tags = [bot._tag_for(f"id-{i}") for i in range(255)]
    # First 255 distinct identities occupy exactly 0..254 — never the sentinel.
    assert tags == list(range(255)), tags[:5]
    assert OVERFLOW_TAG not in tags
    assert max(tags) == 254
    # 256th and beyond get OVERFLOW_TAG (255), never wrap back to 0/1/...
    assert bot._tag_for("id-255") == OVERFLOW_TAG
    assert bot._tag_for("id-256") == OVERFLOW_TAG
    # the wrap bug would have produced 0 here — assert it did not.
    assert bot._tag_for("id-255") != 0
    print(f"ok: 0..254 assigned, overflow={OVERFLOW_TAG}, no wrap to 0")


def test_disconnect_recycles_lowest_tag():
    bot = _make_bot()
    bot._register_state = None  # unused; populate via _tag_for + _participants
    for ident in ("a", "b", "c"):
        bot._participants[ident] = ident
        bot._tag_for(ident)
    assert (bot._tags["a"], bot._tags["b"], bot._tags["c"]) == (0, 1, 2)

    # b leaves -> tag 1 returns to the pool, 'leave' carries that tag.
    bot._on_participant_disconnected(_P("b"))
    assert "b" not in bot._tags
    assert ("leave", "b", "b", 1) in bot.transcriber.calls
    assert 1 in bot._free_tags

    # next NEW identity reuses the freed low tag (1), not 3.
    assert bot._tag_for("d") == 1
    assert bot._free_tags == []
    # a brand-new identity after the pool is empty grows the high-water mark.
    assert bot._tag_for("e") == 3
    print("ok: disconnect frees tag -> reused by next joiner; leave carries tag")


def test_disconnect_frees_lowest_first():
    bot = _make_bot()
    for ident in ("a", "b", "c"):
        bot._participants[ident] = ident
        bot._tag_for(ident)
    bot._on_participant_disconnected(_P("c"))  # frees 2
    bot._on_participant_disconnected(_P("a"))  # frees 0
    # min-heap hands out the LOWEST freed tag first.
    assert bot._tag_for("x") == 0
    assert bot._tag_for("y") == 2
    print("ok: free-list is a min-heap (lowest freed tag reused first)")


def test_overflow_tag_not_recycled():
    bot = _make_bot()
    # fill 0..254, then two overflow participants share OVERFLOW_TAG.
    for i in range(255):
        ident = f"id-{i}"
        bot._participants[ident] = ident
        bot._tag_for(ident)
    bot._participants["ov1"] = "ov1"
    bot._participants["ov2"] = "ov2"
    assert bot._tag_for("ov1") == OVERFLOW_TAG
    assert bot._tag_for("ov2") == OVERFLOW_TAG
    # one overflow participant leaves: the shared sentinel must NOT enter the
    # free-list (it is not owned by a single identity).
    bot._on_participant_disconnected(_P("ov1"))
    assert OVERFLOW_TAG not in bot._free_tags
    # ov2 still maps to overflow.
    assert bot._tag_for("ov2") == OVERFLOW_TAG
    print("ok: OVERFLOW_TAG is shared and never recycled into the free-list")


def test_rename_emits_control_in_perstream():
    bot = _make_bot(per_stream=True)
    bot._participants["u1"] = "Old Name"
    bot._tag_for("u1")  # tag 0
    bot._on_participant_name_changed(_P("u1", name="New Name"))
    assert bot._participants["u1"] == "New Name"
    assert ("rename", "u1", "New Name", 0) in bot.transcriber.calls
    print("ok: perStream rename emits ('rename', id, newName, tag) control msg")


def test_rename_no_control_in_mixed_mode():
    bot = _make_bot(per_stream=False)
    bot._participants["u1"] = "Old Name"
    bot._tag_for("u1")
    bot._on_participant_name_changed(_P("u1", name="New Name"))
    assert bot._participants["u1"] == "New Name"
    # mixed mode relies on the mixer, not a control message.
    assert not any(c[0] == "rename" for c in bot.transcriber.calls)
    print("ok: mixed mode rename does not emit a control message")


_TESTS = [
    test_sequential_allocation_and_stability,
    test_overflow_tag_is_reserved_and_no_wrap,
    test_disconnect_recycles_lowest_tag,
    test_disconnect_frees_lowest_first,
    test_overflow_tag_not_recycled,
    test_rename_emits_control_in_perstream,
    test_rename_no_control_in_mixed_mode,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
