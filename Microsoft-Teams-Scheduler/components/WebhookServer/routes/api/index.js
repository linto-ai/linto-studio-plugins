module.exports = (webServer) => {
    return [
        ...require('./notifications')(webServer),
        ...require('./validate-token')(webServer)
    ];
};
