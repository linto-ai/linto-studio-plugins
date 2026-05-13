const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require(`./logger.js`)

// Ciphertext format markers. The prefix lets safeDecrypt deterministically
// recognise "this value was written by us" and pick the right decryption path.
// Versions in active use:
//
//   enc:v1:  CBC-AES-256, base64(iv || ciphertext). No integrity tag, so
//            wrong-key detection is best-effort (PKCS#7 padding occasionally
//            validates by chance on random plaintext). KEPT FOR BACKWARD
//            COMPATIBILITY with profiles encrypted before the v2 rollout.
//   enc:v2:  CBC-AES-256, base64(iv || ciphertext || hmacSha256). HMAC tag
//            over (iv || ciphertext) verified before decryption — wrong key
//            or corrupted blob trigger a deterministic throw. NEW FORMAT
//            produced by encrypt().
//
// Values written before any prefix existed (oldest deployments) decode as
// "no prefix" — same path as v1 minus the strip.
const ENCRYPTION_PREFIX_V1 = 'enc:v1:';
const ENCRYPTION_PREFIX_V2 = 'enc:v2:';
const ENCRYPTION_PREFIX = ENCRYPTION_PREFIX_V2;
const HMAC_LEN = 32; // SHA-256
const HMAC_KEY_LABEL = 'emeeting-security-v2-hmac';

class Security {
  /**
   * @param {Object} [options]
   * @param {string} [options.keyEnv]      Encryption key
   * @param {string} [options.saltPath]    Path to the salt file
   */
  constructor({ keyEnv, saltPath } = {}) {
    this.keyEnv = keyEnv || process.env.SECURITY_CRYPT_KEY;
    this.saltPath = saltPath || process.env.SECURITY_SALT_FILEPATH || '';

    if (!this.keyEnv) {
        logger.warn(`Encryption of the key is not enabled because the variable SECURITY_CRYPT_KEY is not set !`);
    }
  }

  /**
   * Derives a 32-byte encryption key using scrypt, with or without a salt.
   * @returns {Buffer} 32-byte Buffer
   */
  deriveKey() {
    let salt = '';
    if (this.saltPath) {
      const absolutePath = path.resolve(this.saltPath);
      if (fs.existsSync(absolutePath)) {
        salt = fs.readFileSync(absolutePath, 'utf8');
      }
      else {
        logger.warn(`Salt Path ${this.saltPath} doesn't exist. Salt is not used !`);
      }
    }
    return crypto.scryptSync(this.keyEnv, salt, 32);
  }

  // Domain-separated HMAC key. Derived from the AES key via HMAC-SHA256 with
  // a constant label so the same scrypt material yields different keys for
  // AES and HMAC — defense in depth against any cross-usage attack.
  _hmacKey(aesKey) {
    return crypto.createHmac('sha256', aesKey).update(HMAC_KEY_LABEL).digest();
  }

  /**
   * Encrypts a plaintext string. Produces an enc:v2: tagged ciphertext that
   * includes an HMAC-SHA256 over (iv || ciphertext), enabling deterministic
   * wrong-key / corruption detection at decrypt time.
   *
   * @param {string} plaintext The text to encrypt
   * @returns {string} `enc:v2:<base64(iv || ciphertext || hmac)>`
   */
  encrypt(plaintext) {
    if (!this.keyEnv) {
      return plaintext;
    }
    const aesKey = this.deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    const ct = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final()
    ]);
    const body = Buffer.concat([iv, ct]);
    const tag = crypto.createHmac('sha256', this._hmacKey(aesKey)).update(body).digest();
    return ENCRYPTION_PREFIX_V2 + Buffer.concat([body, tag]).toString('base64');
  }

  /**
   * Decrypts a ciphertext produced by encrypt(). Handles three formats so we
   * stay backward-compatible with any blob that may live in a client database:
   *
   *   * `enc:v2:` — HMAC-authenticated. The tag is verified BEFORE
   *     decryption; a wrong key or any bit-flip throws deterministically.
   *   * `enc:v1:` — legacy CBC-only (no HMAC). Decrypt as-is; wrong-key
   *     detection falls back to PKCS#7 padding validation (probabilistic).
   *   * unprefixed — oldest deployments, before any version marker existed.
   *     Same path as v1.
   *
   * @param {string} data Ciphertext (any supported format)
   * @returns {string} Decrypted plaintext
   */
  decrypt(data) {
    if (!this.keyEnv) {
      return data;
    }
    const aesKey = this.deriveKey();

    if (typeof data === 'string' && data.startsWith(ENCRYPTION_PREFIX_V2)) {
      const combined = Buffer.from(data.slice(ENCRYPTION_PREFIX_V2.length), 'base64');
      if (combined.length < 16 + HMAC_LEN) {
        throw new Error('Truncated v2 ciphertext');
      }
      const body = combined.slice(0, combined.length - HMAC_LEN);
      const tag = combined.slice(combined.length - HMAC_LEN);
      const expected = crypto.createHmac('sha256', this._hmacKey(aesKey)).update(body).digest();
      if (!crypto.timingSafeEqual(tag, expected)) {
        throw new Error('HMAC verification failed (wrong key or corrupted ciphertext)');
      }
      const iv = body.slice(0, 16);
      const ciphertext = body.slice(16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf8');
    }

    // v1 or fully legacy (no prefix) — no integrity tag.
    const base64 = typeof data === 'string' && data.startsWith(ENCRYPTION_PREFIX_V1)
      ? data.slice(ENCRYPTION_PREFIX_V1.length)
      : data;
    const combined = Buffer.from(base64, 'base64');
    const iv = combined.slice(0, 16);
    const ciphertext = combined.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Attempts to decrypt; if decryption fails, returns the original input.
   *
   * Emits an explicit error log when data looks like a tagged encrypted
   * payload but cannot be decrypted (either because SECURITY_CRYPT_KEY is
   * missing or because the configured key is wrong / data is corrupted).
   * Returning the encrypted blob verbatim downstream typically causes opaque
   * auth failures in third-party SDKs (e.g. Azure Speech SDK timing out
   * after 15 s), so this diagnostic is intended to make the root cause
   * obvious in the logs.
   *
   * @param {string} data Tagged ciphertext or plain text
   * @returns {string} Decrypted text or original data if decryption fails
   */
  safeDecrypt(data) {
    try {
      // Encrypted-looking data without a key cannot be decrypted: decrypt()
      // would silently pass it through. Surface the misconfiguration loudly.
      if (!this.keyEnv && Security._looksEncrypted(data)) {
        logger.error('Cannot decrypt: SECURITY_CRYPT_KEY is not set but data appears encrypted. The value will be transmitted verbatim and likely cause downstream auth failures. Set SECURITY_CRYPT_KEY to the same value used by the service that wrote this data (typically Session-API).');
        return data;
      }
      return this.decrypt(data);
    } catch (err) {
      if (Security._looksEncrypted(data)) {
        logger.error(`Decryption failed (wrong SECURITY_CRYPT_KEY or corrupted data?): ${err.message}. The encrypted value will be transmitted verbatim and likely cause downstream auth failures.`);
      } else {
        logger.warn(`Decryption attempt failed but data does not look encrypted: ${err.message}`);
      }
      return data;
    }
  }

  /**
   * Deterministic detection of ciphertext produced by encrypt() (any version).
   * The prefix tag is the single source of truth. Legacy unprefixed blobs are
   * NOT flagged as encrypted by this heuristic — they fall back to opaque
   * pass-through if the key is missing. Downstream SDKs then surface the
   * real error ("invalid key", etc.).
   *
   * @param {*} data
   * @returns {boolean}
   */
  static _looksEncrypted(data) {
    if (typeof data !== 'string') return false;
    return data.startsWith(ENCRYPTION_PREFIX_V1) || data.startsWith(ENCRYPTION_PREFIX_V2);
  }
}

module.exports = Security;
// ENCRYPTION_PREFIX always points to the current (newest) format. The v1/v2
// constants are also exported for tests and any future migration helper.
module.exports.ENCRYPTION_PREFIX = ENCRYPTION_PREFIX;
module.exports.ENCRYPTION_PREFIX_V1 = ENCRYPTION_PREFIX_V1;
module.exports.ENCRYPTION_PREFIX_V2 = ENCRYPTION_PREFIX_V2;
