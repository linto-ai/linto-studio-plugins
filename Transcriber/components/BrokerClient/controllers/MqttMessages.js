const debug = require('debug')('transcriber:BrokerClient:mqtt-messages');

//Deals with MQTT messages
//here, "this" is bound to the BrokerClient component
module.exports = function () {
  this.client.on("message", async (topic, message) => {
    const [type, ...parts] = topic.split('/');
    switch (type) {
      case 'scheduler':
        const scheduler = JSON.parse(message.toString());
        if (scheduler.online && this.state == this.constructor.states.WAITING_SCHEDULER) {
          debug(`${this.uniqueId} scheduler online, registering...`)
          this.client.publishStatus();
          this.state = this.constructor.states.READY;
        }
        if (!scheduler.online && this.state !== this.constructor.states.WAITING_SCHEDULER) {
          this.state = this.constructor.states.WAITING_SCHEDULER
          debug(`${this.uniqueId} scheduler offline, waiting...`)
        }  
        break;
      case 'transcriber':
        const [direction, id, action] = parts;
        if (direction === 'in' && id === this.uniqueId) {
          switch (action) {
            case 'enroll':
              // Handle enroll message
              debug(`${this.uniqueId} received enroll message`);
              await this.setSession(JSON.parse(message));
              break;
            case 'free':
              // Handle free message
              this.free();
              debug(`${this.uniqueId} received free message`);
              break;
            case 'reset':
              // Handle reset message
              // Similar to free but emit a msg in the transcription
              debug(`${this.uniqueId} received reset message`);
              await this.reset();
              break;
            case 'start':
              // Handle start message
              this.start();
              debug(`${this.uniqueId} received start message`);
              break;
            default:
              debug(`${this.uniqueId} received unknown action ${action}`);
          }
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }
  });
}
