const debug = require('debug')('session-api:BrokerClient:controllers:webserver-events');
module.exports = function () {
    this.app.components['WebServer'].on('session-update', async () => {
        await this.publishSessions()
    });

    this.app.components['WebServer'].on('startbot', async (botId) => {
        await this.scheduleStartBot(botId);
    });

    this.app.components['WebServer'].on('stopbot', async (botId) => {
        await this.scheduleStopBot(botId);
    });

}
