module.exports = (webServer) => {
    return {
        "/api-docs": require('./api-docs')(webServer),
        "/v1": require('./api')(webServer),
        "/v1/admin": require('./admin')(webServer),
        "/healthcheck": require('./healthcheck')(webServer),
    }
}
