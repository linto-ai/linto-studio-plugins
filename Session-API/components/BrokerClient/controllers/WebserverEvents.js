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

    this.app.components['WebServer'].on('createCalendarSubscription', async (subscriptionId) => {
        await this.createCalendarSubscription(subscriptionId);
    });

    this.app.components['WebServer'].on('deleteCalendarSubscription', async (subscriptionId) => {
        await this.deleteCalendarSubscription(subscriptionId);
    });

    this.app.components['WebServer'].on('mediaHostRegistered', async (integrationConfigId) => {
        await this.publishMediaHostRegistered(integrationConfigId);
    });

}
