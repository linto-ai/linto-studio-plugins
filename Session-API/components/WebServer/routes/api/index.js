module.exports = (webserver) => {
    return [
        ...require('./transcriber_profiles.js')(webserver),
        ...require('./healthcheck.js')(webserver),
        ...require('./sessions.js')(webserver),
        ...require('./templates.js')(webserver),
        ...require('./bots.js')(webserver),
    ];
}
