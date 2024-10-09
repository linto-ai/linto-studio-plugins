const debug = require('debug')('scheduler:BrokerClient:mqtt-events');

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    // transcriber/out/+/+/final
    if (topic.endsWith('final')) {
      const [type, direction, sessionId, channelId, action] = topic.split('/');
      const transcription = JSON.parse(message.toString());
      await this.saveTranscription(transcription, sessionId, channelId);
      return;
    }

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
        // Session updated by a transcriber (channel status change)
        if (action === 'session'){
          const {
            transcriberId: transcriberId,
            id: sessionId,
            status: newStreamStatus,
            channel: channelId
          } = JSON.parse(message.toString());
          this.updateSession(transcriberId, sessionId, channelId, newStreamStatus);
        }
        break;
      case 'scheduler':
        if (direction === 'in') {
          const { session, channelId, address, botType } = JSON.parse(message.toString());
          if (action === 'startbot') {
            await this.startBot(session, channelId, address, botType);
          }
          if (action === 'stopbot') {
            const { sessionId } = JSON.parse(message.toString());
            await this.stopBot(sessionId, channelId);
          }
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }
  });
}
