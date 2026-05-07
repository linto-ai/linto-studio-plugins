const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

const helpersPath = path.resolve(__dirname, '../../Session-API/components/WebServer/routes/api/translationHelpers.js');
const liveSrtLibPath = require.resolve('live-srt-lib');

let mockTranslators = [];

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: {
            Model: {
                Translator: {
                    findAll: async () => mockTranslators,
                },
            },
            logger: { info() {}, warn() {}, error() {}, debug() {} },
        }
    };
    delete require.cache[helpersPath];
    return function teardown() {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        delete require.cache[helpersPath];
    };
}

describe('translationHelpers (Session-API)', () => {
    let helpers;
    let teardown;

    before(() => {
        teardown = setupMocks();
        helpers = require(helpersPath);
    });

    after(() => { if (teardown) teardown(); });

    beforeEach(() => { mockTranslators = []; });

    describe('bcp47Equal()', () => {
        it('treats pt-PT and pt-pt as equal (canonical)', () => {
            assert.strictEqual(helpers.bcp47Equal('pt-PT', 'pt-pt'), true);
            assert.strictEqual(helpers.bcp47Equal('PT-pt', 'pt-PT'), true);
        });

        it('treats pt-PT and pt-BR as DIFFERENT', () => {
            assert.strictEqual(helpers.bcp47Equal('pt-PT', 'pt-BR'), false);
        });

        it('treats pt and pt-PT as DIFFERENT', () => {
            assert.strictEqual(helpers.bcp47Equal('pt', 'pt-PT'), false);
        });

        it('treats fr-FR and fr as DIFFERENT (canonical-strict)', () => {
            assert.strictEqual(helpers.bcp47Equal('fr-FR', 'fr'), false);
        });

        it('handles invalid tags via case-insensitive fallback', () => {
            assert.strictEqual(helpers.bcp47Equal('xx-yy', 'XX-YY'), true);
            assert.strictEqual(helpers.bcp47Equal('xx-yy', 'aa-bb'), false);
        });

        it('rejects non-string inputs', () => {
            assert.strictEqual(helpers.bcp47Equal(null, 'pt-PT'), false);
            assert.strictEqual(helpers.bcp47Equal('pt-PT', undefined), false);
        });
    });

    describe('validateTranslations()', () => {
        it('converts legacy string entries to objects', () => {
            const out = helpers.validateTranslations(['pt-PT', 'fr-CA']);
            assert.deepStrictEqual(out, [
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'fr-CA', mode: 'discrete' },
            ]);
        });

        it('returns null for null input', () => {
            assert.strictEqual(helpers.validateTranslations(null), null);
        });

        it('rejects invalid BCP47 tags', () => {
            assert.throws(() => helpers.validateTranslations(['totally-fake']), /Invalid BCP47 tag/);
            assert.throws(() => helpers.validateTranslations(['!!!']), /Invalid BCP47 tag/);
        });

        it('rejects entries missing target/mode', () => {
            assert.throws(() => helpers.validateTranslations([{ target: 'pt-PT' }]), /target.*mode/);
        });

        it('rejects external mode without translator field', () => {
            assert.throws(() => helpers.validateTranslations([{ target: 'pt-PT', mode: 'external' }]), /translator/);
        });

        it('rejects mixing pt and pt-PT (ambiguous primary subtag)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'pt', mode: 'discrete' },
                    { target: 'pt-PT', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('rejects mixing pt and pt-BR (ambiguous primary subtag)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'pt', mode: 'discrete' },
                    { target: 'pt-BR', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('accepts pt-PT and pt-BR side-by-side (both have region)', () => {
            const out = helpers.validateTranslations([
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'pt-BR', mode: 'discrete' },
            ]);
            assert.strictEqual(out.length, 2);
        });

        it('rejects exact duplicate entries', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'pt-PT', mode: 'discrete' },
                    { target: 'pt-pt', mode: 'discrete' },
                ]),
                /Duplicate translation target/
            );
        });

        it('rejects fr + fr-CA (Azure has fr-ca distinct, so collision risk)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'fr', mode: 'discrete' },
                    { target: 'fr-CA', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('accepts en + en-US (Azure has no en regional variants → no collision risk)', () => {
            const out = helpers.validateTranslations([
                { target: 'en', mode: 'discrete' },
                { target: 'en-US', mode: 'discrete' },
            ]);
            assert.strictEqual(out.length, 2);
        });

        it('accepts es + es-MX (Azure has no es regional variants → no collision risk)', () => {
            const out = helpers.validateTranslations([
                { target: 'es', mode: 'discrete' },
                { target: 'es-MX', mode: 'discrete' },
            ]);
            assert.strictEqual(out.length, 2);
        });

        it('rejects zh + zh-Hans (Azure has zh script variants → collision risk)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'zh', mode: 'discrete' },
                    { target: 'zh-Hans', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('rejects sr + sr-Latn (Azure has sr script variants → collision risk)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'sr', mode: 'discrete' },
                    { target: 'sr-Latn', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('rejects tlh + tlh-Piqd (Azure has tlh script variants → collision risk)', () => {
            assert.throws(
                () => helpers.validateTranslations([
                    { target: 'tlh', mode: 'discrete' },
                    { target: 'tlh-Piqd', mode: 'discrete' },
                ]),
                /Ambiguous translation targets/
            );
        });

        it('rejects a non-array translations input', () => {
            assert.throws(() => helpers.validateTranslations('pt-PT'), /must be an array/);
            assert.throws(() => helpers.validateTranslations({ target: 'pt-PT' }), /must be an array/);
        });
    });

    describe('enrichTranslations()', () => {
        function makeProfile(availableTranslations) {
            return { config: { availableTranslations } };
        }

        it('keeps pt-PT as discrete when profile lists pt-PT', async () => {
            const profile = makeProfile([{ target: 'pt-PT', mode: 'discrete' }]);
            const out = await helpers.enrichTranslations(
                [{ target: 'pt-PT', mode: 'discrete' }],
                profile
            );
            assert.deepStrictEqual(out, [{ target: 'pt-PT', mode: 'discrete' }]);
        });

        it('does NOT match pt-PT against profile pt-BR (strict canonical)', async () => {
            // Profile only supports pt-BR. User requests pt-PT. No external translator either.
            // Result: falls through to discrete unchanged (current fallback semantics).
            const profile = makeProfile([{ target: 'pt-BR', mode: 'discrete' }]);
            const out = await helpers.enrichTranslations(
                [{ target: 'pt-PT', mode: 'discrete' }],
                profile
            );
            assert.deepStrictEqual(out, [{ target: 'pt-PT', mode: 'discrete' }]);
        });

        it('routes to external translator when profile does not support discrete', async () => {
            mockTranslators = [{ name: 'deepl', languages: ['pt-PT', 'de-DE'], online: true }];
            const profile = makeProfile([{ target: 'pt-BR', mode: 'discrete' }]);
            const out = await helpers.enrichTranslations(
                [{ target: 'pt-PT', mode: 'discrete' }],
                profile
            );
            assert.deepStrictEqual(out, [
                { target: 'pt-PT', mode: 'external', translator: 'deepl' },
            ]);
        });

        it('keeps explicit external entries unchanged', async () => {
            const profile = makeProfile([{ target: 'pt-PT', mode: 'discrete' }]);
            const out = await helpers.enrichTranslations(
                [{ target: 'pt-PT', mode: 'external', translator: 'deepl' }],
                profile
            );
            assert.deepStrictEqual(out, [
                { target: 'pt-PT', mode: 'external', translator: 'deepl' },
            ]);
        });

        it('canonical equality: pt-PT in profile matches pt-pt request', async () => {
            const profile = makeProfile([{ target: 'pt-PT', mode: 'discrete' }]);
            const out = await helpers.enrichTranslations(
                [{ target: 'pt-pt', mode: 'discrete' }],
                profile
            );
            assert.deepStrictEqual(out, [{ target: 'pt-pt', mode: 'discrete' }]);
        });
    });
});
