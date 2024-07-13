const debug = require('debug')('session-api:BrokerClient:controllers:webserver-events');
module.exports = function () {
    this.app.components['WebServer'].on('session-update', async () => {
        await this.publishSessions()
    });

    this.app.components['WebServer'].on('start-bot', async (sessionId, channelIndex, address) => {
        await this.startBot(sessionId, channelIndex, address);
    });
}