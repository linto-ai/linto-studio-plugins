const { logger: appLogger } = require('live-srt-lib')

// Request bodies are logged at debug level. Provider secrets travel in the
// transcriber-profile config under several names (key, apiKey, credentials,
// passphrase, the Amazon privateKey…), so the redaction is a case-insensitive
// substring match on a list of sensitive markers rather than the historical
// `k.includes('key')` which let `apiKey`, `credentials` and `password` through
// in clear text.
const SENSITIVE_FIELD_RE = /key|secret|password|passphrase|token|credential|authorization/i;

function isSensitiveField(name) {
    return SENSITIVE_FIELD_RE.test(String(name));
}

function obfuscateKeyValues(obj) {
    if (Array.isArray(obj)) {
        return obj.map(obfuscateKeyValues);
    } else if (obj && typeof obj === 'object') {
        const newObj = {};
        for (const [k, v] of Object.entries(obj)) {
            if (isSensitiveField(k)) {
                newObj[k] = '***';
            } else {
                newObj[k] = obfuscateKeyValues(v);
            }
        }
        return newObj;
    }
    return obj;
}

function logger(req, res, next) {
    appLogger.debug(`[${Date.now()}] ${req.method} ${req.url}`, obfuscateKeyValues(req.body));

    // log 400 error
    const originalJson = res.json;
    res.json = function (body) {
      if (body.error) {
          appLogger.warn(body.error);
      }
      return originalJson.call(this, body);
    };

    // log 404 error
    const originalSend = res.send;
    res.send = function (body) {
      res.locals.responseBody = body;
      return originalSend.call(this, body); // Continue le comportement normal
    };

    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.locals.responseBody) {
        appLogger.warn(res.locals.responseBody);
      }
    });

    next();
}

module.exports = {
    logger,
    obfuscateKeyValues,
    isSensitiveField,
}
