const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// ---- Mock setup: intercept require() before loading MicrosoftTranscriber ----

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

// SDK mocks: we only need shape for the parts MicrosoftTranscriber touches.
// addTargetLanguage records calls on a per-instance array for assertions.
class MockSpeechTranslationConfig {
    constructor() {
        this.targetLanguages = [];
        this.properties = new Map();
    }
    addTargetLanguage(code) { this.targetLanguages.push(code); }
    setProperty(id, value) { this.properties.set(id, value); }
    static fromSubscription() { return new MockSpeechTranslationConfig(); }
    static fromEndpoint() { return new MockSpeechTranslationConfig(); }
}

class MockSpeechConfig {
    setProperty() {}
    static fromSubscription() { return new MockSpeechConfig(); }
    static fromEndpoint() { return new MockSpeechConfig(); }
}

// Each recognizer class implements the start/stop async lifecycle hooks the
// transcriber wires onto it. Synchronous resolution keeps the tests fast.
class MockTranslationRecognizer {
    static FromConfig() { return new this(); }
    startContinuousRecognitionAsync(onSuccess) { if (onSuccess) onSuccess(); }
    stopContinuousRecognitionAsync(onSuccess) { if (onSuccess) onSuccess(); }
    close() {}
}

class MockSpeechRecognizer {
    static FromConfig() { return new this(); }
    startContinuousRecognitionAsync(onSuccess) { if (onSuccess) onSuccess(); }
    stopContinuousRecognitionAsync(onSuccess) { if (onSuccess) onSuccess(); }
    close() {}
}

class MockConversationTranscriber {
    static FromConfig() { return new this(); }
    startTranscribingAsync(onSuccess) { if (onSuccess) onSuccess(); }
    stopTranscribingAsync(onSuccess) { if (onSuccess) onSuccess(); }
    close() {}
}

const mockSpeechSdk = {
    AudioInputStream: { createPushStream: () => ({ write() {}, close() {} }) },
    AudioConfig: { fromStreamInput: () => ({}) },
    SpeechConfig: MockSpeechConfig,
    SpeechTranslationConfig: MockSpeechTranslationConfig,
    PropertyId: { SpeechServiceConnection_ContinuousLanguageId: 1, SpeechServiceConnection_LanguageIdMode: 2 },
    TranslationRecognizer: MockTranslationRecognizer,
    SpeechRecognizer: MockSpeechRecognizer,
    ConversationTranscriber: MockConversationTranscriber,
    ResultReason: { RecognizedSpeech: 1, TranslatedSpeech: 2 },
    AutoDetectSourceLanguageConfig: { fromSourceLanguageConfigs: () => ({}) },
    AutoDetectSourceLanguageResult: {},
    SourceLanguageConfig: { fromLanguage: () => ({}) },
};

const sdkPath = require.resolve('microsoft-cognitiveservices-speech-sdk');
const liveSrtLibPath = require.resolve('live-srt-lib');
const microsoftIndexPath = path.resolve(__dirname, '../ASR/microsoft/index.js');
const microsoftLoggerPath = path.resolve(__dirname, '../logger.js');

function setupMocks() {
    const origSdk = require.cache[sdkPath];
    const origLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[microsoftLoggerPath];

    require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: mockSpeechSdk };
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };
    require.cache[microsoftLoggerPath] = {
        id: microsoftLoggerPath, filename: microsoftLoggerPath, loaded: true, exports: mockLogger
    };
    delete require.cache[microsoftIndexPath];

    return function teardown() {
        if (origSdk) require.cache[sdkPath] = origSdk; else delete require.cache[sdkPath];
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[microsoftLoggerPath] = origLogger; else delete require.cache[microsoftLoggerPath];
        delete require.cache[microsoftIndexPath];
    };
}

// Mimics the Translations class from the speech SDK.
function makeTranslationsMock(entries) {
    return {
        get(key, def) { return key in entries ? entries[key] : def; },
        languages: Object.keys(entries),
    };
}

function makeChannel(translations, language = 'en-US') {
    return {
        id: 'channel-1',
        translations,
        transcriberProfile: {
            config: {
                key: 'plain-key',
                region: 'westeurope',
                languages: [{ candidate: language }],
            },
        },
    };
}

describe('MicrosoftTranscriber', () => {
    let MicrosoftTranscriber;
    let teardown;

    before(() => {
        teardown = setupMocks();
        MicrosoftTranscriber = require('../ASR/microsoft/index.js');
    });

    after(() => { if (teardown) teardown(); });

    describe('getTranslationKeyMap()', () => {
        it('maps pt-PT to Azure code pt-pt', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const map = t.getTranslationKeyMap();
            assert.strictEqual(map.size, 1);
            assert.strictEqual(map.get('pt-pt'), 'pt-PT');
        });

        it('maps pt-BR to Azure code pt (default Brazilian)', () => {
            const channel = makeChannel([{ target: 'pt-BR', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const map = t.getTranslationKeyMap();
            assert.strictEqual(map.get('pt'), 'pt-BR');
        });

        it('handles fr-CA and fr-FR distinctly (fr-ca vs fr)', () => {
            const channel = makeChannel([
                { target: 'fr-CA', mode: 'discrete' },
                { target: 'fr-FR', mode: 'discrete' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const map = t.getTranslationKeyMap();
            assert.strictEqual(map.get('fr-ca'), 'fr-CA');
            assert.strictEqual(map.get('fr'), 'fr-FR');
        });

        it('handles zh-Hans script subtag in Title Case', () => {
            const channel = makeChannel([{ target: 'zh-Hans', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            assert.strictEqual(t.getTranslationKeyMap().get('zh-Hans'), 'zh-Hans');
        });

        it('skips entries with mode external', () => {
            const channel = makeChannel([
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'de-DE', mode: 'external', translator: 'deepl' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const map = t.getTranslationKeyMap();
            assert.strictEqual(map.size, 1);
            assert.ok(map.has('pt-pt'));
            assert.ok(!map.has('de'));
        });

        it('accepts legacy plain string format', () => {
            const channel = makeChannel(['pt-PT', 'fr-CA']);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const map = t.getTranslationKeyMap();
            assert.strictEqual(map.get('pt-pt'), 'pt-PT');
            assert.strictEqual(map.get('fr-ca'), 'fr-CA');
        });

        it('returns empty map for empty/missing translations', () => {
            const t1 = new MicrosoftTranscriber({ id: 's' }, makeChannel([]));
            const t2 = new MicrosoftTranscriber({ id: 's' }, makeChannel(null));
            const t3 = new MicrosoftTranscriber({ id: 's' }, makeChannel(undefined));
            assert.strictEqual(t1.getTranslationKeyMap().size, 0);
            assert.strictEqual(t2.getTranslationKeyMap().size, 0);
            assert.strictEqual(t3.getTranslationKeyMap().size, 0);
        });

        it('returns empty map when translations is not an array (string, object)', () => {
            const t1 = new MicrosoftTranscriber({ id: 's' }, makeChannel('pt-PT'));
            const t2 = new MicrosoftTranscriber({ id: 's' }, makeChannel({ target: 'pt-PT' }));
            assert.strictEqual(t1.getTranslationKeyMap().size, 0);
            assert.strictEqual(t2.getTranslationKeyMap().size, 0);
        });

        it('warns via logger.warn when target resolves to a code outside AZURE_VALID_TARGETS', () => {
            const channel = makeChannel([{ target: 'xx-YY', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const warnings = [];
            t.logger = { info() {}, warn(msg) { warnings.push(msg); }, error() {}, debug() {}, log() {} };
            t.getTranslationKeyMap();
            assert.ok(
                warnings.some(w => w.includes('xx-YY')),
                `expected warn referencing 'xx-YY'; got ${JSON.stringify(warnings)}`
            );
        });
    });

    describe('getTargetLanguages()', () => {
        it('returns Azure codes (no truncation for distinct variants)', () => {
            const channel = makeChannel([
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'fr-FR', mode: 'discrete' },
                { target: 'zh-Hans', mode: 'discrete' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const langs = t.getTargetLanguages();
            assert.deepStrictEqual(langs.sort(), ['fr', 'pt-pt', 'zh-Hans']);
        });
    });

    describe('formatResult()', () => {
        it('returns Portuguese under pt-PT key (not pt) when Azure responds under pt-pt', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = {
                text: 'hello',
                translations: makeTranslationsMock({ 'pt-pt': 'olá, sou' }),
                offset: 0, duration: 0, language: 'en-US',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá, sou' });
        });

        it('preserves original user keys for pt-PT and pt-BR side-by-side', () => {
            const channel = makeChannel([
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'fr-FR', mode: 'discrete' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = {
                text: 'hello',
                translations: makeTranslationsMock({ 'pt-pt': 'olá', 'fr': 'bonjour' }),
                offset: 0, duration: 0, language: 'en-US',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá', 'fr-FR': 'bonjour' });
        });

        it('matches Azure-returned keys case-insensitively via the languages fallback', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);

            // Strict-case .get() proves the fallback is actually exercised: the
            // direct lookup on 'pt-pt' returns undefined, forcing the code to
            // scan .languages and re-fetch with the matched key.
            const lookups = [];
            const result = {
                text: 'hello',
                translations: {
                    get(key) {
                        lookups.push(key);
                        if (key === 'PT-pt') return 'olá';
                        return undefined;
                    },
                    languages: ['PT-pt'],
                },
                offset: 0, duration: 0, language: 'en-US',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá' });
            assert.ok(lookups.includes('pt-pt'),
                'expected initial direct lookup on canonical Azure code');
            assert.ok(lookups.includes('PT-pt'),
                'expected fallback lookup using key discovered via .languages');
        });

        it('returns empty translations when result has none', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = { text: 'hello', offset: 0, duration: 0, language: 'en-US' };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, {});
        });

        it('omits keys with no value rather than emitting undefined', () => {
            const channel = makeChannel([
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'fr-CA', mode: 'discrete' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = {
                text: 'hello',
                translations: makeTranslationsMock({ 'pt-pt': 'olá' }),
                offset: 0, duration: 0, language: 'en-US',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá' });
        });

        it('handles undefined translations.languages without throwing', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = {
                text: 'hello',
                translations: {
                    get(key) { return key === 'pt-pt' ? 'olá' : undefined; },
                    languages: undefined,
                },
                offset: 0, duration: 0, language: 'en-US',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá' });
        });

        it('handles result.translations === null', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = { text: 'hi', translations: null, offset: 0, duration: 0, language: 'en' };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, {});
        });

        it('handles mixed legacy-string and object entries in channel.translations', () => {
            const channel = makeChannel([
                'pt-PT',
                { target: 'fr-CA', mode: 'discrete' },
            ]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const result = {
                text: 'hi',
                translations: makeTranslationsMock({ 'pt-pt': 'olá', 'fr-ca': 'salut' }),
                offset: 0, duration: 0, language: 'en',
            };
            const out = t.formatResult(result);
            assert.deepStrictEqual(out.translations, { 'pt-PT': 'olá', 'fr-CA': 'salut' });
        });
    });

    describe('createSpeechConfig() — addTargetLanguage receives Azure codes', () => {
        it('sends pt-pt to Azure when user requested pt-PT', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const speechConfig = t.createSpeechConfig(channel.transcriberProfile.config, channel.translations);
            assert.deepStrictEqual(speechConfig.targetLanguages, ['pt-pt']);
        });

        it('sends pt to Azure when user requested pt-BR', () => {
            const channel = makeChannel([{ target: 'pt-BR', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const speechConfig = t.createSpeechConfig(channel.transcriberProfile.config, channel.translations);
            assert.deepStrictEqual(speechConfig.targetLanguages, ['pt']);
        });

        it('sends zh-Hans (Title Case) to Azure when user requested zh-hans', () => {
            const channel = makeChannel([{ target: 'zh-hans', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            const speechConfig = t.createSpeechConfig(channel.transcriberProfile.config, channel.translations);
            assert.deepStrictEqual(speechConfig.targetLanguages, ['zh-Hans']);
        });
    });

    describe('lifecycle: start() / transcribe() / stop()', () => {
        function makeMultiLangChannel(translations) {
            return {
                id: 'channel-1',
                translations,
                diarization: false,
                transcriberProfile: {
                    config: {
                        key: 'plain-key',
                        region: 'westeurope',
                        languages: [{ candidate: 'en-US' }, { candidate: 'fr-FR' }],
                    },
                },
            };
        }

        it('start() creates one recognizer for mono-language without translations', () => {
            const channel = makeChannel(null);
            channel.diarization = false;
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();
            assert.strictEqual(t.recognizers.length, 1);
            assert.strictEqual(t.pushStreams.length, 1);
            t.stop();
        });

        it('start() creates dual recognizers when translations + diarization both enabled', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            channel.diarization = true;
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();
            assert.strictEqual(t.recognizers.length, 2,
                'expected one diarization recognizer + one translation recognizer');
            assert.strictEqual(t.pushStreams.length, 2);
            t.stop();
        });

        it('start() with multi-language + translations uses universal endpoint and addTargetLanguage', () => {
            const channel = makeMultiLangChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();
            const speechConfig = t.createSpeechConfig(channel.transcriberProfile.config, channel.translations);
            assert.deepStrictEqual(speechConfig.targetLanguages, ['pt-pt']);
            t.stop();
        });

        it('transcribe(buffer) writes to every active push stream', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            channel.diarization = true;
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();

            const writes = [];
            for (const ps of t.pushStreams) {
                ps.write = (b) => writes.push(b);
            }
            const buffer = Buffer.from([1, 2, 3, 4]);
            t.transcribe(buffer);

            assert.strictEqual(writes.length, 2, 'expected one write per push stream');
            assert.strictEqual(writes[0], buffer);
            assert.strictEqual(writes[1], buffer);
            t.stop();
        });

        it('transcribe() before start() warns once and drops audio without crashing', () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            // No start() call → recognizers empty.
            assert.strictEqual(t.recognizers.length, 0);
            assert.doesNotThrow(() => t.transcribe(Buffer.from([1, 2])));
        });

        it('start() after stop() rebuilds the translation key map (cache invalidation)', async () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();
            const map1 = t.getTranslationKeyMap();
            assert.strictEqual(map1.get('pt-pt'), 'pt-PT');
            await t.stop();

            // Mutate the channel between cycles to verify the cache is invalidated.
            channel.translations = [{ target: 'fr-CA', mode: 'discrete' }];
            t.start();
            const map2 = t.getTranslationKeyMap();
            assert.ok(!map2.has('pt-pt'), 'cache should be invalidated after stop+start');
            assert.strictEqual(map2.get('fr-ca'), 'fr-CA');
            await t.stop();
        });

        it('stop() resets recognizers and pushStreams to empty', async () => {
            const channel = makeChannel([{ target: 'pt-PT', mode: 'discrete' }]);
            const t = new MicrosoftTranscriber({ id: 's' }, channel);
            t.start();
            assert.ok(t.recognizers.length > 0);
            await t.stop();
            assert.strictEqual(t.recognizers.length, 0);
            assert.strictEqual(t.pushStreams.length, 0);
        });
    });
});
