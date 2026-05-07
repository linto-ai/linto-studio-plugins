const assert = require('assert');
const { describe, it } = require('mocha');
const { toAzureCode, isAzureValid, AZURE_DISTINCT_TARGETS } = require('../ASR/microsoft/azureLocale');

describe('azureLocale', () => {
    describe('toAzureCode()', () => {
        it('preserves Azure-distinct region variants in lowercase', () => {
            assert.strictEqual(toAzureCode('pt-PT'), 'pt-pt');
            assert.strictEqual(toAzureCode('pt-pt'), 'pt-pt');
            assert.strictEqual(toAzureCode('PT-PT'), 'pt-pt');
            assert.strictEqual(toAzureCode('fr-CA'), 'fr-ca');
            assert.strictEqual(toAzureCode('FR-ca'), 'fr-ca');
        });

        it('preserves Azure-distinct script variants in Title Case', () => {
            assert.strictEqual(toAzureCode('zh-Hans'), 'zh-Hans');
            assert.strictEqual(toAzureCode('zh-hans'), 'zh-Hans');
            assert.strictEqual(toAzureCode('ZH-HANS'), 'zh-Hans');
            assert.strictEqual(toAzureCode('sr-Latn'), 'sr-Latn');
            assert.strictEqual(toAzureCode('sr-cyrl'), 'sr-Cyrl');
            assert.strictEqual(toAzureCode('tlh-Piqd'), 'tlh-Piqd');
        });

        it('collapses non-Azure-distinct variants to primary subtag', () => {
            // pt-BR is Azure default for primary 'pt' (Brazilian)
            assert.strictEqual(toAzureCode('pt-BR'), 'pt');
            // fr-FR is Azure default for primary 'fr' (European French)
            assert.strictEqual(toAzureCode('fr-FR'), 'fr');
            // en-US, en-GB collapse to 'en' (Azure has no regional English target)
            assert.strictEqual(toAzureCode('en-US'), 'en');
            assert.strictEqual(toAzureCode('en-GB'), 'en');
            // es-ES, es-MX collapse to 'es'
            assert.strictEqual(toAzureCode('es-ES'), 'es');
            assert.strictEqual(toAzureCode('es-MX'), 'es');
        });

        it('passes through bare primary subtags unchanged', () => {
            assert.strictEqual(toAzureCode('pt'), 'pt');
            assert.strictEqual(toAzureCode('fr'), 'fr');
            assert.strictEqual(toAzureCode('en'), 'en');
            assert.strictEqual(toAzureCode('zh'), 'zh');
        });

        it('handles edge cases without throwing', () => {
            assert.strictEqual(toAzureCode(''), '');
            assert.strictEqual(toAzureCode(null), null);
            assert.strictEqual(toAzureCode(undefined), undefined);
            assert.strictEqual(toAzureCode(42), 42);
        });

        it('lowercases the primary subtag', () => {
            assert.strictEqual(toAzureCode('PT'), 'pt');
            assert.strictEqual(toAzureCode('Fr'), 'fr');
        });
    });

    describe('isAzureValid()', () => {
        it('accepts canonical Azure target codes', () => {
            assert.strictEqual(isAzureValid('pt'), true);
            assert.strictEqual(isAzureValid('pt-pt'), true);
            assert.strictEqual(isAzureValid('fr'), true);
            assert.strictEqual(isAzureValid('fr-ca'), true);
            assert.strictEqual(isAzureValid('zh-Hans'), true);
            assert.strictEqual(isAzureValid('zh-Hant'), true);
            assert.strictEqual(isAzureValid('en'), true);
        });

        it('rejects unsupported codes', () => {
            assert.strictEqual(isAzureValid('pt-PT'), false);
            assert.strictEqual(isAzureValid('pt-BR'), false);
            assert.strictEqual(isAzureValid('fr-FR'), false);
            assert.strictEqual(isAzureValid('en-US'), false);
            assert.strictEqual(isAzureValid('xx'), false);
            assert.strictEqual(isAzureValid('zh'), false);
        });

        it('chains correctly with toAzureCode', () => {
            assert.strictEqual(isAzureValid(toAzureCode('pt-PT')), true);
            assert.strictEqual(isAzureValid(toAzureCode('pt-BR')), true);
            assert.strictEqual(isAzureValid(toAzureCode('fr-CA')), true);
            assert.strictEqual(isAzureValid(toAzureCode('fr-FR')), true);
            assert.strictEqual(isAzureValid(toAzureCode('zh-Hans')), true);
        });
    });

    describe('AZURE_DISTINCT_TARGETS set', () => {
        it('contains exactly the 8 region/script variants from Azure documentation', () => {
            assert.strictEqual(AZURE_DISTINCT_TARGETS.size, 8);
            assert.ok(AZURE_DISTINCT_TARGETS.has('fr-ca'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('pt-pt'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('zh-Hans'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('zh-Hant'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('sr-Cyrl'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('sr-Latn'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('tlh-Latn'));
            assert.ok(AZURE_DISTINCT_TARGETS.has('tlh-Piqd'));
        });
    });
});
