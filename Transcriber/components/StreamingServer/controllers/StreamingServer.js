//Handle (well... local) events from the streaming server
// this is bind to the streaming server singleton component
const debug = require('debug')(`transcriber:StreamingServer:controllers:StreamingServer`);
module.exports = function () {

  this.on('session-start', (session, channel) => {
    this.app.components['BrokerClient'].activateSession(session, channel);
  })

  this.on('session-stop', (session, channel) => {
    this.app.components['BrokerClient'].deactivate(session, channel);
  })
}
