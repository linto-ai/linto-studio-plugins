const assert = require('assert');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// vLLM can end a realtime session on its own (max_model_len cap, blank-run
// abort -- including on music/silence): transcription.done arrives with the
// full session text. Expected reaction: drop the full text (already delivered
// as deltas), flush the pending segment, close, then DEFER the new session
// until a speech onset (no churn on music).

describe('OpenAIStreamingTranscriber server-ended session recovery (vLLM)', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        teardown = setupMocks({ invalidate: [fromTranscriber('ASR/openai_streaming/index.js')] });
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function createTranscriber() {
        const session = { id: 'sess-1' };
        const channel = {
            id: 'chan-1',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    endpoint: 'ws://localhost:8000',
                    model: 'test-model',
                    protocol: 'vllm',
                    languages: [{ candidate: 'fr-FR' }]
                }
            }
        };
        const t = new OpenAIStreamingTranscriber(session, channel);
        t.start();
        return t;
    }

    function arm(t) {
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
    }

    it('drops the full-text done, emits the pending segment, defers re-session', function () {
        const t = createTranscriber();
        arm(t);
        const finals = [];
        t.on('transcribed', p => finals.push(p.text));

        t.ws.emit('message', JSON.stringify({ type: 'transcription.delta', delta: ' Bonjour' }));
        t.ws.emit('message', JSON.stringify({ type: 'transcription.delta', delta: ' le monde' }));

        const oldWs = t.ws;
        t.ws.emit('message', JSON.stringify({
            type: 'transcription.done',
            text: 'TOUT LE TRANSCRIPT CUMULE DE LA SESSION',
            usage: { total_tokens: 12345 }
        }));

        // Only the pending segment is emitted; the cumulative text is dropped.
        assert.deepStrictEqual(finals, ['Bonjour le monde']);
        // Torn down, and the next session waits for speech (no blind retry).
        assert.strictEqual(oldWs.closed, true);
        assert.strictEqual(t._resessionDeferred, true);
        assert.strictEqual(t._setupTimers.length, 0);
        t.stop();
    });

    it('re-opens a session on speech onset after a deferred end', function () {
        const t = createTranscriber();
        arm(t);
        const oldWs = t.ws;
        t.ws.emit('message', JSON.stringify({
            type: 'transcription.done', text: 'X', usage: null
        }));
        assert.strictEqual(t._resessionDeferred, true);

        // No speech: audio only reaches the pre-arm buffer, no new session.
        t._vadWatchdog.ingest = () => {};
        t._vadWatchdog.speechOnset = () => false;
        t.transcribe(Buffer.alloc(640, 1));
        assert.strictEqual(t._resessionDeferred, true);

        // Speech onset: a fresh session opens immediately.
        t._vadWatchdog.speechOnset = () => true;
        t.transcribe(Buffer.alloc(640, 1));
        assert.strictEqual(t._resessionDeferred, false);
        assert.ok(t.ws && t.ws !== oldWs, 'expected a fresh connection');
        t.stop();
    });

    it('un-armed sessions keep the plain final path (no resession)', function () {
        const t = createTranscriber();
        // No session.created: not armed. A done here follows the plain
        // handleFinal path (defensive: should not tear the connection down).
        const finals = [];
        t.on('transcribed', p => finals.push(p.text));

        const oldWs = t.ws;
        t.ws.emit('message', JSON.stringify({
            type: 'transcription.done',
            text: 'Texte final classique',
            usage: null
        }));

        assert.deepStrictEqual(finals, ['Texte final classique']);
        assert.strictEqual(oldWs.closed, false);
        t.stop();
    });
});
