module.exports = (webServer) => {
    return [
        ...require('./notifications')(webServer),
        ...require('./users')(webServer)
    ];
};
