const debug = require('debug')('scheduler:BrokerClient:mqtt-events');

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    //`transcriber/out/+/status`
    const [type, direction, uniqueId, action] = topic.split('/');
    switch (type) {
      case 'transcriber':
        if (action === 'status') {
          const transcriber = JSON.parse(message.toString());
          if (transcriber.online) {
            await this.registerTranscriber(transcriber);
          } else {
            await this.unregisterTranscriber(transcriber);
          }
        }
        if (action === 'final') {
          const transcription = JSON.parse(message.toString());
          this.saveTranscription(transcription, uniqueId); //save transcription to db using transcriber uniqueId
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
          case 'ask_deletion':
            await this.deleteSession(sessionId);
            break;
          case 'stop':
            await this.stopSession(sessionId);
            break;
          case 'start':
            await this.startSession(sessionId);
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
