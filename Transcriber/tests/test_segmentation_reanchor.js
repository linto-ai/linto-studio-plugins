const assert = require('assert');
const { setupMocks } = require('./helpers/asr_mocks');

// Regression guard for the acute Voxtral freeze at RoPE re-anchor.
//
// The transcriber used to send a mid-session `input_audio_buffer.commit` on
// hard silence (the "commit-drain"). On the vLLM side that commit can land
// while the engine is re-anchoring a long realtime session's positions
// ("Generation already in progress, ignoring commit"), stalling the stream's
// delta output for ~10s. The reference client (ws_load.py) sends no
// mid-session commit and passes re-anchors cleanly. This test pins the
// behaviour so the commit-drain is not silently re-introduced.

describe('Segmentation: re-anchor freeze guard (no mid-session commit)', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    // Must exceed DRAIN_GRACE_MS (750) so the drain emits on the second tick.
    const GRACE_OVERSHOOT_MS = 800;
    // No sentence-ending punctuation -> forces the Priority-5 hard-silence path.
    const NO_PUNCT_TEXT = 'this is a longer test sentence without ending punctuation';

    before(function () {
        teardown = setupMocks();
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function makeTranscriber() {
        const session = { id: 'test-session' };
        const channel = {
            id: 'test-channel',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    protocol: 'vllm',
                    endpoint: 'ws://localhost:8000',
                    languages: [{ candidate: 'fr-FR' }, { candidate: 'en-US' }]
                }
            }
        };
        const t = new OpenAIStreamingTranscriber(session, channel);
        t.start();              // creates the mock ws + vLLM protocol
        t._sessionReady = true;
        return t;
    }

    function commitsSent(t) {
        return t.ws.sentMessages
            .map(m => { try { return JSON.parse(m); } catch (e) { return {}; } })
            .filter(m => m.type === 'input_audio_buffer.commit');
    }

    it('does not send a commit when entering drain on hard silence', function () {
        const t = makeTranscriber();
        const base = 100000;
        t.accumulatedText = NO_PUNCT_TEXT;
        t.lastDeltaTime = base;

        t._runSegmentationTick(base + t.hardSilenceMs + 1);

        assert.strictEqual(t._draining, true, 'should be draining after hard silence');
        assert.strictEqual(commitsSent(t).length, 0, 'must not poke the server with a commit');
    });

    it('emits the segment after the grace period, still without any commit', function () {
        const t = makeTranscriber();
        const emitted = [];
        t.on('transcribed', p => emitted.push(p));

        const base = 100000;
        t.accumulatedText = NO_PUNCT_TEXT;
        t.lastDeltaTime = base;

        const drainStart = base + t.hardSilenceMs + 1;
        t._runSegmentationTick(drainStart);                         // enter drain
        t._runSegmentationTick(drainStart + GRACE_OVERSHOOT_MS);    // grace expired -> emit

        assert.strictEqual(emitted.length, 1, 'segment should be emitted after the grace period');
        assert.strictEqual(t._draining, false, 'drain should be cleared after emit');
        assert.strictEqual(commitsSent(t).length, 0, 'no mid-session commit at any point');
    });

    // Enter drain on hard silence, then have a late token land *after* the drain
    // started (lastDeltaTime advances past _drainStartTime — the Voxtral
    // delayed-token case the grace exists for). The next hard-silence tick must
    // see the fresher token and abort the drain rather than emit a truncated
    // segment. Returns the transcriber, the captured emissions and lateToken.
    function drainThenLateToken() {
        const t = makeTranscriber();
        const emitted = [];
        t.on('transcribed', p => emitted.push(p));

        const base = 100000;
        t.accumulatedText = NO_PUNCT_TEXT;
        t.lastDeltaTime = base;

        const drainStart = base + t.hardSilenceMs + 1;
        t._runSegmentationTick(drainStart);                 // enter drain

        const lateToken = drainStart + 5;
        t.accumulatedText = NO_PUNCT_TEXT + ' and a late tail';
        t.lastDeltaTime = lateToken;
        t._runSegmentationTick(lateToken + t.hardSilenceMs + 1);   // abort drain

        return { t, emitted, lateToken };
    }

    it('aborts the drain without emitting when a late token arrives after drain started', function () {
        const { t, emitted } = drainThenLateToken();

        assert.strictEqual(emitted.length, 0, 'must not emit while fresh tokens are still arriving');
        assert.strictEqual(t._draining, false, 'drain should be aborted so it can restart cleanly');
        assert.strictEqual(commitsSent(t).length, 0, 'still no mid-session commit');
    });

    it('emits the extended segment once silence settles after the late token (no text lost)', function () {
        const { t, emitted, lateToken } = drainThenLateToken();

        // Silence now truly settles (no further tokens): re-enter drain and let
        // the grace expire so the full, late-token-inclusive segment is emitted.
        const reDrainStart = lateToken + t.hardSilenceMs + 1;
        t._runSegmentationTick(reDrainStart);                       // re-enter drain
        t._runSegmentationTick(reDrainStart + GRACE_OVERSHOOT_MS);  // grace expired -> emit

        assert.strictEqual(emitted.length, 1, 'segment should eventually emit once silence settles');
        assert.ok(emitted[0].text.includes('late tail'), 'the late token must not be dropped from the segment');
        assert.strictEqual(commitsSent(t).length, 0, 'still no mid-session commit');
    });
});
