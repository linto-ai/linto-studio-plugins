const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// ---- Mock setup: inject a logger into lib/security.js via the require cache
// so we can capture warn/error calls without touching production code paths.

const securityLoggerPath = require.resolve('live-srt-lib/logger.js');
const securityModulePath = require.resolve('live-srt-lib/security.js');

const captured = { warn: [], error: [], info: [], debug: [] };
const mockLogger = {
    info(msg) { captured.info.push(String(msg)); },
    warn(msg) { captured.warn.push(String(msg)); },
    error(msg) { captured.error.push(String(msg)); },
    debug(msg) { captured.debug.push(String(msg)); },
    log(msg) { captured.info.push(String(msg)); },
    getChannelLogger() { return mockLogger; },
};

function resetCaptured() {
    captured.warn.length = 0;
    captured.error.length = 0;
    captured.info.length = 0;
    captured.debug.length = 0;
}

let Security;
let originalLogger;
let originalSecurity;

function installMocks() {
    originalLogger = require.cache[securityLoggerPath];
    originalSecurity = require.cache[securityModulePath];

    require.cache[securityLoggerPath] = {
        id: securityLoggerPath,
        filename: securityLoggerPath,
        loaded: true,
        exports: mockLogger,
    };
    // Force security.js to re-evaluate so it captures the mocked logger.
    delete require.cache[securityModulePath];
    Security = require('live-srt-lib/security.js');
}

function restoreMocks() {
    if (originalLogger) require.cache[securityLoggerPath] = originalLogger;
    else delete require.cache[securityLoggerPath];
    if (originalSecurity) require.cache[securityModulePath] = originalSecurity;
    else delete require.cache[securityModulePath];
}

describe('Security.safeDecrypt diagnostics', () => {
    before(() => { installMocks(); });
    after(() => { restoreMocks(); });
    beforeEach(() => { resetCaptured(); });

    it('logs an explicit error when data looks encrypted but SECURITY_CRYPT_KEY is unset', () => {
        // Build a realistic encrypted-looking base64 payload (32 bytes ≥ IV + ciphertext).
        // Constructed from a Security with a key, then consumed by one without.
        const writer = new Security({ keyEnv: 'someSecretKeyValue', saltPath: '' });
        const ciphertext = writer.encrypt('my-api-key');
        assert.ok(ciphertext.length >= 24, 'ciphertext should be long enough to look encrypted');

        const reader = new Security({ keyEnv: undefined, saltPath: '' });
        resetCaptured(); // ignore the constructor warn about missing key

        const out = reader.safeDecrypt(ciphertext);
        assert.strictEqual(out, ciphertext, 'should pass data verbatim when cannot decrypt');
        assert.ok(
            captured.error.some(e => e.includes('SECURITY_CRYPT_KEY is not set')),
            `expected error log mentioning SECURITY_CRYPT_KEY; got ${JSON.stringify(captured.error)}`
        );
    });

    it('does not log error for plaintext-looking data when SECURITY_CRYPT_KEY is unset', () => {
        const reader = new Security({ keyEnv: undefined, saltPath: '' });
        resetCaptured();

        const out = reader.safeDecrypt('fr-FR');
        assert.strictEqual(out, 'fr-FR');
        assert.strictEqual(
            captured.error.length, 0,
            `expected no error for plaintext; got ${JSON.stringify(captured.error)}`
        );

        // Another typical plaintext: a short api endpoint string.
        resetCaptured();
        reader.safeDecrypt('https://api.example.com');
        assert.strictEqual(captured.error.length, 0);
    });

    it('decrypts successfully when SECURITY_CRYPT_KEY is valid', () => {
        const key = 'someSecretKeyValue';
        const writer = new Security({ keyEnv: key, saltPath: '' });
        const ciphertext = writer.encrypt('my-api-key');

        const reader = new Security({ keyEnv: key, saltPath: '' });
        resetCaptured();

        const out = reader.safeDecrypt(ciphertext);
        assert.strictEqual(out, 'my-api-key');
        assert.strictEqual(captured.error.length, 0, 'no error on successful decrypt');
    });

    it('encrypt() output starts with ENCRYPTION_PREFIX', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const ct = s.encrypt('payload');
        assert.ok(ct.startsWith(Security.ENCRYPTION_PREFIX),
            `expected ciphertext to start with ${Security.ENCRYPTION_PREFIX}, got ${ct.slice(0, 20)}...`);
    });

    it('decrypts new-format (prefixed) ciphertext round-trip', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        assert.strictEqual(s.decrypt(s.encrypt('hello world')), 'hello world');
    });

    it('decrypts legacy (non-prefixed) ciphertext for backward compatibility', () => {
        // Build a legacy-format ciphertext by stripping the prefix from a fresh encrypt().
        // Same key derivation, so decrypt() must accept it without the prefix.
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const newFormat = s.encrypt('legacy-value');
        const legacyFormat = newFormat.slice(Security.ENCRYPTION_PREFIX.length);
        assert.ok(!legacyFormat.startsWith(Security.ENCRYPTION_PREFIX));
        assert.strictEqual(s.decrypt(legacyFormat), 'legacy-value',
            'decrypt() must still accept ciphertext written before the prefix rollout');
    });

    it('_looksEncrypted: deterministic true on prefixed value', () => {
        assert.strictEqual(Security._looksEncrypted(Security.ENCRYPTION_PREFIX + 'anything'), true);
    });

    it('_looksEncrypted: still true on legacy base64-shaped values', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const legacy = s.encrypt('x').slice(Security.ENCRYPTION_PREFIX.length);
        assert.strictEqual(Security._looksEncrypted(legacy), true);
    });

    it('_looksEncrypted: false on plain text', () => {
        assert.strictEqual(Security._looksEncrypted('fr-FR'), false);
        assert.strictEqual(Security._looksEncrypted('hello'), false);
        assert.strictEqual(Security._looksEncrypted(''), false);
        assert.strictEqual(Security._looksEncrypted(null), false);
        assert.strictEqual(Security._looksEncrypted(undefined), false);
        assert.strictEqual(Security._looksEncrypted(42), false);
    });

    it('logs an explicit error mentioning wrong key / corrupted data when decryption fails despite a key being set', () => {
        const writer = new Security({ keyEnv: 'correctKey', saltPath: '' });
        const ciphertext = writer.encrypt('my-api-key');

        const reader = new Security({ keyEnv: 'wrongKey', saltPath: '' });
        resetCaptured();

        const out = reader.safeDecrypt(ciphertext);
        assert.strictEqual(out, ciphertext, 'should return the original encrypted blob on failure');
        assert.ok(
            captured.error.some(e => /wrong|corrupted/i.test(e)),
            `expected error mentioning 'wrong' or 'corrupted'; got ${JSON.stringify(captured.error)}`
        );
    });
});
