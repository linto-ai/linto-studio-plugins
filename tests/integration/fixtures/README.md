# Integration test audio fixtures

## `audio.wav`
Short PCM clip used by streaming scenarios that only need to drive the audio
pipeline (no real ASR output required). 16 kHz, mono, signed 16-bit LE PCM.

## `speech-en.wav`
Real English speech, **required** by scenarios that assert on actual Azure ASR
output (finals with `speakerId`, discrete translations). A pure tone is not
enough — Azure rarely emits transcriptions for non-speech audio.

- Format: WAV, PCM signed 16-bit LE, 16 kHz, mono (the format the Transcriber's
  GStreamer pipeline ultimately feeds the ASR providers).
- Duration: ~35 s. Long enough that Azure flushes several finals **and** the
  discrete translation *while the SRT stream is still open* — a ~10 s one-shot
  clip is disposed (stream close → ASR disposed) before the secondary
  TranslationRecognizer flushes its final, which makes the scenario flake.
- Provenance: derived from the repository's `en.mp3` (English speech sample at
  the repo root), trimmed to the first 35 seconds and transcoded with:

  ```bash
  ffmpeg -y -i en.mp3 -t 35 -ar 16000 -ac 1 -c:a pcm_s16le \
      tests/integration/fixtures/speech-en.wav
  ```

  Regenerate with the same command if `en.mp3` changes.

Consumed by: `scenarios/17-diarization-translation-microsoft.sh`.
