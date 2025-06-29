module.exports = (webServer) => {
    return {
        "/api-docs": require('./api-docs')(webServer),
        "/v1": require('./api')(webServer),
        "/healthcheck": require('./healthcheck')(webServer),
    }
}
