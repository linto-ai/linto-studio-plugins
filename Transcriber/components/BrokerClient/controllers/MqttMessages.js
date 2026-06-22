const logger = require('../../../logger')

// Handler for 'scheduler' messages
function handleSchedulerMessage(scheduler) {
  // Always record the latest scheduler online state so maybeStartServers()
  // can fire from either side of the WAITING_SCHEDULER transition race.
  this.schedulerOnline = !!scheduler.online;

  if (!scheduler.online) {
    if (this.state !== this.constructor.states.WAITING_SCHEDULER) {
      logger.warn(`${this.uniqueId} scheduler offline, transcriptions may be lost...`);
    }
    return;
  }

  if (this.state === this.constructor.states.WAITING_SCHEDULER) {
    this.maybeStartServers();
  } else {
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
    } else if (action === 'cleared') {
      try {
        const payload = JSON.parse(message);
        this.emit('session-cleared', payload);
      } catch (err) {
        logger.error(`Failed to parse sessions/cleared payload: ${err.message}`);
      }
    }
    // Other actions (paused, resumed) are derived from the statuses snapshot
    // diff in handleSessions(); the discrete topics are emitted for external
    // consumers (e.g. studio-api) and intentionally ignored here.
  } else {
    logger.warn(`Received message for unknown system type ${systemType}`);
  }
}

// Handler for 'transcriber' messages
function handleTranscriberMessage(parts, message) {
  const [direction, uniqueId, ...subparts] = parts;
  if (direction === 'in' && uniqueId === this.uniqueId) {
    const action = subparts.join('/');
    switch (action) {
      // Meeting bots are no longer embedded here: they run in the dedicated
      // BotService and reach this Transcriber as a normal WS audio stream.
      default:
        logger.warn(`Unknown action: ${action}`);
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
        logger.warn(`Received message for unknown type ${type}`);
    }
  });
};
