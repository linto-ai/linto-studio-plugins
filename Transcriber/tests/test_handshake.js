const assert = require('assert');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// Startup handshake hardening suite (see Transcriber/VOXTRAL-HANDSHAKE.md).
// Covers: audio-driven vLLM arming (no blind timers), pre-arm audio retention
// (no drops), bounded pre-arm buffer, no-result watchdog, and the un-armed
// teardown path (no orphan commits).

function parseSent(ws) {
    return ws.sentMessages.map(m => JSON.parse(m));
}

describe('OpenAIStreamingTranscriber handshake', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        // Shrink watchdog windows so the suite runs fast. Read at require time.
        process.env.ASR_WATCHDOG_NO_RESULT_MS = '60';
        process.env.ASR_WATCHDOG_MAX_RETRIES = '2';
        process.env.ASR_WATCHDOG_SLOW_RETRY_MS = '120';
        teardown = setupMocks({ invalidate: [fromTranscriber('ASR/openai_streaming/index.js')] });
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
        delete process.env.ASR_WATCHDOG_NO_RESULT_MS;
        delete process.env.ASR_WATCHDOG_MAX_RETRIES;
        delete process.env.ASR_WATCHDOG_SLOW_RETRY_MS;
    });

    function createTranscriber(configOverrides = {}) {
        const session = { id: 'sess-1' };
        const channel = {
            id: 'chan-1',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    endpoint: 'ws://localhost:8000',
                    model: 'test-model',
                    protocol: 'vllm',
                    languages: [{ candidate: 'fr-FR' }],
                    ...configOverrides
                }
            }
        };
        return new OpenAIStreamingTranscriber(session, channel);
    }

    function emitSessionCreated(t) {
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
    }

    function emitPartial(t, text) {
        t.ws.emit('message', JSON.stringify({ type: 'transcription.delta', delta: text }));
    }

    const AUDIO = Buffer.alloc(320, 1); // 10ms PCM 16kHz mono 16-bit

    // ------------------------------------------------------------------
    // Arming: commit driven by first audio, not by timers
    // ------------------------------------------------------------------

    it('arms with update -> commit -> append when audio arrived before session.created', function () {
        const t = createTranscriber();
        t.start();
        t.transcribe(AUDIO); // before session.created: buffered, nothing sent
        assert.strictEqual(t.ws.sentMessages.length, 0);
        assert.strictEqual(t._sessionReady, false);

        let readyEmitted = false;
        t.on('ready', () => { readyEmitted = true; });

        emitSessionCreated(t);

        const sent = parseSent(t.ws);
        assert.strictEqual(sent[0].type, 'session.update');
        assert.strictEqual(sent[1].type, 'input_audio_buffer.commit');
        assert.strictEqual(sent[1].final, false);
        assert.strictEqual(sent[2].type, 'input_audio_buffer.append');
        assert.strictEqual(sent.length, 3);
        // Buffered audio flushed intact
        assert.strictEqual(Buffer.from(sent[2].audio, 'base64').length, AUDIO.length);
        assert.strictEqual(t._sessionReady, true);
        assert.ok(readyEmitted);
        assert.strictEqual(t._preArmBufferBytes, 0);
        t.stop();
    });

    it('arms on first audio when session.created arrived first', function () {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);

        let sent = parseSent(t.ws);
        assert.strictEqual(sent.length, 1); // only session.update, no commit yet
        assert.strictEqual(sent[0].type, 'session.update');
        assert.strictEqual(t._sessionReady, false);

        t.transcribe(AUDIO);
        sent = parseSent(t.ws);
        assert.strictEqual(sent[1].type, 'input_audio_buffer.commit');
        assert.strictEqual(sent[2].type, 'input_audio_buffer.append');
        assert.strictEqual(t._sessionReady, true);
        t.stop();
    });

    it('never arms nor commits when no audio ever arrives (dead-born connection)', function () {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        const ws = t.ws;
        t.stop();

        const types = parseSent(ws).map(m => m.type);
        assert.deepStrictEqual(types, ['session.update']);
        // No arming commit, and no final commit on teardown of an un-armed session
        assert.ok(!types.includes('input_audio_buffer.commit'));
    });

    it('sends the final commit on stop() when the session was armed', function () {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO);
        const ws = t.ws;
        t.stop();

        const sent = parseSent(ws);
        const last = sent[sent.length - 1];
        assert.strictEqual(last.type, 'input_audio_buffer.commit');
        assert.strictEqual(last.final, true);
    });

    it('retains audio received before start() and across the handshake', function () {
        const t = createTranscriber();
        t.transcribe(AUDIO); // ws does not even exist yet
        assert.strictEqual(t._preArmBufferBytes, AUDIO.length);

        t.start();
        t.transcribe(AUDIO);
        emitSessionCreated(t);

        const appends = parseSent(t.ws).filter(m => m.type === 'input_audio_buffer.append');
        const totalBytes = appends.reduce((n, m) => n + Buffer.from(m.audio, 'base64').length, 0);
        assert.strictEqual(totalBytes, 2 * AUDIO.length);
        t.stop();
    });

    it('bounds the pre-arm buffer by dropping oldest chunks', function () {
        const t = createTranscriber();
        // Default cap: 10000ms * 32 bytes/ms = 320000 bytes
        const big = Buffer.alloc(200000, 1);
        const newer = Buffer.alloc(200000, 2);
        t.transcribe(big);
        t.transcribe(newer);
        assert.strictEqual(t._preArmBufferBytes, 200000); // oldest dropped
        assert.strictEqual(t._preArmBuffer[0][0], 2);     // newest kept
    });

    it('splits flushed audio into 6400-byte append chunks', function () {
        const t = createTranscriber();
        t.start();
        t.transcribe(Buffer.alloc(15000, 1));
        emitSessionCreated(t);

        const appends = parseSent(t.ws).filter(m => m.type === 'input_audio_buffer.append');
        const sizes = appends.map(m => Buffer.from(m.audio, 'base64').length);
        assert.deepStrictEqual(sizes, [6400, 6400, 2200]);
        t.stop();
    });

    // ------------------------------------------------------------------
    // Non-vLLM protocol: ready at session.created, buffered audio flushed
    // ------------------------------------------------------------------

    it('openai protocol readies at session.created and flushes buffered audio without commit', function () {
        const t = createTranscriber({ protocol: 'openai', apiKey: 'encrypted:k' });
        t.start();
        t.transcribe(AUDIO);
        t.ws.emit('message', JSON.stringify({ type: 'transcription_session.created', session: { id: 's' } }));

        const types = parseSent(t.ws).map(m => m.type);
        assert.deepStrictEqual(types, ['transcription_session.update', 'input_audio_buffer.append']);
        assert.strictEqual(t._sessionReady, true);
        t.stop();
    });

    // ------------------------------------------------------------------
    // Watchdog
    // ------------------------------------------------------------------

    it('watchdog reconnects an armed session that stays mute', function (done) {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO); // arms, watchdog starts (60ms)
        const wsBefore = t.ws;

        setTimeout(() => {
            try {
                assert.strictEqual(t._watchdogRetries, 1);
                assert.strictEqual(wsBefore.closed, true);       // stop() closed the socket
                assert.strictEqual(t._setupTimers.length, 1);    // reconnect scheduled
                assert.ok(t._preArmBufferBytes >= 0);            // buffer intact for the retry
                t.stop(); // clears the pending reconnect timer
                done();
            } catch (e) { done(e); }
        }, 100);
    });

    it('watchdog is disarmed by the first transcription event', function (done) {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO);
        emitPartial(t, 'Bonjour'); // evidence within the window

        setTimeout(() => {
            try {
                assert.strictEqual(t._watchdogRetries, 0);
                assert.strictEqual(t.ws.closed, false); // no reconnect happened
                t.stop();
                done();
            } catch (e) { done(e); }
        }, 100);
    });

    it('emits SERVICE_TIMEOUT after max consecutive watchdog failures', function () {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO);

        const errors = [];
        t.on('error', e => errors.push(e));

        t._onWatchdogTimeout(60); // attempt 1: no error surfaced yet
        assert.deepStrictEqual(errors, []);
        t._onWatchdogTimeout(60); // attempt 2 = ASR_WATCHDOG_MAX_RETRIES
        assert.deepStrictEqual(errors, ['SERVICE_TIMEOUT']);
        t.stop();
    });

    it('watchdog uses the slow cadence after max retries', function () {
        const t = createTranscriber();
        t._watchdogRetries = 2; // >= ASR_WATCHDOG_MAX_RETRIES
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO); // arming starts the watchdog with the slow delay

        assert.ok(t._watchdogTimer);
        // Node timers expose the delay via _idleTimeout
        assert.strictEqual(t._watchdogTimer._idleTimeout, 120);
        t.stop();
    });

    it('a fresh partial resets the retry counter', function () {
        const t = createTranscriber();
        t.start();
        emitSessionCreated(t);
        t.transcribe(AUDIO);
        t._watchdogRetries = 1;
        emitPartial(t, 'Salut');
        assert.strictEqual(t._watchdogRetries, 0);
        t.stop();
    });
});
