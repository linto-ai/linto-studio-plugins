const assert = require('assert');
const EventEmitter = require('eventemitter3');
const Module = require('module');
const path = require('path');

// ---- Mock setup (same as test_transcriber.js) ----

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

class MockSecurity {
    encrypt(text) { return `encrypted:${text}`; }
    decrypt(text) { return text.replace('encrypted:', ''); }
    safeDecrypt(text) {
        if (text.startsWith('encrypted:')) return text.replace('encrypted:', '');
        return text;
    }
}

class MockWebSocket extends EventEmitter {
    constructor(url, options) {
        super();
        this.readyState = 1;
        this.sentMessages = [];
        this.closed = false;
    }
    send(data) { this.sentMessages.push(data); }
    close() { this.closed = true; this.readyState = 3; }
    static get OPEN() { return 1; }
    static get CLOSED() { return 3; }
}

const transcriberPath = path.resolve(__dirname, '../ASR/openai_streaming/index.js');
const voxstralPath = path.resolve(__dirname, '../ASR/voxstral/index.js');
const loggerPath = path.resolve(__dirname, '../logger.js');

function setupMocks() {
    const wsModulePath = require.resolve('ws');
    const liveSrtLibPath = require.resolve('live-srt-lib');

    const origWs = require.cache[wsModulePath];
    const origLiveSrtLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[loggerPath];

    require.cache[wsModulePath] = {
        id: wsModulePath, filename: wsModulePath, loaded: true,
        exports: MockWebSocket
    };
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };
    require.cache[loggerPath] = {
        id: loggerPath, filename: loggerPath, loaded: true,
        exports: mockLogger
    };

    delete require.cache[transcriberPath];
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

describe('VoxstralTranscriber', function () {
    let VoxstralTranscriber;
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        process.env.MIN_AUDIO_BUFFER = '200';
        teardown = setupMocks();
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
        VoxstralTranscriber = require('../ASR/voxstral/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function createSession() {
        return { id: 'test-session-1' };
    }

    function createChannel(configOverrides = {}) {
        const defaultConfig = {
            type: 'voxstral',
            name: 'Voxstral Test',
            description: 'Test',
            endpoint: 'ws://localhost:8000',
            languages: [{ candidate: 'fr-FR' }, { candidate: 'en-US' }]
        };
        return {
            id: 'test-channel-1',
            transcriberProfile: {
                config: { ...defaultConfig, ...configOverrides }
            }
        };
    }

    // -------------------------------------------------------------------
    // Inheritance
    // -------------------------------------------------------------------
    describe('inheritance', function () {
        it('should extend OpenAIStreamingTranscriber', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            assert.ok(t instanceof OpenAIStreamingTranscriber);
        });

        it('should extend EventEmitter', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            assert.ok(t instanceof EventEmitter);
        });
    });

    // -------------------------------------------------------------------
    // Default overrides
    // -------------------------------------------------------------------
    describe('defaults', function () {
        it('should force protocol to vllm', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            assert.strictEqual(t.protocolName, 'vllm');
        });

        it('should force protocol to vllm even if openai was specified', function () {
            // Voxstral always uses vLLM protocol
            const t = new VoxstralTranscriber(
                createSession(),
                createChannel({ protocol: 'openai' })
            );
            assert.strictEqual(t.protocolName, 'vllm');
        });

        it('should apply default model when not specified', function () {
            const channel = createChannel();
            // Ensure no model is set
            delete channel.transcriberProfile.config.model;
            const t = new VoxstralTranscriber(createSession(), channel);
            // After construction, the config should have the default model
            assert.strictEqual(
                channel.transcriberProfile.config.model,
                'mistralai/Voxtral-Mini-4B-Realtime-2602'
            );
        });

        it('should preserve custom model when specified', function () {
            const t = new VoxstralTranscriber(
                createSession(),
                createChannel({ model: 'custom/voxstral-model' })
            );
            // The config model should be the custom one, not overridden
            assert.strictEqual(
                t._config.model,
                'custom/voxstral-model'
            );
        });
    });

    // -------------------------------------------------------------------
    // Language detection (inherited)
    // -------------------------------------------------------------------
    describe('language detection (inherited)', function () {
        it('should support multi-language detection', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            assert.strictEqual(t.allowedIso3.length, 2);
            assert.ok(t.allowedIso3.includes('fra'));
            assert.ok(t.allowedIso3.includes('eng'));
        });

        it('should detect French for French text', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            const result = t.detectLanguage('Ceci est une phrase relativement longue ecrite en francais pour tester la detection de langue.');
            assert.strictEqual(result, 'fr-FR');
        });

        it('should detect English for English text', function () {
            const t = new VoxstralTranscriber(createSession(), createChannel());
            const result = t.detectLanguage('This is a relatively long test sentence written in English for language detection purposes.');
            assert.strictEqual(result, 'en-US');
        });
    });

    // -------------------------------------------------------------------
    // Supported Voxstral languages
    // -------------------------------------------------------------------
    describe('supported languages (all 13)', function () {
        const allVoxstralLangs = [
            'en-US', 'zh-CN', 'hi-IN', 'es-ES', 'ar-SA',
            'fr-FR', 'pt-BR', 'ru-RU', 'de-DE', 'ja-JP',
            'ko-KR', 'it-IT', 'nl-NL'
        ];

        it('should accept all 13 Voxstral-supported languages', function () {
            const languages = allVoxstralLangs.map(c => ({ candidate: c }));
            const t = new VoxstralTranscriber(
                createSession(),
                createChannel({ languages })
            );
            assert.strictEqual(t.allowedIso3.length, 13);
        });
    });
});
