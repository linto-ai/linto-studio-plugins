const { logger: appLogger } = require('live-srt-lib');

function obfuscateKeyValues(obj) {
    if (Array.isArray(obj)) {
        return obj.map(obfuscateKeyValues);
    } else if (obj && typeof obj === 'object') {
        const newObj = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k.includes('key')) {
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

    const originalJson = res.json;
    res.json = function (body) {
      if (body.error) {
          appLogger.warn(body.error);
      }
      return originalJson.call(this, body);
    };

    const originalSend = res.send;
    res.send = function (body) {
      res.locals.responseBody = body;
      return originalSend.call(this, body);
    };

    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.locals.responseBody) {
        appLogger.warn(res.locals.responseBody);
      }
    });

    next();
}

module.exports = {
    logger
};
