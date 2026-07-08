const assert = require('assert');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// vLLM can end a realtime session on its own (max_model_len cap, blank-run
// abort): transcription.done arrives with the full session text and the
// socket stays open on a dead session. Expected reaction: drop the full text
// (already delivered as deltas), flush the pending segment, reconnect.

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

    it('drops the full-text done, emits the pending segment and reconnects', function () {
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
        // The connection was torn down and a fresh session is scheduled.
        assert.strictEqual(oldWs.closed, true);
        assert.ok(t._setupTimers.length > 0, 'expected a scheduled reconnect');
        t.stop();
    });

    it('emits nothing extra when no segment is pending, still reconnects', function () {
        const t = createTranscriber();
        arm(t);
        const finals = [];
        t.on('transcribed', p => finals.push(p.text));

        const oldWs = t.ws;
        t.ws.emit('message', JSON.stringify({
            type: 'transcription.done',
            text: 'TEXTE COMPLET',
            usage: null
        }));

        assert.deepStrictEqual(finals, []);
        assert.strictEqual(oldWs.closed, true);
        assert.ok(t._setupTimers.length > 0, 'expected a scheduled reconnect');
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
