module.exports = (webServer) => {
    return [
        ...require('./notifications')(webServer)
    ];
};
