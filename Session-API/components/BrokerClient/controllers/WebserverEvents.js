const debug = require('debug')('session-api:BrokerClient:controllers:webserver-events');
module.exports = function () {
    this.app.components['WebServer'].on('session-update', async () => {
        await this.publishSessions()
    });

    this.app.components['WebServer'].on('startbot', async (sessionId, channelIndex, url, botType) => {
        await this.scheduleStartBot(sessionId, channelIndex, url, botType);
    });

    this.app.components['WebServer'].on('stopbot', async (sessionId, channelIndex) => {
        await this.scheduleStopBot(sessionId, channelIndex);
    });

}