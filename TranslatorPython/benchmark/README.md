# TranslateGemma Benchmarks

Standalone benchmark scripts that measure translation latency and quality
of the TranslateGemma model served via a vLLM endpoint.

## Prerequisites

Install COMET dependencies (only needed for quality benchmark):

```bash
cd TranslatorPython
uv sync --extra benchmark
```

The latency benchmark only needs the base dependencies (`httpx`, `python-dotenv`).

## Configuration

Scripts read from `.env` (or `.envdefault`):

- `TRANSLATEGEMMA_ENDPOINT` -- vLLM server URL (required)
- `TRANSLATEGEMMA_MODEL` -- Model name (default: `Infomaniak-AI/vllm-translategemma-4b-it`)

## Running

### Latency Benchmark

Measures response time across 11 text lengths (1-100 words) and 8 concurrency
levels (1-16 simultaneous requests):

```bash
uv run python -m benchmark.run_latency
```

Takes approximately 30-60 minutes depending on endpoint speed.

### Quality Benchmark

Translates 50 French sentences into 5 languages (en, es, de, it, pt) and
scores with COMET (wmt22-comet-da):

```bash
uv run python -m benchmark.run_quality
```

First run downloads the COMET model (~1.8GB). COMET scoring runs on CPU.

## Results

Both scripts write output to `benchmark/results/`:

| File | Content |
|------|---------|
| `latency_results.csv` | words, concurrency, median_ms, p95_ms |
| `latency_results.md` | Median and P95 tables in markdown |
| `quality_results.csv` | language_pair, comet_score, num_sentences |
| `quality_results.md` | Quality scores in markdown |

## Interpreting Results

### Latency

- **Median**: typical response time for a single request at that concurrency
- **P95**: worst-case for 95% of requests
- Compare columns to see how latency scales with concurrent translations

### Quality

- **COMET score**: ranges roughly 0.0-1.0, higher is better
- Scores above 0.80 indicate good translation quality
- Scores above 0.85 indicate high quality comparable to production systems

## Corpus

The benchmark corpus (`corpus.py`) contains:

- 50 French oral-style sentences (meeting/transcription style)
- Reference translations for 5 target languages
- Latency calibration texts of exact word counts (1, 2, 3, 5, 10, 15, 20, 30, 50, 75, 100)
