const assert = require('assert');
const EventEmitter = require('eventemitter3');
const { setupMocks } = require('./helpers/asr_mocks');

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
