"""GATE smoke-test (PHASE 2 LOT A): prove a hidden LiveKit SDK client can join a
real Meet room from linto-net AND actually receive audio frames (not just connect).

Run inside a throwaway container on linto-net against a room with a speaking
participant (see scratchpad/gate_room.py). Success = >=1 audio track AND frames>0.
Also prints the observed frame sample_rate (decides SDK-resample vs numpy).
"""
import asyncio
import os

from livekit import rtc
from livekit.api import AccessToken, VideoGrants

URL = os.environ.get("LK_URL", "ws://livekit:7880")
ROOM = os.environ["LK_ROOM"]
KEY = os.environ.get("LK_KEY", "devkey")
SECRET = os.environ.get("LK_SECRET", "secret")

stats = {"tracks": 0, "frames": 0, "rate": None, "channels": None}


def _token() -> str:
    return (
        AccessToken(KEY, SECRET)
        .with_identity("linto-smoke-hidden")
        .with_name("LinTO smoke")
        .with_grants(
            VideoGrants(
                room_join=True,
                room=ROOM,
                can_subscribe=True,
                can_publish=False,
                hidden=True,
            )
        )
        .to_jwt()
    )


async def _pump(track):
    stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
    async for ev in stream:
        stats["frames"] += 1
        if stats["rate"] is None:
            stats["rate"] = ev.frame.sample_rate
            stats["channels"] = ev.frame.num_channels
        if stats["frames"] >= 300:
            break
    await stream.aclose()


async def main():
    room = rtc.Room()

    @room.on("track_subscribed")
    def _on(track, pub, participant):
        print(f"track_subscribed kind={track.kind} from={participant.identity}", flush=True)
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            stats["tracks"] += 1
            asyncio.create_task(_pump(track))

    @room.on("track_published")
    def _onpub(pub, participant):
        print(f"track_published kind={pub.kind} from={participant.identity} sid={pub.sid}", flush=True)

    await room.connect(URL, _token(), options=rtc.RoomOptions(auto_subscribe=True))
    print(f"CONNECTED room={room.name} remote_participants={len(room.remote_participants)}", flush=True)
    for ident, p in room.remote_participants.items():
        pubs = list(p.track_publications.values())
        print(f"  participant {ident}: {len(pubs)} pubs {[ (pp.kind, pp.subscribed) for pp in pubs ]}", flush=True)
    await asyncio.sleep(20)
    print(
        f"SMOKE_RESULT tracks={stats['tracks']} frames={stats['frames']} "
        f"rate={stats['rate']} channels={stats['channels']}",
        flush=True,
    )
    await room.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
