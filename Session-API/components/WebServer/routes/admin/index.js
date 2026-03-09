module.exports = (webserver) => {
    return [
        ...require('../api/platform_integration_configs.js')(webserver),
        ...require('../api/calendar_events.js')(webserver),
    ];
}
