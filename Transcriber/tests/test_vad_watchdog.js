const assert = require('assert');
const { VadWatchdog, SileroDetector, FRAME_SAMPLES, FRAME_MS } =
    require('../ASR/openai_streaming/vad_watchdog');

// Watchdog logic with an injected detector (no model): sustained speech and
// no transcription events fires; events, silence or cooldown hold it back.
// A last suite smoke-tests the real Silero model shipped in the image.

const quietLogger = { warn() {}, error() {}, debug() {}, info() {} };

function fakeDetector(prob) {
    return { init: async () => {}, prob: async () => prob };
}

function frameBuf() {
    return Buffer.alloc(FRAME_SAMPLES * 2, 1);
}

// Feed `ms` of audio frame by frame, advancing the injected clock.
async function feed(w, ms, startNow) {
    let now = startNow;
    for (let t = 0; t < ms; t += FRAME_MS) {
        now += FRAME_MS;
        w.ingest(frameBuf(), now);
        // let the async pump drain
        await new Promise(setImmediate);
    }
    return now;
}

describe('VadWatchdog (injected detector)', function () {

    it('fires on sustained speech with zero text', async function () {
        const fires = [];
        const w = new VadWatchdog({
            logger: quietLogger,
            onFire: v => fires.push(v),
            detector: fakeDetector(0.95),
        });
        await new Promise(setImmediate); // init
        w.reset(1000);
        await feed(w, 16000, 1000);
        assert.strictEqual(fires.length, 1);
        assert.ok(fires[0].speechMs >= w.minSpeechMs);
        assert.strictEqual(fires[0].mode, 'enforce');
    });

    it('does not fire while healthy text keeps arriving', async function () {
        const fires = [];
        const w = new VadWatchdog({
            logger: quietLogger,
            onFire: v => fires.push(v),
            detector: fakeDetector(0.95),
        });
        await new Promise(setImmediate);
        w.reset(1000);
        let now = 1000;
        for (let i = 0; i < 8; i++) {
            now = await feed(w, 2500, now);
            w.noteEvent(now, 40); // ~16 chars/s of speech: healthy rate
        }
        assert.strictEqual(fires.length, 0);
    });

    it('fires through penalty-chopped crumbs (2026-07-09 night regression)', async function () {
        // A chopped rut trickles a 1-word crumb every ~17s over real speech:
        // 3 chars per crumb must NOT count as proof of life.
        const fires = [];
        const w = new VadWatchdog({
            logger: quietLogger,
            onFire: v => fires.push(v),
            detector: fakeDetector(0.95),
        });
        await new Promise(setImmediate);
        w.reset(1000);
        let now = 1000;
        for (let i = 0; i < 4; i++) {
            now = await feed(w, 5000, now);
            w.noteEvent(now, 3); // crumb: "on "
        }
        assert.strictEqual(fires.length, 1);
        assert.ok(fires[0].cps < 1.0, `cps=${fires[0].cps}`);
    });

    it('never fires on silence', async function () {
        const fires = [];
        const w = new VadWatchdog({
            logger: quietLogger,
            onFire: v => fires.push(v),
            detector: fakeDetector(0.02),
        });
        await new Promise(setImmediate);
        w.reset(1000);
        await feed(w, 30000, 1000);
        assert.strictEqual(fires.length, 0);
    });

    it('respects the cooldown between fires', async function () {
        const fires = [];
        const w = new VadWatchdog({
            logger: quietLogger,
            onFire: v => fires.push(v),
            detector: fakeDetector(0.95),
        });
        await new Promise(setImmediate);
        w.reset(1000);
        await feed(w, 40000, 1000); // enough audio for 2+ windows
        assert.strictEqual(fires.length, 1); // cooldown 60s holds the second
    });

    it('speechOnset needs recent sustained speech', async function () {
        const w = new VadWatchdog({
            logger: quietLogger,
            detector: fakeDetector(0.95),
        });
        await new Promise(setImmediate);
        w.reset(1000);
        assert.strictEqual(w.speechOnset(1000), false);
        const now = await feed(w, 600, 1000);
        assert.strictEqual(w.speechOnset(now), true);
        // long after the last speech frame: no onset
        assert.strictEqual(w.speechOnset(now + 5000), false);
    });
});

describe('SileroDetector (real model smoke test)', function () {
    it('loads and scores silence low', async function () {
        this.timeout(20000);
        const d = new SileroDetector();
        await d.init();
        const silence = new Float32Array(FRAME_SAMPLES); // digital zeros
        let p = 0;
        for (let i = 0; i < 5; i++) p = await d.prob(silence);
        assert.ok(p < 0.3, `expected low speech prob on silence, got ${p}`);
    });

    it('scores real speech high (guards the v5 context contract)', async function () {
        // 3s of French speech, 16k mono S16LE. A model input mismatch (e.g.
        // missing the 64-sample v5 context) floors every prob to ~0 and this
        // is the test that catches it.
        this.timeout(20000);
        const fs = require('fs');
        const path = require('path');
        const d = new SileroDetector();
        await d.init();
        const pcm = fs.readFileSync(
            path.join(__dirname, 'fixtures', 'speech_3s_16k.raw'));
        const frames = Math.floor(pcm.length / (FRAME_SAMPLES * 2));
        let speech = 0;
        for (let f = 0; f < frames; f++) {
            const fr = new Float32Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) {
                fr[i] = pcm.readInt16LE((f * FRAME_SAMPLES + i) * 2) / 32768;
            }
            if (await d.prob(fr) >= 0.5) speech++;
        }
        assert.ok(speech / frames > 0.4,
            `expected >40% speech frames, got ${(100 * speech / frames).toFixed(1)}%`);
    });
});
