const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require(`./logger.js`)

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
    return Buffer.concat([iv, encrypted]).toString('base64');
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
    const combined = Buffer.from(data, 'base64');
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
   * @param {string} data Base64 string or plain text
   * @returns {string} Decrypted text or original data if decryption fails
   */
  safeDecrypt(data) {
    try {
      return this.decrypt(data);
    } catch (err) {
      logger.warn('Error while decrypting the key. Is the key crypted ? You may need to restart the Scheduler and the Transcriber');
      return data;
    }
  }
}

module.exports = Security;
