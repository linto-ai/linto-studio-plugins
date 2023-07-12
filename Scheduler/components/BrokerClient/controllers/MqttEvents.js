const debug = require('debug')('scheduler:BrokerClent:mqtt-events');

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    //`transcriber/out/+/status`
    const [type, direction, uniqueId, action] = topic.split('/');
    switch (type) {
      case 'transcriber':
        const transcriber = JSON.parse(message.toString());
        if (transcriber.online) {
          this.registerTranscriber(transcriber);
        } else {
          this.unregisterTranscriber(transcriber);
        }
        break;
      case 'session':
        const sessionId = uniqueId;
        switch (action) {
          case 'ask_creation':
            try {
              await this.createSession(message, sessionId);
              this.client.publish(`session/in/${sessionId}/ack_creation`, sessionId, 2, false, true);
            } catch (err) {
              debug(`Error creating session ${sessionId} : ${err.message}`);
              const payload = { sessionId, error: err.message };
              this.client.publish(`session/in/${sessionId}/reject_creation`, payload, 2, false, true);
            }
            break;
          default:
            break;
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }

  });
}