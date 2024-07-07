const debug = require('debug')('session-api:BrokerClient:controllers:webserver-events');
module.exports = function () {
    this.app.components['WebServer'].on('session-update', async () => {
        await this.publishSessions()
    });
}