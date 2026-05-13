const assert = require('assert');
const crypto = require('crypto');
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

    it('encrypt() output is tagged with the current (v2) prefix', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const ct = s.encrypt('payload');
        assert.ok(ct.startsWith(Security.ENCRYPTION_PREFIX_V2),
            `expected ciphertext to start with ${Security.ENCRYPTION_PREFIX_V2}, got ${ct.slice(0, 20)}...`);
        assert.strictEqual(Security.ENCRYPTION_PREFIX, Security.ENCRYPTION_PREFIX_V2,
            'ENCRYPTION_PREFIX should always point to the current format');
    });

    it('decrypts current-format (v2, HMAC) ciphertext round-trip', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        assert.strictEqual(s.decrypt(s.encrypt('hello world')), 'hello world');
    });

    // Build a v1-format blob (CBC only, no HMAC) the way deployments encrypted
    // it before the v2 rollout: scrypt(key) → AES-256-CBC → base64(iv||ct),
    // optionally with the 'enc:v1:' prefix added later by the dce39de commit.
    function buildLegacyV1Blob(keyEnv, plaintext, withPrefix) {
        const s = new Security({ keyEnv, saltPath: '' });
        const aesKey = s.deriveKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
        const ct = Buffer.concat([
            cipher.update(Buffer.from(plaintext, 'utf8')),
            cipher.final()
        ]);
        const body = Buffer.concat([iv, ct]).toString('base64');
        return withPrefix ? Security.ENCRYPTION_PREFIX_V1 + body : body;
    }

    it('decrypts legacy v1 (prefixed, no HMAC) ciphertext — backward compat', () => {
        // Profiles encrypted between the prefix rollout (commit dce39de) and the
        // v2/HMAC upgrade live as `enc:v1:<base64(iv||ct)>` in client DBs.
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const v1Blob = buildLegacyV1Blob('k', 'legacy-v1-value', true);
        assert.strictEqual(s.decrypt(v1Blob), 'legacy-v1-value');
    });

    it('decrypts oldest-format (no prefix at all) ciphertext — backward compat', () => {
        // Profiles encrypted before the prefix rollout look like raw
        // base64(iv||ct). decrypt() must still accept them transparently so
        // we don't break installations that haven't run migrate-keys.
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const unprefixed = buildLegacyV1Blob('k', 'oldest-value', false);
        assert.strictEqual(s.decrypt(unprefixed), 'oldest-value');
    });

    it('_looksEncrypted: deterministic true on v1 OR v2 prefixed value', () => {
        assert.strictEqual(Security._looksEncrypted(Security.ENCRYPTION_PREFIX_V1 + 'anything'), true);
        assert.strictEqual(Security._looksEncrypted(Security.ENCRYPTION_PREFIX_V2 + 'anything'), true);
    });

    it('_looksEncrypted: false on legacy (unprefixed) base64-shaped values', () => {
        // The prefix is the single source of truth. Legacy ciphertext written
        // before the prefix rollout is treated as opaque plaintext by the
        // diagnostic; the actual decryption path still handles it transparently.
        const legacy = buildLegacyV1Blob('k', 'x', false);
        assert.strictEqual(Security._looksEncrypted(legacy), false);
    });

    it('_looksEncrypted: false on plain text and on 32-char hex (Azure-key shape)', () => {
        assert.strictEqual(Security._looksEncrypted('fr-FR'), false);
        assert.strictEqual(Security._looksEncrypted('hello'), false);
        assert.strictEqual(Security._looksEncrypted(''), false);
        assert.strictEqual(Security._looksEncrypted(null), false);
        assert.strictEqual(Security._looksEncrypted(undefined), false);
        assert.strictEqual(Security._looksEncrypted(42), false);
        // Regression: a plain 32-char hex Azure Speech key must not be flagged.
        assert.strictEqual(Security._looksEncrypted('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), false);
    });

    it('logs an explicit error mentioning wrong key / corrupted data when decryption fails despite a key being set (v2)', () => {
        // With v2 (HMAC-tagged), wrong-key detection is deterministic: the
        // HMAC computed by the reader doesn't match the writer's tag, decrypt
        // throws, safeDecrypt catches and logs. No flakiness — contrast with
        // v1 where AES-CBC padding occasionally validates by chance.
        const writer = new Security({ keyEnv: 'correctKey', saltPath: '' });
        const ciphertext = writer.encrypt('my-api-key');
        assert.ok(ciphertext.startsWith(Security.ENCRYPTION_PREFIX_V2),
            'writer.encrypt() must produce a v2 ciphertext');

        const reader = new Security({ keyEnv: 'wrongKey', saltPath: '' });
        resetCaptured();

        const out = reader.safeDecrypt(ciphertext);
        assert.strictEqual(out, ciphertext, 'should return the original encrypted blob on failure');
        assert.ok(
            captured.error.some(e => /wrong|corrupted/i.test(e)),
            `expected error mentioning 'wrong' or 'corrupted'; got ${JSON.stringify(captured.error)}`
        );
    });

    it('rejects a v2 ciphertext whose HMAC tag has been tampered with', () => {
        const s = new Security({ keyEnv: 'k', saltPath: '' });
        const ct = s.encrypt('value');

        // Flip the last byte of the base64 payload — that lands inside the
        // HMAC tag region, so the verify must fail deterministically.
        const body = ct.slice(Security.ENCRYPTION_PREFIX_V2.length);
        const raw = Buffer.from(body, 'base64');
        raw[raw.length - 1] ^= 0xff;
        const tampered = Security.ENCRYPTION_PREFIX_V2 + raw.toString('base64');

        resetCaptured();
        const out = s.safeDecrypt(tampered);
        assert.strictEqual(out, tampered, 'tampered ciphertext should not decrypt');
        assert.ok(
            captured.error.some(e => /wrong|corrupted|HMAC/i.test(e)),
            `expected HMAC/corruption error; got ${JSON.stringify(captured.error)}`
        );
    });
});
