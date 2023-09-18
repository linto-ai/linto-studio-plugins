const debug = require('debug')('app:webserver:routes')

module.exports = (webServer) => {
    return {
        "/healthcheck": require('./healthcheck')(webServer),
        "/export": require('./export')(webServer)
    }
}
