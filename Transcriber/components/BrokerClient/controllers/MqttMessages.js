const { logger } = require('live-srt-lib')

// Handler for 'scheduler' messages
function handleSchedulerMessage(scheduler) {
  if (scheduler.online && this.state == this.constructor.states.WAITING_SCHEDULER) {
    logger.debug(`${this.uniqueId} scheduler online, registering...`);
    this.client.publishStatus();
    this.app.components['StreamingServer'].startServers();
    this.state = this.constructor.states.READY;
  } else if (!scheduler.online && this.state !== this.constructor.states.WAITING_SCHEDULER) {
    this.state = this.constructor.states.WAITING_SCHEDULER;
    this.app.components['StreamingServer'].stopServers();
    logger.debug(`${this.uniqueId} scheduler offline, waiting...`);
  }
}

// Handler for 'system' messages
function handleSystemMessage(parts, message) {
  const [direction, systemType, ...systemParts] = parts;
  if (direction === 'out' && systemType === 'sessions') {
    const action = systemParts.join('/');
    if (action === 'statuses') {
      const sessions = JSON.parse(message);
      this.handleSessions(sessions);
    }
  } else {
    logger.debug(`Received message for unknown system type ${systemType}`);
  }
}

// Handler for 'transcriber' messages
function handleTranscriberMessage(parts, message) {
  const [direction, uniqueId, ...subparts] = parts;
  if (direction === 'in' && uniqueId === this.uniqueId) {
    const { session, channelId, address, botType, botAsync, botLive } = JSON.parse(message);
    const action = subparts.join('/');
    switch (action) {
      case 'startbot':
        this.app.components['StreamingServer'].startBot(session, channelId, address, botType, botAsync, botLive);
        break;
      case 'stopbot':
        const { sessionId } = JSON.parse(message);
        this.app.components['StreamingServer'].stopBot(sessionId, channelId);
        break;
      default:
        logger.debug(`Unknown action: ${action}`);
    }
  }
}

// Main message handler function
module.exports = function () {
  this.client.on("message", async (topic, message) => {
    const [type, ...parts] = topic.split('/');
    switch (type) {
      case 'scheduler':
        handleSchedulerMessage.call(this, JSON.parse(message.toString()));
        break;
      case 'system':
        handleSystemMessage.call(this, parts, message);
        break;
      case 'transcriber':
        handleTranscriberMessage.call(this, parts, message);
        break;
      default:
        logger.debug(`Received message for unknown type ${type}`);
    }
  });
};
