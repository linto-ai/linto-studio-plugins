const debug = require('debug')('session-api:BrokerClient:controllers:webserver-events');
module.exports = function () {
    this.app.components['WebServer'].on('session-update', async () => {
        await this.publishSessions()
    });

    this.app.components['WebServer'].on('startbot', async (sessionId, channelId, url, botType, botAsync, botLive) => {
        await this.scheduleStartBot(sessionId, channelId, url, botType, botAsync, botLive);
    });

    this.app.components['WebServer'].on('stopbot', async (sessionId, channelId) => {
        await this.scheduleStopBot(sessionId, channelId);
    });

}
