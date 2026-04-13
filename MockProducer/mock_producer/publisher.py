import asyncio
import json
import logging
import random
from datetime import datetime, timezone

import aiomqtt

from mock_producer.cli import Config

logger = logging.getLogger(__name__)


def build_partials(sentence: str) -> list[str]:
    """Split a sentence into cumulative partial texts, adding 1-3 words each step."""
    words = sentence.split()
    if not words:
        return [sentence]

    partials = []
    i = 0
    while i < len(words):
        step = random.randint(1, 3)
        i = min(i + step, len(words))
        partials.append(" ".join(words[:i]))
    return partials


def build_transcription_payload(
    segment_id: int,
    astart_iso: str,
    text: str,
    start: float,
    end: float,
    lang: str,
    external_translations: list[dict] | None,
) -> dict:
    payload = {
        "segmentId": segment_id,
        "astart": astart_iso,
        "text": text,
        "start": round(start, 3),
        "end": round(end, 3),
        "lang": lang,
        "locutor": None,
    }
    # Only include externalTranslations if non-empty (cf ASREvents.js:38-40)
    if external_translations:
        payload["externalTranslations"] = external_translations
    return payload


def build_translation_payload(
    segment_id: int,
    astart_iso: str,
    text: str,
    start: float,
    end: float,
    source_lang: str,
    target_lang: str,
    is_final: bool,
    mode: str,
) -> dict:
    return {
        "segmentId": segment_id,
        "astart": astart_iso,
        "text": f"[MOCK-{target_lang}] {text}",
        "start": round(start, 3),
        "end": round(end, 3),
        "sourceLang": source_lang,
        "targetLang": target_lang,
        "locutor": None,
        "final": is_final,
        "mode": mode,
    }


async def publish(
    client: aiomqtt.Client,
    topic: str,
    payload: dict,
    quiet: bool = False,
) -> None:
    await client.publish(topic, json.dumps(payload), qos=1)
    if not quiet:
        text_preview = payload.get("text", "")[:50]
        logger.info("%s  seg=%s  %s", topic, payload.get("segmentId"), text_preview)


async def publish_translations(
    client: aiomqtt.Client,
    topic_base: str,
    action: str,
    segment_id: int,
    astart_iso: str,
    text: str,
    start: float,
    end: float,
    lang: str,
    discrete: list[dict],
    external: list[dict],
    config: Config,
) -> None:
    """Publish translation messages for all configured translations."""
    if not discrete and not external:
        return

    await asyncio.sleep(config.translation_delay)

    topic = f"{topic_base}/{action}/translations"
    is_final = action == "final"

    # Discrete first (published by Transcriber in real system)
    for t in discrete:
        payload = build_translation_payload(
            segment_id, astart_iso, text, start, end,
            lang, t["target"], is_final, "discrete",
        )
        await publish(client, topic, payload, config.quiet)

    # External second (published by TranslatorPython in real system)
    for t in external:
        payload = build_translation_payload(
            segment_id, astart_iso, text, start, end,
            lang, t["target"], is_final, "external",
        )
        await publish(client, topic, payload, config.quiet)


async def channel_worker(
    client: aiomqtt.Client,
    session_id: str,
    channel: dict,
    corpus: list[str],
    config: Config,
    stop_event: asyncio.Event,
) -> None:
    channel_id = channel["id"]
    lang = (channel.get("languages") or ["en-US"])[0]
    translations = channel.get("translations") or []
    discrete = [t for t in translations if t.get("mode") == "discrete"]
    external = [t for t in translations if t.get("mode") == "external"]
    external_payload = [
        {"targetLang": t["target"], "translator": t["translator"]}
        for t in external
    ]

    channel_name = channel.get("name") or f"channel-{channel_id}"
    logger.info(
        "[%s] Starting worker: lang=%s, %d discrete + %d external translations",
        channel_name, lang, len(discrete), len(external),
    )

    astart = datetime.now(timezone.utc)
    astart_iso = astart.strftime("%Y-%m-%dT%H:%M:%S.") + f"{astart.microsecond // 1000:03d}Z"
    segment_id = 1
    topic_base = f"transcriber/out/{session_id}/{channel_id}"

    while not stop_event.is_set():
        for sentence in corpus:
            if stop_event.is_set():
                break

            segment_start = (datetime.now(timezone.utc) - astart).total_seconds()
            partials = build_partials(sentence)

            for i, text in enumerate(partials):
                if stop_event.is_set():
                    break

                end_time = (datetime.now(timezone.utc) - astart).total_seconds()

                payload = build_transcription_payload(
                    segment_id, astart_iso, text, segment_start, end_time,
                    lang, external_payload if external_payload else None,
                )
                await publish(client, f"{topic_base}/partial", payload, config.quiet)

                await publish_translations(
                    client, topic_base, "partial",
                    segment_id, astart_iso, text, segment_start, end_time,
                    lang, discrete, external, config,
                )

                is_last = i == len(partials) - 1
                delay = config.final_delay if is_last else config.partial_interval
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=delay)
                    break  # stop_event was set
                except asyncio.TimeoutError:
                    pass  # normal: delay elapsed

            if stop_event.is_set():
                break

            # Publish final
            end_time = (datetime.now(timezone.utc) - astart).total_seconds()
            payload = build_transcription_payload(
                segment_id, astart_iso, sentence, segment_start, end_time,
                lang, external_payload if external_payload else None,
            )
            await publish(client, f"{topic_base}/final", payload, config.quiet)

            await publish_translations(
                client, topic_base, "final",
                segment_id, astart_iso, sentence, segment_start, end_time,
                lang, discrete, external, config,
            )

            segment_id += 1

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=config.inter_segment)
                break
            except asyncio.TimeoutError:
                pass

        if config.no_loop:
            break

    logger.info("[%s] Worker stopped (segmentId=%d)", channel_name, segment_id)
