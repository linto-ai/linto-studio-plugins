const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require(`./logger.js`)

// Tagged ciphertext format produced by encrypt(). The prefix lets safeDecrypt
// detect "this value was encrypted by us" deterministically, removing the
// false positives the base64-shape heuristic produces on hex strings (Azure
// keys are 32 hex chars and otherwise look like a valid base64 blob). Bumped
// to v2/v3/... if the encryption parameters ever change so old values can be
// transparently migrated.
const ENCRYPTION_PREFIX = 'enc:v1:';

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

  /**
   * Encrypts a plaintext string.
   * @param {string} plaintext The text to encrypt
   * @returns {string} Base64-encoded string (iv + ciphertext)
   */
  encrypt(plaintext) {
    if (!this.keyEnv) {
      return plaintext;
    }
    const key = this.deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final()
    ]);
    return ENCRYPTION_PREFIX + Buffer.concat([iv, encrypted]).toString('base64');
  }

  /**
   * Decrypts a Base64-encoded string (iv + ciphertext).
   * @param {string} data Base64 string returned by encrypt()
   * @returns {string} Decrypted plaintext
   */
  decrypt(data) {
    if (!this.keyEnv) {
      return data;
    }
    const key = this.deriveKey();
    // Strip the ENCRYPTION_PREFIX if present (new format) or treat the whole
    // string as base64 (legacy format produced before the prefix rollout).
    // Existing rows in the database stay readable across the upgrade.
    const base64 = typeof data === 'string' && data.startsWith(ENCRYPTION_PREFIX)
      ? data.slice(ENCRYPTION_PREFIX.length)
      : data;
    const combined = Buffer.from(base64, 'base64');
    const iv = combined.slice(0, 16);
    const ciphertext = combined.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Attempts to decrypt; if decryption fails, returns the original input.
   *
   * Emits an explicit error log when data looks like a base64 encrypted payload
   * but cannot be decrypted (either because SECURITY_CRYPT_KEY is missing or
   * because the configured key is wrong / data is corrupted). Returning the
   * encrypted blob verbatim downstream typically causes opaque auth failures
   * in third-party SDKs (e.g. Azure Speech SDK timing out after 15 s), so this
   * diagnostic is intended to make the root cause obvious in the logs.
   *
   * @param {string} data Base64 string or plain text
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
   * Deterministic detection of ciphertext produced by encrypt(): the
   * ENCRYPTION_PREFIX tag is the single source of truth. A base64-shape
   * heuristic was tried previously but produced false positives on plaintext
   * 32-char hex strings (Azure Speech keys, MD5/SHA hashes), causing
   * misleading "appears encrypted" diagnostics on services running without
   * SECURITY_CRYPT_KEY. Values written before the prefix existed and read
   * back without a key now pass through silently; downstream SDKs surface
   * the real error (e.g. "invalid key") if such legacy ciphertext ever
   * reaches them.
   * @param {*} data
   * @returns {boolean}
   */
  static _looksEncrypted(data) {
    return typeof data === 'string' && data.startsWith(ENCRYPTION_PREFIX);
  }
}

module.exports = Security;
module.exports.ENCRYPTION_PREFIX = ENCRYPTION_PREFIX;
