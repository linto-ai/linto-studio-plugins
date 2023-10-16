const debug = require('debug')('app:webserver:routes')

module.exports = (webServer) => {
    return {
        "/healthcheck": require('./healthcheck')(webServer),
        "/v1": require('./v1')(webServer)
    }
}
