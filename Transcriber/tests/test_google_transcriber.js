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
        this.writes = [];
        this._handlers = {};
        this.ended = false;
    }
    on(event, cb) {
        this._handlers[event] = this._handlers[event] || [];
        this._handlers[event].push(cb);
        return this;
    }
    removeAllListeners(event) {
        if (event) delete this._handlers[event]; else this._handlers = {};
        return this;
    }
    write(buf) { this.writes.push(buf); }
    end() { this.ended = true; this.writable = false; }
    emit(event, payload) {
        (this._handlers[event] || []).forEach(cb => cb(payload));
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

        it('extracts locutor from speakerTag when diarization is on', () => {
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
            assert.strictEqual(t.formatResult(result).locutor, 'spk_2');
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
});
