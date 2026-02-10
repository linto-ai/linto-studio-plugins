"""
COMET quality benchmark for TranslateGemma via vLLM endpoint.

Translates 50 French sentences into 5 target languages and scores
translation quality using the COMET metric.

Usage:
    uv run python -m benchmark.run_quality
    uv run python benchmark/run_quality.py

Prerequisites:
    uv sync --extra benchmark
"""

from __future__ import annotations

import asyncio
import csv
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Allow running as script: python benchmark/run_quality.py
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmark.corpus import FRENCH_SENTENCES, REFERENCE_TRANSLATIONS

TARGET_LANGUAGES = ["en", "es", "de", "it", "pt"]
REQUEST_DELAY = 0.1  # seconds between sequential requests


# --- Translation ---

async def translate_one(
    client: httpx.AsyncClient,
    text: str,
    target_lang: str,
    endpoint: str,
    model: str,
) -> str | None:
    """Translate a single sentence. Returns None on failure."""
    prompt = f"<<<source>>>fr<<<target>>>{target_lang}<<<text>>>{text}"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 500,
    }
    try:
        response = await client.post(f"{endpoint}/v1/chat/completions", json=payload)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"    ERROR translating to {target_lang}: {e}")
        return None


async def translate_corpus(
    endpoint: str,
    model: str,
    target_lang: str,
) -> tuple[list[str], list[str], list[str]]:
    """
    Translate all French sentences to target_lang sequentially.

    Returns (sources, hypotheses, references) with failed sentences excluded.
    """
    sources: list[str] = []
    hypotheses: list[str] = []
    references: list[str] = []

    refs = REFERENCE_TRANSLATIONS[target_lang]

    async with httpx.AsyncClient(timeout=120.0) as client:
        for i, (src, ref) in enumerate(zip(FRENCH_SENTENCES, refs)):
            print(f"  Translating fr->{target_lang}: {i + 1}/{len(FRENCH_SENTENCES)}...", end="\r")

            translation = await translate_one(client, src, target_lang, endpoint, model)

            if translation is not None:
                sources.append(src)
                hypotheses.append(translation)
                references.append(ref)

            # Small delay to be gentle on sequential quality runs
            await asyncio.sleep(REQUEST_DELAY)

    print(f"  Translating fr->{target_lang}: {len(hypotheses)}/{len(FRENCH_SENTENCES)} succeeded")
    return sources, hypotheses, references


# --- COMET scoring ---

def score_with_comet(
    sources: list[str],
    hypotheses: list[str],
    references: list[str],
) -> float:
    """Score translations using COMET (CPU-only). Returns system score."""
    from comet import download_model, load_from_checkpoint

    model_path = download_model("Unbabel/wmt22-comet-da")
    model = load_from_checkpoint(model_path)

    data = [
        {"src": src, "mt": hyp, "ref": ref}
        for src, hyp, ref in zip(sources, hypotheses, references)
    ]
    output = model.predict(data, batch_size=8, gpus=0)
    return output.system_score


# --- Output ---

def write_csv(
    results: dict[str, dict],
    output_path: Path,
) -> None:
    """Write quality results to CSV."""
    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["language_pair", "comet_score", "num_sentences"])
        for lang, info in sorted(results.items()):
            writer.writerow([
                f"fr->{lang}",
                f"{info['score']:.4f}",
                info["num_sentences"],
            ])
    print(f"CSV written to {output_path}")


def write_markdown(
    results: dict[str, dict],
    output_path: Path,
) -> None:
    """Write quality results as markdown table."""
    lines: list[str] = []
    lines.append("# Translation Quality Results (COMET)\n")
    lines.append("| Language Pair | COMET Score | Sentences |")
    lines.append("|---------------|-------------|-----------|")

    for lang, info in sorted(results.items()):
        lines.append(f"| fr->{lang:2s}         | {info['score']:.4f}      | {info['num_sentences']:9d} |")

    lines.append("")

    with open(output_path, "w") as f:
        f.write("\n".join(lines))
    print(f"Markdown written to {output_path}")


# --- Main ---

async def main() -> None:
    # Load environment
    base_dir = Path(__file__).resolve().parent.parent
    load_dotenv(base_dir / ".envdefault")
    load_dotenv(base_dir / ".env", override=True)

    endpoint = os.environ.get("TRANSLATEGEMMA_ENDPOINT", "")
    model = os.environ.get("TRANSLATEGEMMA_MODEL", "Infomaniak-AI/vllm-translategemma-4b-it")

    print(f"Endpoint:         {endpoint}")
    print(f"Model:            {model}")
    print(f"Sentences:        {len(FRENCH_SENTENCES)}")
    print(f"Target languages: {TARGET_LANGUAGES}")
    print()

    # Translation cache: skip translation if results already saved
    results_dir = Path(__file__).resolve().parent / "results"
    os.makedirs(results_dir, exist_ok=True)
    cache_path = results_dir / "translations_cache.json"

    cached: dict[str, list[str]] = {}
    if cache_path.exists():
        cached = json.loads(cache_path.read_text())
        print(f"Loaded translation cache ({len(cached)} languages)\n")

    # Translate all pairs
    all_results: dict[str, dict] = {}
    translations: dict[str, tuple[list[str], list[str], list[str]]] = {}

    for lang in TARGET_LANGUAGES:
        if lang in cached:
            print(f"--- fr -> {lang} --- (cached)")
            hyps = cached[lang]
            refs = REFERENCE_TRANSLATIONS[lang]
            # Rebuild triples (only non-None entries)
            sources, hypotheses, references = [], [], []
            for src, hyp, ref in zip(FRENCH_SENTENCES, hyps, refs):
                if hyp is not None:
                    sources.append(src)
                    hypotheses.append(hyp)
                    references.append(ref)
            print(f"  {len(hypotheses)}/{len(FRENCH_SENTENCES)} sentences from cache")
        else:
            print(f"--- fr -> {lang} ---")
            start = time.perf_counter()
            sources, hypotheses, references = await translate_corpus(endpoint, model, lang)
            elapsed = time.perf_counter() - start
            print(f"  Completed in {elapsed:.1f}s")

            # Save to cache (preserve None for failed translations)
            refs = REFERENCE_TRANSLATIONS[lang]
            hyp_map = dict(zip(sources, hypotheses))
            cached[lang] = [hyp_map.get(src) for src in FRENCH_SENTENCES]
            cache_path.write_text(json.dumps(cached, ensure_ascii=False, indent=2))

        translations[lang] = (sources, hypotheses, references)

    # Score with COMET
    print("\n--- COMET Scoring ---")
    print("Loading COMET model (first run downloads ~1.8GB)...")

    for lang in TARGET_LANGUAGES:
        sources, hypotheses, references = translations[lang]
        if not hypotheses:
            print(f"  fr->{lang}: No successful translations, skipping")
            all_results[lang] = {"score": 0.0, "num_sentences": 0}
            continue

        print(f"  Scoring fr->{lang} ({len(hypotheses)} sentences)...")
        score = score_with_comet(sources, hypotheses, references)
        all_results[lang] = {"score": score, "num_sentences": len(hypotheses)}
        print(f"  fr->{lang}: COMET = {score:.4f}")

    # Write results
    write_csv(all_results, results_dir / "quality_results.csv")
    write_markdown(all_results, results_dir / "quality_results.md")

    # Print summary
    print("\n=== Summary ===")
    for lang, info in sorted(all_results.items()):
        print(f"  fr->{lang}: COMET = {info['score']:.4f} ({info['num_sentences']} sentences)")


if __name__ == "__main__":
    asyncio.run(main())
