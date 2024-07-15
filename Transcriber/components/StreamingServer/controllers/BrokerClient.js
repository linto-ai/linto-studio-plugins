const debug = require('debug')('transcriber:StreamingServer:controllers:BrokerClient');

module.exports = function () {
    // set sessions from broker in the streaming server
    this.app.components['BrokerClient'].on("sessions", async (sessions) => {
        this.setSessions(sessions);
    });
}