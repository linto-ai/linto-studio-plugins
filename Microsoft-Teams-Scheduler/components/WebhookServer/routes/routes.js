module.exports = (webServer) => {
    return {
        '': require('./api')(webServer)
    };
};
