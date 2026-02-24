"""
Latency benchmark for TranslateGemma via vLLM endpoint.

Measures response time across different text lengths and concurrency levels.

Usage:
    uv run python -m benchmark.run_latency
    uv run python benchmark/run_latency.py
"""

from __future__ import annotations

import asyncio
import csv
import os
import statistics
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Allow running as script: python benchmark/run_latency.py
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmark.corpus import LATENCY_TEXTS

# --- Configuration ---

CONCURRENCY_LEVELS = [1, 2, 4, 6, 8, 10, 12, 16]
REPETITIONS = 3
WARMUP_REQUESTS = 3

# Target languages per concurrency level
CONCURRENCY_LANGUAGES: dict[int, list[str]] = {
    1: ["en"],
    2: ["en", "es"],
    4: ["en", "es", "de", "it"],
    6: ["en", "es", "de", "it", "pt", "nl"],
    8: ["en", "es", "de", "it", "pt", "nl", "pl", "ro"],
    10: ["en", "es", "de", "it", "pt", "nl", "pl", "ro", "sv", "cs"],
    12: ["en", "es", "de", "it", "pt", "nl", "pl", "ro", "sv", "cs", "da", "el"],
    16: ["en", "es", "de", "it", "pt", "nl", "pl", "ro", "sv", "cs", "da", "el",
         "fi", "hu", "bg", "sk"],
}


# --- Core translation function ---

async def translate_one(
    client: httpx.AsyncClient,
    text: str,
    target_lang: str,
    endpoint: str,
    model: str,
) -> float:
    """Send one translation request, return response time in ms."""
    prompt = f"<<<source>>>fr<<<target>>>{target_lang}<<<text>>>{text}"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 500,
    }
    start = time.perf_counter()
    response = await client.post(f"{endpoint}/v1/chat/completions", json=payload)
    response.raise_for_status()
    elapsed_ms = (time.perf_counter() - start) * 1000
    return elapsed_ms


# --- Warmup ---

async def warmup(client: httpx.AsyncClient, endpoint: str, model: str) -> None:
    """Send a few warmup requests to prime the vLLM engine."""
    print("Warming up...")
    for i in range(WARMUP_REQUESTS):
        try:
            await translate_one(client, "Bonjour tout le monde", "en", endpoint, model)
            print(f"  warmup {i + 1}/{WARMUP_REQUESTS} done")
        except Exception as e:
            print(f"  warmup {i + 1}/{WARMUP_REQUESTS} failed: {e}")
    print()


# --- Benchmark runner ---

async def run_benchmark(endpoint: str, model: str) -> dict[tuple[int, int], dict[str, float]]:
    """
    Run the latency benchmark across all word counts and concurrency levels.

    Returns: { (word_count, concurrency): {"median": float, "p95": float} }
    """
    results: dict[tuple[int, int], dict[str, float]] = {}

    async with httpx.AsyncClient(timeout=120.0) as client:
        await warmup(client, endpoint, model)

        for word_count, text in sorted(LATENCY_TEXTS.items()):
            print(f"--- {word_count} words ---")
            for conc in CONCURRENCY_LEVELS:
                langs = CONCURRENCY_LANGUAGES[conc]
                all_times: list[float] = []

                for rep in range(REPETITIONS):
                    # Create N concurrent requests, cycling through target languages
                    tasks = []
                    for i in range(conc):
                        lang = langs[i % len(langs)]
                        tasks.append(translate_one(client, text, lang, endpoint, model))

                    try:
                        times = await asyncio.gather(*tasks)
                        all_times.extend(times)
                        print(
                            f"  words={word_count}, conc={conc}, rep={rep + 1}/{REPETITIONS}: "
                            f"median={statistics.median(times):.0f}ms, max={max(times):.0f}ms"
                        )
                    except Exception as e:
                        print(
                            f"  words={word_count}, conc={conc}, rep={rep + 1}/{REPETITIONS}: "
                            f"ERROR: {e}"
                        )

                if all_times:
                    sorted_times = sorted(all_times)
                    p95_idx = min(int(len(sorted_times) * 0.95), len(sorted_times) - 1)
                    results[(word_count, conc)] = {
                        "median": statistics.median(all_times),
                        "p95": sorted_times[p95_idx],
                    }

    return results


# --- Output functions ---

def write_csv(results: dict[tuple[int, int], dict[str, float]], output_path: Path) -> None:
    """Write results to CSV file."""
    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["words", "concurrency", "median_ms", "p95_ms"])
        for (words, conc), stats in sorted(results.items()):
            writer.writerow([words, conc, f"{stats['median']:.1f}", f"{stats['p95']:.1f}"])
    print(f"CSV written to {output_path}")


def write_markdown(results: dict[tuple[int, int], dict[str, float]], output_path: Path) -> None:
    """Write results as markdown tables (median and p95)."""
    word_counts = sorted(set(w for w, _ in results.keys()))
    conc_levels = sorted(set(c for _, c in results.keys()))

    lines: list[str] = []
    lines.append("# Latency Benchmark Results\n")

    for metric, label in [("median", "Median Latency (ms)"), ("p95", "P95 Latency (ms)")]:
        lines.append(f"## {label}\n")

        # Header row
        header = "| Words |" + "|".join(f" c={c} " for c in conc_levels) + "|"
        separator = "|-------|" + "|".join("------:" for _ in conc_levels) + "|"
        lines.append(header)
        lines.append(separator)

        for words in word_counts:
            row = f"| {words:5d} |"
            for conc in conc_levels:
                key = (words, conc)
                if key in results:
                    row += f" {results[key][metric]:6.0f} |"
                else:
                    row += "      - |"
            lines.append(row)

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

    print(f"Endpoint: {endpoint}")
    print(f"Model:    {model}")
    print(f"Concurrency levels: {CONCURRENCY_LEVELS}")
    print(f"Repetitions per config: {REPETITIONS}")
    print(f"Text lengths (words): {sorted(LATENCY_TEXTS.keys())}")
    print()

    # Run benchmark
    results = await run_benchmark(endpoint, model)

    # Write results
    results_dir = Path(__file__).resolve().parent / "results"
    os.makedirs(results_dir, exist_ok=True)

    write_csv(results, results_dir / "latency_results.csv")
    write_markdown(results, results_dir / "latency_results.md")

    # Print summary
    print("\n=== Summary ===")
    for (words, conc), stats in sorted(results.items()):
        print(f"  {words:3d} words, conc={conc:2d}: median={stats['median']:6.0f}ms, p95={stats['p95']:6.0f}ms")


if __name__ == "__main__":
    asyncio.run(main())
