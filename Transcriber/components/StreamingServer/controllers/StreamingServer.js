const logger = require('../../../logger');

//Handle (well... local) events from the streaming server
// this is bind to the streaming server singleton component
module.exports = function () {

  this.on('session-start', (session, channel) => {
    this.app.components['BrokerClient'].activateSession(session, channel);
  })

  this.on('session-stop', (session, channelId) => {
    this.app.components['BrokerClient'].deactivate(session, channelId);
  })

  this.app.components['BrokerClient'].on('session-paused', (session) => {
    this.pauseSession(session.id).catch(e =>
      logger.error(`pauseSession failed: ${e.message}`)
    );
  })

  this.app.components['BrokerClient'].on('session-resumed', (session) => {
    this.resumeSession(session.id).catch(e =>
      logger.error(`resumeSession failed: ${e.message}`)
    );
  })
}
