const assert = require('assert');
const EventEmitter = require('eventemitter3');

// We need to mock several dependencies before requiring the transcriber module.
// Use a module-level approach: override require() for specific modules via Module._cache tricks.
// Instead, we test the transcriber's internal logic by directly testing the class after
// injecting mocks into the module resolution.

const Module = require('module');
const path = require('path');

// ---- Mock setup ----

// Create a mock logger
const mockLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    getChannelLogger() {
        return {
            info() {},
            warn() {},
            error() {},
            debug() {},
            log() {}
        };
    }
};

// Create a mock Security class
class MockSecurity {
    encrypt(text) { return `encrypted:${text}`; }
    decrypt(text) { return text.replace('encrypted:', ''); }
    safeDecrypt(text) {
        if (text.startsWith('encrypted:')) return text.replace('encrypted:', '');
        return text;
    }
}

// Store original _resolveFilename
const originalResolveFilename = Module._resolveFilename;

// We need to intercept require calls for:
// - '../../logger' -> mockLogger
// - 'live-srt-lib' -> { Security: MockSecurity }
// - 'ws' -> MockWebSocket

class MockWebSocket extends EventEmitter {
    constructor(url, options) {
        super();
        MockWebSocket.lastInstance = this;
        MockWebSocket.lastUrl = url;
        MockWebSocket.lastOptions = options;
        this.readyState = 1; // OPEN
        this.sentMessages = [];
        this.closed = false;
    }
    send(data) {
        this.sentMessages.push(data);
    }
    close() {
        this.closed = true;
        this.readyState = 3; // CLOSED
    }
    static get OPEN() { return 1; }
    static get CLOSED() { return 3; }
}

// Patch require for the transcriber module
const transcriberPath = path.resolve(__dirname, '../ASR/openai_streaming/index.js');
const loggerPath = path.resolve(__dirname, '../logger.js');

// We'll use a direct approach: temporarily replace modules in the require cache
function setupMocks() {
    // Resolve actual module paths
    const wsModulePath = require.resolve('ws');
    const liveSrtLibPath = require.resolve('live-srt-lib');

    // Save originals
    const origWs = require.cache[wsModulePath];
    const origLiveSrtLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[loggerPath];

    // Inject mocks
    require.cache[wsModulePath] = {
        id: wsModulePath,
        filename: wsModulePath,
        loaded: true,
        exports: MockWebSocket
    };

    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };

    require.cache[loggerPath] = {
        id: loggerPath,
        filename: loggerPath,
        loaded: true,
        exports: mockLogger
    };

    // Clear the transcriber module from cache so it re-requires with mocks
    delete require.cache[transcriberPath];

    // Also clear the voxstral module
    const voxstralPath = path.resolve(__dirname, '../ASR/voxstral/index.js');
    delete require.cache[voxstralPath];

    return function teardown() {
        if (origWs) require.cache[wsModulePath] = origWs;
        else delete require.cache[wsModulePath];
        if (origLiveSrtLib) require.cache[liveSrtLibPath] = origLiveSrtLib;
        else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[loggerPath] = origLogger;
        else delete require.cache[loggerPath];
        delete require.cache[transcriberPath];
        delete require.cache[voxstralPath];
    };
}

// BCP 47 -> ISO 639-3 mapping (from the implementation)
const BCP47_TO_ISO3 = {
    'fr-FR': 'fra',
    'en-US': 'eng',
    'de-DE': 'deu',
    'es-ES': 'spa',
    'it-IT': 'ita',
    'pt-BR': 'por',
    'nl-NL': 'nld',
    'ru-RU': 'rus',
    'zh-CN': 'zho',
    'ja-JP': 'jpn',
    'ko-KR': 'kor',
    'ar-SA': 'ara',
    'hi-IN': 'hin'
};

describe('OpenAIStreamingTranscriber', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        // Set required env vars
        process.env.MIN_AUDIO_BUFFER = '200';
        teardown = setupMocks();
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function createSession() {
        return { id: 'test-session-1' };
    }

    function createChannel(configOverrides = {}) {
        const defaultConfig = {
            type: 'openai_streaming',
            name: 'Test Profile',
            description: 'Test',
            endpoint: 'ws://localhost:8000',
            model: 'test-model',
            protocol: 'vllm',
            languages: [{ candidate: 'en-US' }, { candidate: 'fr-FR' }]
        };
        return {
            id: 'test-channel-1',
            transcriberProfile: {
                config: { ...defaultConfig, ...configOverrides }
            }
        };
    }

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------
    describe('constructor', function () {
        it('should create instance extending EventEmitter', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.ok(t instanceof EventEmitter);
        });

        it('should initialize accumulatedText as empty string', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.strictEqual(t.accumulatedText, '');
        });

        it('should default silenceThresholdMs to 2000', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.strictEqual(t.silenceThresholdMs, 2000);
        });

        it('should use custom silenceThreshold from config', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ silenceThreshold: 3000 })
            );
            assert.strictEqual(t.silenceThresholdMs, 3000);
        });

        it('should default protocol to vllm', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ protocol: undefined })
            );
            assert.strictEqual(t.protocolName, 'vllm');
        });

        it('should accept openai protocol', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ protocol: 'openai' })
            );
            assert.strictEqual(t.protocolName, 'openai');
        });

        it('should throw for invalid protocol', function () {
            assert.throws(() => {
                new OpenAIStreamingTranscriber(
                    createSession(),
                    createChannel({ protocol: 'invalid' })
                );
            }, /Unknown protocol/);
        });
    });

    // -------------------------------------------------------------------
    // Language Detection Mapping
    // -------------------------------------------------------------------
    describe('language mapping (BCP 47 <-> ISO 639-3)', function () {
        it('should build allowedIso3 from config.languages', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.ok(t.allowedIso3.includes('eng'));
            assert.ok(t.allowedIso3.includes('fra'));
            assert.strictEqual(t.allowedIso3.length, 2);
        });

        it('should build iso3ToBcp47 reverse mapping', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.strictEqual(t.iso3ToBcp47['eng'], 'en-US');
            assert.strictEqual(t.iso3ToBcp47['fra'], 'fr-FR');
        });

        it('should handle all 13 supported language mappings', function () {
            const allLangs = Object.keys(BCP47_TO_ISO3).map(c => ({ candidate: c }));
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ languages: allLangs })
            );
            assert.strictEqual(t.allowedIso3.length, 13);
            for (const [bcp47, iso3] of Object.entries(BCP47_TO_ISO3)) {
                assert.ok(t.allowedIso3.includes(iso3), `Missing ${iso3} for ${bcp47}`);
                assert.strictEqual(t.iso3ToBcp47[iso3], bcp47);
            }
        });

        it('should skip languages not in BCP47_TO_ISO3 mapping', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ languages: [{ candidate: 'xx-XX' }, { candidate: 'en-US' }] })
            );
            assert.strictEqual(t.allowedIso3.length, 1);
            assert.ok(t.allowedIso3.includes('eng'));
        });

        it('should handle empty languages array', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ languages: [] })
            );
            assert.strictEqual(t.allowedIso3.length, 0);
        });
    });

    // -------------------------------------------------------------------
    // detectLanguage()
    // -------------------------------------------------------------------
    describe('detectLanguage()', function () {
        it('should return null for empty text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.strictEqual(t.detectLanguage(''), null);
        });

        it('should return null for whitespace-only text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            assert.strictEqual(t.detectLanguage('   '), null);
        });

        it('should return null when no languages configured', function () {
            const t = new OpenAIStreamingTranscriber(
                createSession(),
                createChannel({ languages: [] })
            );
            assert.strictEqual(t.detectLanguage('This is a test sentence in English.'), null);
        });

        it('should detect English for long English text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            const result = t.detectLanguage('This is a relatively long test sentence written in English for language detection purposes.');
            assert.strictEqual(result, 'en-US');
        });

        it('should detect French for long French text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            const result = t.detectLanguage('Ceci est une phrase relativement longue ecrite en francais pour tester la detection de langue.');
            assert.strictEqual(result, 'fr-FR');
        });

        it('should return null for very short text (undetermined)', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            // franc returns 'und' for very short text
            const result = t.detectLanguage('Hi');
            // May be null or en-US depending on franc behavior - both are valid
            // The key point is it does not crash
            assert.ok(result === null || result === 'en-US');
        });
    });

    // -------------------------------------------------------------------
    // handlePartial()
    // -------------------------------------------------------------------
    describe('handlePartial()', function () {
        it('should accumulate delta text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            t.handlePartial('Hello');
            assert.strictEqual(t.accumulatedText, 'Hello');
            t.handlePartial(' world');
            assert.strictEqual(t.accumulatedText, 'Hello world');
        });

        it('should emit transcribing event for non-empty deltas', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            let emitted = false;
            t.on('transcribing', (payload) => {
                emitted = true;
                assert.ok(payload.text);
                assert.strictEqual(payload.astart, t.startedAt);
            });
            t.handlePartial('Hello');
            assert.ok(emitted);
        });

        it('should NOT emit transcribing for empty delta (silence)', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            let emitted = false;
            t.on('transcribing', () => { emitted = true; });
            t.handlePartial('');
            assert.ok(!emitted);
        });

        it('should still accumulate empty deltas', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            t.handlePartial('Hello');
            t.handlePartial('');
            t.handlePartial(' world');
            assert.strictEqual(t.accumulatedText, 'Hello world');
        });

        it('should update lastDeltaTime on non-empty delta', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            assert.strictEqual(t.lastDeltaTime, 0);
            t.handlePartial('Hello');
            assert.ok(t.lastDeltaTime > 0);
        });

        it('should set startTime on first non-empty delta', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            assert.strictEqual(t.startTime, null);
            t.handlePartial('Hello');
            assert.ok(t.startTime !== null);
        });
    });

    // -------------------------------------------------------------------
    // handleFinal()
    // -------------------------------------------------------------------
    describe('handleFinal()', function () {
        it('should emit transcribed event with text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            let emitted = false;
            t.on('transcribed', (payload) => {
                emitted = true;
                assert.strictEqual(payload.text, 'Hello world.');
                assert.strictEqual(payload.astart, t.startedAt);
            });
            t.handleFinal('Hello world.');
            assert.ok(emitted);
        });

        it('should reset accumulatedText after final', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            t.accumulatedText = 'Hello world';
            t.handleFinal('Hello world.');
            assert.strictEqual(t.accumulatedText, '');
        });

        it('should NOT emit for empty text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            t.handleFinal('');
            assert.ok(!emitted);
        });

        it('should NOT emit for whitespace-only text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            t.handleFinal('   ');
            assert.ok(!emitted);
        });

        it('should update lastEndTime after final', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            assert.strictEqual(t.lastEndTime, 0);
            t.handleFinal('Hello world.');
            assert.ok(t.lastEndTime !== 0);
        });
    });

    // -------------------------------------------------------------------
    // formatResult()
    // -------------------------------------------------------------------
    describe('formatResult()', function () {
        it('should produce correct payload structure', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = '2026-01-01T00:00:00.000Z';
            t.startTime = Date.now();
            t.lastEndTime = 0;
            const payload = t.formatResult('test text', 'en-US');
            assert.strictEqual(payload.astart, '2026-01-01T00:00:00.000Z');
            assert.strictEqual(payload.text, 'test text');
            assert.deepStrictEqual(payload.translations, {});
            assert.strictEqual(payload.lang, 'en-US');
            assert.strictEqual(payload.locutor, null);
            assert.strictEqual(typeof payload.start, 'number');
            assert.strictEqual(typeof payload.end, 'number');
        });

        it('should set lang to null when detection returns null', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = '2026-01-01T00:00:00.000Z';
            t.startTime = Date.now();
            t.lastEndTime = 0;
            const payload = t.formatResult('x', null);
            assert.strictEqual(payload.lang, null);
        });
    });

    // -------------------------------------------------------------------
    // stop()
    // -------------------------------------------------------------------
    describe('stop()', function () {
        it('should emit transcribed for remaining accumulated text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.startTime = Date.now();
            t.accumulatedText = 'Final text.';
            let emitted = false;
            t.on('transcribed', (payload) => {
                emitted = true;
                assert.strictEqual(payload.text, 'Final text.');
            });
            t.stop();
            assert.ok(emitted);
            assert.strictEqual(t.accumulatedText, '');
        });

        it('should NOT emit transcribed for empty accumulated text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.accumulatedText = '';
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            t.stop();
            assert.ok(!emitted);
        });

        it('should NOT emit transcribed for whitespace-only accumulated text', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            t.accumulatedText = '   ';
            let emitted = false;
            t.on('transcribed', () => { emitted = true; });
            t.stop();
            assert.ok(!emitted);
        });

        it('should clear silenceTimer if running', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            // Simulate a running timer
            t.silenceTimer = setInterval(() => {}, 10000);
            t.stop();
            assert.strictEqual(t.silenceTimer, null);
        });

        it('should close WebSocket if open', function () {
            const t = new OpenAIStreamingTranscriber(createSession(), createChannel());
            t.startedAt = new Date().toISOString();
            // Simulate an open WebSocket
            const fakeWs = new MockWebSocket('ws://test', {});
            t.ws = fakeWs;
            t.protocol = new (require('../ASR/openai_streaming/protocols/vllm'))({}, mockLogger.getChannelLogger());
            t.stop();
            assert.ok(fakeWs.closed);
            assert.strictEqual(t.ws, null);
        });
    });

    // -------------------------------------------------------------------
    // ERROR_MAP static property
    // -------------------------------------------------------------------
    describe('ERROR_MAP', function () {
        it('should define standard error codes', function () {
            assert.strictEqual(OpenAIStreamingTranscriber.ERROR_MAP[0], 'NO_ERROR');
            assert.strictEqual(OpenAIStreamingTranscriber.ERROR_MAP[1], 'AUTHENTICATION_FAILURE');
            assert.strictEqual(OpenAIStreamingTranscriber.ERROR_MAP[4], 'CONNECTION_FAILURE');
            assert.strictEqual(OpenAIStreamingTranscriber.ERROR_MAP[6], 'SERVICE_ERROR');
        });
    });

    // -------------------------------------------------------------------
    // CRITICAL_FAILURES static property
    // -------------------------------------------------------------------
    describe('CRITICAL_FAILURES', function () {
        it('should include DEPTH_ZERO_SELF_SIGNED_CERT', function () {
            assert.ok(OpenAIStreamingTranscriber.CRITICAL_FAILURES.has('DEPTH_ZERO_SELF_SIGNED_CERT'));
        });
    });
});
