const { logger: appLogger } = require('live-srt-lib')


function logger(req, res, next) {
    appLogger.debug(`[${Date.now()}] new user entry on ${req.url}`);

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
    logger
}
