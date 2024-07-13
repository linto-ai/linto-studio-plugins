const debug = require('debug')('transcriber:BrokerClient:mqtt-messages');

// Deals with MQTT messages
// here, "this" is bound to the BrokerClient component
module.exports = function () {
  this.client.on("message", async (topic, message) => {
    const [type, ...parts] = topic.split('/');
    switch (type) {
      case 'scheduler':
        const scheduler = JSON.parse(message.toString());
        if (scheduler.online && this.state == this.constructor.states.WAITING_SCHEDULER) {
          debug(`${this.uniqueId} scheduler online, registering...`);
          this.client.publishStatus();
          // Scheduler online, activate streaming server
          this.app.components['StreamingServer'].startServers();
          this.state = this.constructor.states.READY;
        }
        if (!scheduler.online && this.state !== this.constructor.states.WAITING_SCHEDULER) {
          this.state = this.constructor.states.WAITING_SCHEDULER;
          // Scheduler offline, deactivate streaming server
          this.app.components['StreamingServer'].stopServers();
          debug(`${this.uniqueId} scheduler offline, waiting...`);
        }
        break;
      case 'system':
        const [direction, ...subparts] = parts;
        if (direction === 'out') {
          const [systemType, ...systemParts] = subparts;
          if (systemType === 'sessions') {
            const action = systemParts.join('/');
            switch (action) {
              case 'statuses':
                // Handle system/out/sessions/statuses messages here
                const sessions = JSON.parse(message);
                this.handleSessions(sessions);
                break;
              case 'jitsi-bot-start':
                // Handle system/out/sessions/jitsi-bot-start messages here
                const { session, channelIndex, address } = JSON.parse(message);
                this.handleStartBot(session, channelIndex, address);
                break;
              default:
                break;
            }
          } else {
            debug(`Received message for unknown system type ${systemType}`);
          }
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }
  });
};