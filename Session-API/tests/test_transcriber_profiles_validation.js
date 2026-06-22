/**
 * Unit tests for the transcriber-profile helpers. Unlike the previous version
 * (which lived in the Transcriber suite and RE-IMPLEMENTED the validation
 * logic, so the route could drift undetected), this imports the REAL helpers
 * from transcriber_profiles.helpers.js — the same code the route runs. Any
 * change to validation / extension / secret handling is caught here.
 *
 * It runs in the Session-API suite where language-tags and live-srt-lib resolve.
 */
const assert = require('assert');
const { describe, it, before, after } = require('mocha');

// Exercise the REAL Security crypto by giving it a key for this run. Without a
// key Security.encrypt is a documented no-op (returns plaintext), so we set one
// to assert genuine round-tripping rather than a pass-through.
const ORIGINAL_CRYPT_KEY = process.env.SECURITY_CRYPT_KEY;
before(() => { process.env.SECURITY_CRYPT_KEY = 'test-crypt-key-transcriber-profiles'; });
after(() => {
    if (ORIGINAL_CRYPT_KEY === undefined) delete process.env.SECURITY_CRYPT_KEY;
    else process.env.SECURITY_CRYPT_KEY = ORIGINAL_CRYPT_KEY;
});

const { Security } = require('live-srt-lib');
const {
    isValidLocale,
    validateTranscriberProfile,
    cryptTranscriberProfileKey,
    obfuscateTranscriberProfileKey,
    extendTranscriberProfile,
} = require('../components/WebServer/routes/api/transcriber_profiles.helpers');

describe('Transcriber Profile helpers (real source)', function () {

    describe('isValidLocale() — real language-tags', function () {
        it('accepts well-formed BCP-47 tags', function () {
            assert.strictEqual(!!isValidLocale('en-US'), true);
            assert.strictEqual(!!isValidLocale('fr-FR'), true);
            assert.strictEqual(!!isValidLocale('de-DE'), true);
        });
        it('rejects unregistered tags the old regex would have accepted (drift guard)', function () {
            // The previous re-implemented test used /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
            // which accepts 'zz-ZZ'; the real validator rejects it.
            assert.strictEqual(!!isValidLocale('zz-ZZ'), false);
            assert.strictEqual(!!isValidLocale('not a locale'), false);
        });
    });

    describe('validateTranscriberProfile() — google', function () {
        it('accepts a valid google profile with languages and credentials', function () {
            const result = validateTranscriberProfile({
                config: {
                    type: 'google',
                    name: 'Google STT',
                    description: 'Test',
                    credentials: '{"type":"service_account","project_id":"p"}',
                    languages: [{ candidate: 'en-US' }, { candidate: 'fr-FR' }],
                },
            });
            assert.strictEqual(result, undefined, 'valid google profile should return undefined');
        });

        it('rejects google without credentials on create', function () {
            const result = validateTranscriberProfile({
                config: {
                    type: 'google', name: 'Google STT', description: 'Test',
                    languages: [{ candidate: 'en-US' }],
                },
            });
            assert.ok(result);
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('credentials'));
        });

        it('accepts google without credentials on update (partial update keeps stored key)', function () {
            const result = validateTranscriberProfile({
                config: {
                    type: 'google', name: 'Google STT', description: 'Test',
                    languages: [{ candidate: 'en-US' }],
                },
            }, true);
            assert.strictEqual(result, undefined);
        });

        it('rejects google with an invalid locale even when credentials are present', function () {
            const result = validateTranscriberProfile({
                config: {
                    type: 'google', name: 'Google STT', description: 'Test',
                    credentials: '{"type":"service_account"}',
                    languages: [{ candidate: 'zz-ZZ' }],
                },
            });
            assert.ok(result);
            assert.strictEqual(result.status, 400);
        });
    });

    describe('validateTranscriberProfile() — other providers (regression)', function () {
        it('accepts a valid openai_streaming profile', function () {
            assert.strictEqual(validateTranscriberProfile({
                config: {
                    type: 'openai_streaming', name: 'x', description: 'x',
                    endpoint: 'ws://localhost:8000', model: 'm', protocol: 'vllm',
                    languages: [{ candidate: 'en-US' }],
                },
            }), undefined);
        });
        it('rejects openai_streaming with an unknown protocol', function () {
            const r = validateTranscriberProfile({
                config: {
                    type: 'openai_streaming', name: 'x', description: 'x',
                    endpoint: 'ws://localhost:8000', model: 'm', protocol: 'together',
                    languages: [{ candidate: 'en-US' }],
                },
            });
            assert.ok(r); assert.strictEqual(r.status, 400);
        });
        it('rejects voxstral without endpoint', function () {
            const r = validateTranscriberProfile({
                config: { type: 'voxstral', name: 'x', description: 'x', languages: [{ candidate: 'fr-FR' }] },
            });
            assert.ok(r); assert.ok(r.error.includes('endpoint'));
        });
        it('rejects a missing config object', function () {
            const r = validateTranscriberProfile({});
            assert.ok(r); assert.strictEqual(r.status, 400);
        });
        it('rejects an empty languages array', function () {
            const r = validateTranscriberProfile({
                config: { type: 'voxstral', name: 'x', description: 'x', endpoint: 'ws://h', languages: [] },
            });
            assert.ok(r); assert.strictEqual(r.status, 400);
        });
    });

    describe('cryptTranscriberProfileKey() — real Security round-trip', function () {
        it('encrypts the google credentials field and it decrypts back', function () {
            const sa = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n"}';
            const body = cryptTranscriberProfileKey({ config: { type: 'google', credentials: sa } });
            assert.notStrictEqual(body.config.credentials, sa, 'credentials must be transformed');
            assert.ok(body.config.credentials.startsWith('enc:'), 'should be a tagged ciphertext');
            assert.strictEqual(new Security().safeDecrypt(body.config.credentials), sa, 'round-trips to plaintext');
        });
        it('encrypts key and apiKey when present', function () {
            const body = cryptTranscriberProfileKey({ config: { key: 'ms-key', apiKey: 'sk-test' } });
            assert.strictEqual(new Security().safeDecrypt(body.config.key), 'ms-key');
            assert.strictEqual(new Security().safeDecrypt(body.config.apiKey), 'sk-test');
        });
        it('leaves config untouched when no secret fields are present', function () {
            const body = cryptTranscriberProfileKey({ config: { type: 'voxstral', endpoint: 'ws://h' } });
            assert.strictEqual(body.config.credentials, undefined);
            assert.strictEqual(body.config.endpoint, 'ws://h');
        });
    });

    describe('obfuscateTranscriberProfileKey()', function () {
        it('hides the google credentials in a GET response', function () {
            const p = obfuscateTranscriberProfileKey({ config: { type: 'google', credentials: 'enc:v2:whatever' } });
            assert.strictEqual(p.config.credentials, 'Secret credentials are hidden');
        });
        it('hides key and apiKey', function () {
            const p = obfuscateTranscriberProfileKey({ config: { key: 'enc:v2:a', apiKey: 'enc:v2:b' } });
            assert.strictEqual(p.config.key, 'Secret key is hidden');
            assert.strictEqual(p.config.apiKey, 'Secret key is hidden');
        });
    });

    describe('extendTranscriberProfile() — google self-contained diarization', function () {
        before(() => { delete process.env.ASR_HAS_DIARIZATION_GOOGLE; });

        it('derives hasDiarization from the profile when no env var is set', function () {
            const enabled = extendTranscriberProfile({ config: { type: 'google', hasDiarization: true } });
            assert.strictEqual(enabled.config.hasDiarization, true);
            const disabled = extendTranscriberProfile({ config: { type: 'google', hasDiarization: false } });
            assert.strictEqual(disabled.config.hasDiarization, false);
            const omitted = extendTranscriberProfile({ config: { type: 'google' } });
            assert.strictEqual(omitted.config.hasDiarization, false);
        });

        it('lets an explicit env var still override the google profile value', function () {
            process.env.ASR_HAS_DIARIZATION_GOOGLE = 'TRUE';
            try {
                const body = extendTranscriberProfile({ config: { type: 'google', hasDiarization: false } });
                assert.strictEqual(body.config.hasDiarization, true);
            } finally {
                delete process.env.ASR_HAS_DIARIZATION_GOOGLE;
            }
        });

        it('defaults non-google providers to hasDiarization=false and empty availableTranslations', function () {
            const body = extendTranscriberProfile({ config: { type: 'voxstral' } });
            assert.strictEqual(body.config.hasDiarization, false);
            assert.deepStrictEqual(body.config.availableTranslations, []);
        });
    });
});
