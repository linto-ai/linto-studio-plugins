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
          await this.saveTranscription(transcription, uniqueId); //save transcription to db using transcriber uniqueId
          if (transcription.locutor == process.env.TRANSCRIBER_BOT_NAME && transcription.text == process.env.TRANSCRIBER_RESET_MESSAGE) {
            await this.resetSessionUpdateDb(uniqueId);
          }
        }
        // Session updated by a transcriber (channel status change)
        if (action === 'session'){
          const {
            transcriber_id: transcriber_id,
            id: sessionId,
            status: newStreamStatus,
            channel: channelIndex
          } = JSON.parse(message.toString());
          this.updateSession(transcriber_id, sessionId, channelIndex, newStreamStatus);
        }
        break;
      default:
        debug(`Received message for unknown type ${type}`);
    }
  });
}
