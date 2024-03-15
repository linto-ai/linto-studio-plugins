const debug = require('debug')('session-api:webserver:middlewares')


function logger(req, res, next) {
    debug(`[${Date.now()}] new user entry on ${req.url}`)
    next()
}

module.exports = {
    logger
}
