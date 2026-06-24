const assert = require('assert');
const path = require('path');
const { describe, it, before, after } = require('mocha');

// ---- Mock setup: intercept require() before loading GoogleTranscriber ----

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {}, log() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

class MockSecurity {
    safeDecrypt(text) {
        return text && text.startsWith('encrypted:') ? text.replace('encrypted:', '') : text;
    }
    encrypt(text) { return `encrypted:${text}`; }
    decrypt(text) { return text.replace('encrypted:', ''); }
}

// Fake streamingRecognize stream: records the request, lets the test push
// 'data'/'error' events, and exposes writable + end()/write() like a duplex.
class MockRecognizeStream {
    constructor(request) {
        this.request = request;
        this.writable = true;
        this.writableNeedDrain = false;
        this.writes = [];
        this._handlers = {};
        this.ended = false;
    }
    on(event, cb) {
        this._handlers[event] = this._handlers[event] || [];
        this._handlers[event].push(cb);
        return this;
    }
    once(event, cb) {
        const wrapper = (payload) => {
            this.removeListener(event, wrapper);
            cb(payload);
        };
        return this.on(event, wrapper);
    }
    removeListener(event, cb) {
        if (this._handlers[event]) {
            this._handlers[event] = this._handlers[event].filter(h => h !== cb);
        }
        return this;
    }
    removeAllListeners(event) {
        if (event) delete this._handlers[event]; else this._handlers = {};
        return this;
    }
    listenerCount(event) {
        if (event) return (this._handlers[event] || []).length;
        return Object.values(this._handlers).reduce((n, arr) => n + arr.length, 0);
    }
    write(buf) { this.writes.push(buf); }
    end() { this.ended = true; this.writable = false; }
    emit(event, payload) {
        (this._handlers[event] || []).slice().forEach(cb => cb(payload));
    }
}

class MockSpeechClient {
    constructor(opts) {
        this.opts = opts;
        this.lastStream = null;
    }
    streamingRecognize(request) {
        this.lastStream = new MockRecognizeStream(request);
        return this.lastStream;
    }
    async close() { this.closed = true; }
}

const mockSpeechModule = { SpeechClient: MockSpeechClient };

const Module = require('module');

const liveSrtLibPath = require.resolve('live-srt-lib');
const googleIndexPath = path.resolve(__dirname, '../ASR/google/index.js');
const googleLoggerPath = path.resolve(__dirname, '../logger.js');

// '@google-cloud/speech' is an external runtime dependency that may not be
// installed in the test environment (the parent runs npm install separately).
// Rather than rely on require.resolve (which would throw when the package is
// absent and break the whole suite), patch Module._load to return the mock for
// that exact specifier while the google provider is being required.
function setupMocks() {
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === '@google-cloud/speech') return mockSpeechModule;
        return origLoad.apply(this, arguments);
    };

    const origLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[googleLoggerPath];

    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };
    require.cache[googleLoggerPath] = {
        id: googleLoggerPath, filename: googleLoggerPath, loaded: true, exports: mockLogger
    };
    delete require.cache[googleIndexPath];

    return function teardown() {
        Module._load = origLoad;
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[googleLoggerPath] = origLogger; else delete require.cache[googleLoggerPath];
        delete require.cache[googleIndexPath];
    };
}

// A valid (fake) service-account JSON, stored as the "encrypted" credentials so
// MockSecurity.safeDecrypt yields back the raw JSON text.
const FAKE_SA = JSON.stringify({
    type: 'service_account',
    project_id: 'proj-from-creds',
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n',
});

function makeChannel(opts = {}) {
    const languages = opts.languages || [{ candidate: 'en-US' }, { candidate: 'fr-FR' }];
    return {
        id: 'channel-1',
        diarization: !!opts.diarization,
        transcriberProfile: {
            config: {
                type: 'google',
                credentials: 'encrypted:' + FAKE_SA,
                languages,
                model: opts.model || '',
                projectId: opts.projectId,
            },
        },
    };
}

describe('GoogleTranscriber', () => {
    let GoogleTranscriber;
    let teardown;

    before(() => {
        teardown = setupMocks();
        GoogleTranscriber = require('../ASR/google/index.js');
    });

    after(() => { if (teardown) teardown(); });

    describe('_buildRequest()', () => {
        it('sets languageCode to the first candidate', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            const req = t._buildRequest();
            assert.strictEqual(req.config.languageCode, 'en-US');
            assert.strictEqual(req.config.encoding, 'LINEAR16');
            assert.strictEqual(req.config.sampleRateHertz, 16000);
            assert.strictEqual(req.config.audioChannelCount, 1);
            assert.strictEqual(req.interimResults, true);
        });

        it('lists extra languages under alternativeLanguageCodes (max 3)', () => {
            const channel = makeChannel({
                languages: [
                    { candidate: 'en-US' }, { candidate: 'fr-FR' },
                    { candidate: 'de-DE' }, { candidate: 'es-ES' }, { candidate: 'it-IT' },
                ],
            });
            const t = new GoogleTranscriber({ id: 's' }, channel);
            const req = t._buildRequest();
            assert.deepStrictEqual(req.config.alternativeLanguageCodes, ['fr-FR', 'de-DE', 'es-ES']);
        });

        it('omits alternativeLanguageCodes for a single language', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel({ languages: [{ candidate: 'en-US' }] }));
            const req = t._buildRequest();
            assert.strictEqual(req.config.alternativeLanguageCodes, undefined);
        });

        it('omits model when config.model is empty', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel({ model: '' }));
            const req = t._buildRequest();
            assert.strictEqual('model' in req.config, false);
        });

        it('includes model when config.model is set', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel({ model: 'latest_long' }));
            const req = t._buildRequest();
            assert.strictEqual(req.config.model, 'latest_long');
        });

        it('adds diarizationConfig only when channel.diarization is true', () => {
            const off = new GoogleTranscriber({ id: 's' }, makeChannel({ diarization: false }));
            assert.strictEqual('diarizationConfig' in off._buildRequest().config, false);

            const on = new GoogleTranscriber({ id: 's' }, makeChannel({ diarization: true }));
            const req = on._buildRequest();
            assert.ok(req.config.diarizationConfig);
            assert.strictEqual(req.config.diarizationConfig.enableSpeakerDiarization, true);
        });

        it('always requests word time offsets (needed for per-segment start)', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            assert.strictEqual(t._buildRequest().config.enableWordTimeOffsets, true);
        });
    });

    describe('formatResult()', () => {
        it('maps transcript->text, resultEndTime->end, returns translations:{} and astart', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = '2026-06-16T00:00:00.000Z';
            const result = {
                alternatives: [{ transcript: 'hello world' }],
                resultEndTime: { seconds: 2, nanos: 500000000 },
                languageCode: 'en-US',
            };
            const out = t.formatResult(result);
            assert.strictEqual(out.text, 'hello world');
            assert.strictEqual(out.end, 2.5);
            assert.deepStrictEqual(out.translations, {});
            assert.strictEqual(out.astart, '2026-06-16T00:00:00.000Z');
            assert.strictEqual(out.lang, 'en-US');
            assert.strictEqual(out.locutor, null);
        });

        it('continues end from _streamOffset across restarts', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t._streamOffset = 10;
            const result = {
                alternatives: [{ transcript: 'again' }],
                resultEndTime: { seconds: 3, nanos: 0 },
            };
            assert.strictEqual(t.formatResult(result).end, 13);
        });

        it('derives start from the first word offset (does not absorb silence)', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.lastEnd = 2; // previous final ended at 2s
            const result = {
                alternatives: [{
                    transcript: 'after a long pause',
                    // utterance actually starts at 10s after ~8s of silence
                    words: [
                        { word: 'after', startTime: { seconds: 10, nanos: 0 } },
                        { word: 'pause', startTime: { seconds: 10, nanos: 800000000 } },
                    ],
                }],
                resultEndTime: { seconds: 11, nanos: 0 },
            };
            const out = t.formatResult(result);
            assert.strictEqual(out.start, 10, 'start should track the first word, not the previous end');
            assert.strictEqual(out.end, 11);
        });

        it('adds _streamOffset to the word-derived start across restarts', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t._streamOffset = 100;
            const result = {
                alternatives: [{ transcript: 'x', words: [{ word: 'x', startTime: { seconds: 1, nanos: 500000000 } }] }],
                resultEndTime: { seconds: 2, nanos: 0 },
            };
            assert.strictEqual(t.formatResult(result).start, 101.5);
        });

        it('falls back to lastEnd for results without word timings', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.lastEnd = 5;
            const result = { alternatives: [{ transcript: 'no words' }], resultEndTime: { seconds: 6, nanos: 0 } };
            assert.strictEqual(t.formatResult(result).start, 5);
        });

        it('attributes locutor to the FIRST tagged speaker (consistent with Amazon)', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel({ diarization: true }));
            const result = {
                alternatives: [{
                    transcript: 'who said this',
                    words: [
                        { word: 'who', speakerTag: 1 },
                        { word: 'said', speakerTag: 2 },
                    ],
                }],
                resultEndTime: { seconds: 1, nanos: 0 },
            };
            assert.strictEqual(t.formatResult(result).locutor, 'spk_1');
        });

        it('leaves locutor null when diarization is off even if words carry tags', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel({ diarization: false }));
            const result = {
                alternatives: [{ transcript: 'x', words: [{ word: 'x', speakerTag: 3 }] }],
                resultEndTime: { seconds: 1, nanos: 0 },
            };
            assert.strictEqual(t.formatResult(result).locutor, null);
        });
    });

    describe('_onData()', () => {
        it('emits transcribing for interim results', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = 'x';
            const events = [];
            t.on('transcribing', p => events.push(p));
            t.on('transcribed', () => assert.fail('should not emit transcribed for interim'));
            t._onData({ results: [{
                isFinal: false,
                alternatives: [{ transcript: 'partial text' }],
                resultEndTime: { seconds: 1, nanos: 0 },
            }] });
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].text, 'partial text');
            assert.ok(t.lastPartial);
        });

        it('emits transcribed for isFinal results and clears lastPartial', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = 'x';
            t.lastPartial = { text: 'stale' };
            const events = [];
            t.on('transcribed', p => events.push(p));
            t._onData({ results: [{
                isFinal: true,
                alternatives: [{ transcript: 'final text' }],
                resultEndTime: { seconds: 4, nanos: 0 },
            }] });
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].text, 'final text');
            assert.strictEqual(t.lastEnd, 4);
            assert.strictEqual(t.lastPartial, null);
        });

        it('ignores empty-text results', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = 'x';
            let emitted = false;
            t.on('transcribing', () => { emitted = true; });
            t.on('transcribed', () => { emitted = true; });
            t._onData({ results: [{ isFinal: true, alternatives: [{ transcript: '   ' }] }] });
            assert.strictEqual(emitted, false);
        });
    });

    describe('stop()', () => {
        it('flushes a pending partial as transcribed', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = 'x';
            t.lastPartial = { astart: 'x', text: 'pending words', translations: {}, start: 0, end: 1, lang: 'en-US', locutor: null };
            const finals = [];
            t.on('transcribed', p => finals.push(p));
            await t.stop();
            assert.strictEqual(finals.length, 1);
            assert.strictEqual(finals[0].text, 'pending words');
            assert.strictEqual(t.lastPartial, null);
        });

        it('does not emit when there is no pending partial', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            await t.stop();
            assert.strictEqual(emitted, false);
        });
    });

    describe('lifecycle: start() / transcribe()', () => {
        it('start() builds a client and opens a stream, transcribe() writes to it', async () => {
            const channel = makeChannel({ projectId: 'override-proj' });
            const t = new GoogleTranscriber({ id: 's' }, channel);
            const states = [];
            t.on('connecting', () => states.push('connecting'));
            t.on('ready', () => states.push('ready'));
            await t.start();
            assert.ok(states.includes('connecting'));
            assert.ok(states.includes('ready'));
            assert.ok(t.client instanceof MockSpeechClient);
            assert.strictEqual(t.client.opts.projectId, 'override-proj');
            assert.ok(t.recognizeStream);

            const buf = Buffer.from([1, 2, 3, 4]);
            t.transcribe(buf);
            assert.strictEqual(t.recognizeStream.writes.length, 1);
            assert.strictEqual(t.recognizeStream.writes[0], buf);
            await t.stop();
        });

        it('falls back to credentials project_id when projectId not set', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            assert.strictEqual(t.client.opts.projectId, 'proj-from-creds');
            await t.stop();
        });
    });

    describe('_onError()', () => {
        it('restarts silently on OUT_OF_RANGE (code 11) without emitting error', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const first = t.recognizeStream;
            let errored = false;
            t.on('error', () => { errored = true; });
            first.emit('error', { code: 11, message: 'Exceeded maximum allowed stream duration' });
            assert.strictEqual(errored, false, 'duration rollover must not surface an error');
            assert.notStrictEqual(t.recognizeStream, first, 'a fresh stream should be opened');
            assert.strictEqual(first.ended, true, 'old stream torn down');
            await t.stop();
        });

        it('restarts on an "exceed"-message error even without code 11', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const first = t.recognizeStream;
            t.on('error', () => assert.fail('should not emit error'));
            first.emit('error', { message: 'stream duration exceeded the limit' });
            assert.notStrictEqual(t.recognizeStream, first);
            await t.stop();
        });

        it('maps gRPC codes to the contract error strings', async () => {
            const cases = [[7, 'FORBIDDEN'], [16, 'AUTHENTICATION_FAILURE'], [8, 'TOO_MANY_REQUESTS'], [999, 'RUNTIME_ERROR']];
            for (const [code, expected] of cases) {
                const t = new GoogleTranscriber({ id: 's' }, makeChannel());
                await t.start();
                const errs = [];
                t.on('error', e => errs.push(e));
                t.recognizeStream.emit('error', { code, message: 'boom' });
                assert.deepStrictEqual(errs, [expected], `code ${code} -> ${expected}`);
                await t.stop();
            }
        });

        it('emits a STRING, never an Error object (wrapper contract)', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            let payload;
            t.on('error', e => { payload = e; });
            t.recognizeStream.emit('error', { code: 7, message: 'denied' });
            assert.strictEqual(typeof payload, 'string');
            await t.stop();
        });

        it('swallows a non-restart error that arrives after stop()', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const stream = t.recognizeStream;
            await t.stop();
            let errored = false;
            t.on('error', () => { errored = true; });
            // stream was torn down (removeAllListeners), but even a direct call is guarded by !isStreaming
            t._onError({ code: 7, message: 'late' }, stream);
            assert.strictEqual(errored, false);
        });

        it('code 11 after stop() does not resurrect a stream', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const stream = t.recognizeStream;
            await t.stop();
            t._onError({ code: 11, message: 'exceed' }, stream);
            assert.strictEqual(t.recognizeStream, null, 'restart is a no-op once stopped');
        });
    });

    describe('_restartStream() — timestamp continuity', () => {
        it('accumulates _streamOffset so timestamps stay monotonic across a restart', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const first = t.recognizeStream;
            // a final ends at 5s on the first stream
            first.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: 'one' }], resultEndTime: { seconds: 5, nanos: 0 } }] });
            assert.strictEqual(t.lastEnd, 5);

            t._restartStream();
            assert.strictEqual(t._streamOffset, 5, 'offset carries the previous end');
            assert.notStrictEqual(t.recognizeStream, first);

            // the new stream reports a result at +3s relative => absolute 8s
            const finals = [];
            t.on('transcribed', p => finals.push(p));
            t.recognizeStream.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: 'two' }], resultEndTime: { seconds: 3, nanos: 0 } }] });
            assert.strictEqual(finals.length, 1);
            assert.strictEqual(finals[0].end, 8);
            assert.strictEqual(finals[0].text, 'two');
            await t.stop();
        });

        it('does not restart when not streaming', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.isStreaming = false;
            t._restartStream(); // must be a safe no-op
            assert.strictEqual(t.recognizeStream, null);
        });
    });

    describe('stale-stream isolation', () => {
        it('ignores buffered data delivered by an old stream after a restart', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const old = t.recognizeStream;
            t._restartStream();
            const events = [];
            t.on('transcribed', p => events.push(p));
            t.on('transcribing', p => events.push(p));
            // old stream was torn down: emitting on it must reach no handler
            old.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: 'ghost' }], resultEndTime: { seconds: 1, nanos: 0 } }] });
            assert.strictEqual(events.length, 0, 'no phantom caption from the retired stream');
            assert.strictEqual(old.listenerCount(), 0, 'all listeners detached from the old stream');
            await t.stop();
        });

        it('the identity guard drops data tagged with a non-current stream', () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            t.startedAt = 'x';
            t.recognizeStream = { current: true };
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            t._onData({ results: [{ isFinal: true, alternatives: [{ transcript: 'stale' }], resultEndTime: { seconds: 1, nanos: 0 } }] }, { other: true });
            assert.strictEqual(emitted, false);
        });
    });

    describe('transcribe() backpressure & teardown', () => {
        it('drops audio (no write) while the stream needs to drain, resumes after drain', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const stream = t.recognizeStream;
            stream.writableNeedDrain = true;
            t.transcribe(Buffer.from([1, 2]));
            assert.strictEqual(stream.writes.length, 0, 'must not write under backpressure');
            // simulate the gRPC stream draining
            stream.writableNeedDrain = false;
            stream.emit('drain');
            t.transcribe(Buffer.from([3, 4]));
            assert.strictEqual(stream.writes.length, 1, 'writes resume once drained');
            await t.stop();
        });

        it('drops audio when not streaming (after stop)', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            await t.stop();
            t.transcribe(Buffer.from([1])); // no stream, must not throw
            assert.strictEqual(t.recognizeStream, null);
        });

        it('coerces a Uint8Array into a Node Buffer before writing', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            t.transcribe(new Uint8Array([9, 8, 7]));
            assert.strictEqual(t.recognizeStream.writes.length, 1);
            assert.ok(Buffer.isBuffer(t.recognizeStream.writes[0]));
            await t.stop();
        });

        it('stop() tears down stream + client and detaches every listener', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const stream = t.recognizeStream;
            const client = t.client;
            await t.stop();
            assert.strictEqual(stream.ended, true, 'stream ended');
            assert.strictEqual(stream.listenerCount(), 0, 'stream listeners detached');
            assert.strictEqual(client.closed, true, 'client closed');
            assert.strictEqual(t.recognizeStream, null);
            assert.strictEqual(t.client, null);
            assert.strictEqual(t.restartTimer, null, 'restart timer cleared');
        });

        it('start() after stop() reopens a clean stream (pause/resume reuse)', async () => {
            const t = new GoogleTranscriber({ id: 's' }, makeChannel());
            await t.start();
            const first = t.recognizeStream;
            await t.stop();
            await t.start();
            assert.ok(t.recognizeStream);
            assert.notStrictEqual(t.recognizeStream, first);
            assert.strictEqual(t.isStreaming, true);
            assert.strictEqual(t._streamOffset, 0, 'offset reset on a fresh start');
            assert.strictEqual(t.lastEnd, 0);
            await t.stop();
        });
    });
});
