module.exports = (webserver) => {
    return [
        ...require('../api/platform_integration_configs.js')(webserver),
    ];
}
