const logger = require('../../../logger')

// Handler for 'scheduler' messages
function handleSchedulerMessage(scheduler) {
  if (scheduler.online && this.state == this.constructor.states.WAITING_SCHEDULER) {
    logger.info(`${this.uniqueId} scheduler online, registering...`);
    this.client.publishStatus();
    this.app.components['StreamingServer'].startServers();
    this.serversStarted = true;
    this.state = this.constructor.states.READY;
  } else if (!scheduler.online && this.state !== this.constructor.states.WAITING_SCHEDULER) {
    logger.warn(`${this.uniqueId} scheduler offline, transcriptions may be lost...`);
  } else if (scheduler.online && this.state !== this.constructor.states.WAITING_SCHEDULER) {
    logger.info(`${this.uniqueId} scheduler back online.`);
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
    logger.warn(`Received message for unknown system type ${systemType}`);
  }
}

// Handler for 'transcriber' messages
function handleTranscriberMessage(parts, message) {
  const [direction, uniqueId, ...subparts] = parts;
  if (direction === 'in' && uniqueId === this.uniqueId) {
    const action = subparts.join('/');
    logger.warn(`Unknown action: ${action}`);
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
        logger.warn(`Received message for unknown type ${type}`);
    }
  });
};
