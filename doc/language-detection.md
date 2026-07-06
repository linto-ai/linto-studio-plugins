# Language detection

The Transcriber tags every partial and final with a source language
(`lang`, BCP-47, e.g. `fr-FR`). It is carried in the MQTT payload and used
downstream as the **source language for live translation**, so it must be
stable and correct. This document explains how it works, the contract with the
partial/final protocol, and the reproducible procedure used to evaluate it.

Code: [`ASR/lang-detect.js`](../Transcriber/ASR/lang-detect.js). Tests:
[`tests/test_lang_detect.js`](../Transcriber/tests/test_lang_detect.js).

## The problem: `franc` on short segments

Detection uses [`franc`](https://github.com/wooorm/franc), a trigram detector,
constrained to the profile's candidate languages (`only`). Trigram statistics
need volume; on the short finals the stream emits ("Allô, oui, c'est bien.")
they are unreliable. A French final routinely trigram-matches Spanish, German,
Dutch or English.

Measured on 400 short real sentences per language (see the procedure below),
**raw per-segment `franc` mislabels ~13% of them** (σ 3.7% across languages).

## The fix: a rolling window

Instead of looking at one short segment, the detector runs `franc` on a
**rolling window of the recent transcript** (default 180 characters). `franc` is
reliable once it has ~150-200 characters, which the window always has after
warm-up.

- A one-segment ghost never dominates the window, so it is smoothed away.
- A real, sustained switch fills the window with the new language and flips
  naturally, with a latency of roughly one window's worth of new speech.

On the same corpus this drops the mislabel rate to **~0.05%** (σ 0.10%) while
still following a French→English switch within a few segments. Note that simply
hardening the old per-segment gate to reach 0% mislabels made it **never**
switch language — the window wins on both axes.

## Configuration

Thresholds live in `DEFAULT_THRESHOLDS` and can be overridden per detector
(`createLangDetector(candidates, { thresholds })`) or via env:

| Threshold | Default | Env | Meaning |
|---|---|---|---|
| `windowChars` | 180 | `ASR_LANG_WINDOW_CHARS` | Rolling window size. Bigger = fewer mislabels, slower switches. |
| `minChars` | 12 | — | A **partial** below this window size proposes nothing new (keeps the last language). |
| `recheckChars` | 40 | — | On partials, re-run `franc` only after the window grows this much. |

## Contract with the partial/final protocol

The `lang` field is `BCP-47 | null`. This is unchanged from the previous
detector; `null` was always a possible value.

- **Finals always attempt detection** (the `minChars` guard applies to partials
  only). A final never carries a *less* determined language than before.
- **Partials are coherent and sticky.** Once a session has resolved a language,
  every partial proposes that language — never a ghost, even for a prefix
  `franc` would misread on its own (the window still holds the established
  context).
- The only `null` window is the very start of a session, before ~12 characters
  have accumulated. The old detector had this too, with a *higher* floor (30
  chars). Measured on the corpus (realistic partials-then-final stream):
  **0 null finals** for both old and new; **fewer** null partials for the new
  (10 vs 15 out of 1369, all in the first word or two of a session).

## Evaluation procedure

Reproducible benchmark against a real multilingual corpus. Run from the
`Transcriber/` directory (needs `franc` from `node_modules`).

### 1. Fetch a short-sentence corpus (Tatoeba, per language)

[Tatoeba](https://tatoeba.org) publishes per-language sentence exports
(CC-BY 2.0 FR). Download the five representative neighbours `franc` confuses:

```bash
mkdir -p /tmp/ld-corpus && cd /tmp/ld-corpus
for iso in fra eng spa nld deu; do
  curl -s -O "https://downloads.tatoeba.org/exports/per_language/${iso}/${iso}_sentences.tsv.bz2"
  bunzip2 -f "${iso}_sentences.tsv.bz2"
done
```

### 2. Run the benchmark

Save as `Transcriber/bench-langdetect.mjs`, run
`node bench-langdetect.mjs /tmp/ld-corpus`:

```js
import { readFileSync } from 'fs';
import { franc } from 'franc';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createLangDetector } = require('./ASR/lang-detect.js');
const DIR = process.argv[2];

const LANGS = [['fra','fr-FR'],['eng','en-US'],['spa','es-ES'],['nld','nl-NL'],['deu','de-DE']];
const ONLY = LANGS.map(([i]) => i);
const ISO2BCP = Object.fromEntries(LANGS.map(([i, b]) => [i, b]));
const PROFILE = LANGS.map(([, b]) => b);
const N = 400;

// Deterministic sample of N short sentences (15-45 chars, no digits) per language.
const load = iso => {
  const o = [];
  for (const l of readFileSync(`${DIR}/${iso}_sentences.tsv`, 'utf8').split('\n')) {
    const t = (l.split('\t')[2] || '').trim();
    if (t.length >= 15 && t.length <= 45 && !/[0-9@]/.test(t)) o.push(t);
  }
  const step = Math.max(1, Math.floor(o.length / N)), s = [];
  for (let i = 0; i < o.length && s.length < N; i += step) s.push(o[i]);
  return s;
};
const corpus = Object.fromEntries(LANGS.map(([i, b]) => [b, load(i)]));
const francLabel = t => { const l = franc(t, { only: ONLY }); return l === 'und' ? null : ISO2BCP[l]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => Math.sqrt(a.reduce((s, y) => s + (y - mean(a)) ** 2, 0) / a.length);
const P = x => (100 * x).toFixed(2) + '%';

// A) Monolingual: wrong-language rate, per language, franc-alone vs windowed.
console.log('A) MONOLINGUAL wrong-language rate');
for (const impl of ['franc-alone', 'windowed']) {
  const wr = [];
  for (const [, bcp] of LANGS) {
    const d = impl === 'windowed' ? createLangDetector(PROFILE, { franc }) : null;
    let w = 0;
    for (const t of corpus[bcp]) {
      const l = d ? d.detectLanguage(t, true) : francLabel(t);
      if (l && l !== bcp) w++;
    }
    wr.push(w / N);
  }
  console.log(`  ${impl.padEnd(12)} mean ${P(mean(wr))}  σ ${P(sd(wr))}`);
}

// B) Switch: 400 FR then 400 EN. Latency + quality.
console.log('B) SWITCH 400 FR -> 400 EN');
const seq = [...corpus['fr-FR'].map(t => ['fr', t]), ...corpus['en-US'].map(t => ['en', t])];
for (const impl of ['franc-alone', 'windowed']) {
  const d = impl === 'windowed' ? createLangDetector(PROFILE, { franc }) : null;
  let first = -1, ok = 0, frBad = 0;
  seq.forEach(([tr, t], i) => {
    const l = d ? d.detectLanguage(t, true) : francLabel(t);
    if (tr === 'fr') { if (l && l !== 'fr-FR') frBad++; }
    else if (l === 'en-US') { if (first < 0) first = i - N; ok++; }
  });
  console.log(`  ${impl.padEnd(12)} switch at EN #${first} | EN correct ${P(ok / N)} | FR contaminated ${P(frBad / N)}`);
}
```

### 3. Expected results

```
A) MONOLINGUAL wrong-language rate
  franc-alone  mean 13.10%  σ 3.70%
  windowed     mean  0.05%  σ 0.10%
B) SWITCH 400 FR -> 400 EN
  franc-alone  switch at EN #0 | EN correct 83.3% | FR contaminated 9.3%
  windowed     switch at EN #4 | EN correct 99.0% | FR contaminated 0.0%
```

The windowed detector cuts the mislabel rate ~260× versus raw `franc`, is more
consistent across languages (lower σ), and still switches within a few segments
(here #4) with a much cleaner transition. Exact figures move slightly with the
`franc` version and the Tatoeba snapshot; the order of magnitude is stable.

### Tuning

`windowChars` is the single knob for the accuracy/latency trade-off. Sweeping it
on the same corpus: W=120 → 0.7% mislabels, switch #3; W=180 → 0.1%, switch #4;
W=250 → 0.0%, switch #5. 180 is the default sweet spot.
