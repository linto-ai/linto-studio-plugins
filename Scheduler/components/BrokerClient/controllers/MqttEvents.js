const debug = require('debug')('scheduler:BrokerClient:mqtt-events');

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    // transcriber/out/+/+/final
    if (topic.endsWith('final')) {
      const [type, direction, sessionId, channelIndex, action] = topic.split('/');
      const transcription = JSON.parse(message.toString());
      await this.saveTranscription(transcription, sessionId, channelIndex);
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
            channel: channelIndex
          } = JSON.parse(message.toString());
          this.updateSession(transcriberId, sessionId, channelIndex, newStreamStatus);
        }
        break;
      case 'scheduler':
        if (direction === 'in') {
          const { session, channelIndex, address, botType } = JSON.parse(message.toString());
          if (action === 'startbot') {
            await this.startBot(session, channelIndex, address, botType);
          }
          if (action === 'stopbot') {
            const { sessionId } = JSON.parse(message.toString());
            await this.stopBot(sessionId, channelIndex);
          }
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }
  });
}
