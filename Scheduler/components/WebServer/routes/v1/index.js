const debug = require('debug')('scheduler:router:api-docs');

module.exports = (webserver) => {
    return [
        ...require('./sessions.js')(webserver),
    ];
}
