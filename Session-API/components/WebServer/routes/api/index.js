module.exports = (webserver) => {
    return [
        ...require('./transcriber_profiles.js')(webserver),
        ...require('./healthcheck.js')(webserver),
        ...require('./sessions.js')(webserver),
        ...require('./templates.js')(webserver),
        ...require('./bots.js')(webserver),

        ...require('./pairing.js')(webserver),
        ...require('./calendar_subscriptions.js')(webserver),
        ...require('./teams_app.js')(webserver),
        ...require('./integration_configs.js')(webserver),
        ...require('./media_hosts.js')(webserver),
    ];
}
