const { logger: appLogger } = require('live-srt-lib')


function logger(req, res, next) {
    appLogger.debug(`[${Date.now()}] new user entry on ${req.url}`)
    next()
}

module.exports = {
    logger
}
