const { logger } = require('live-srt-lib')

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    // transcriber/out/+/+/final/translations
    if (topic.endsWith('final/translations')) {
      const parts = topic.split('/');
      const sessionId = parts[2];
      const channelId = parts[3];
      const translation = JSON.parse(message.toString());
      await this.saveTranslation(translation, sessionId, channelId);
      return;
    }

    // transcriber/out/+/+/final
    if (topic.endsWith('final')) {
      const [type, direction, sessionId, channelId, action] = topic.split('/');
      const transcription = JSON.parse(message.toString());
      await this.saveTranscription(transcription, sessionId, channelId);
      return;
    }

    //`transcriber/out/+/status` or `botservice/out/+/status`
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
            sessionId: sessionId,
            status: newStreamStatus,
            channelId: channelId
          } = JSON.parse(message.toString());
          this.updateSession(transcriberId, sessionId, channelId, newStreamStatus);
        }
        break;
      case 'translator':
        if (action === 'status') {
          const translator = JSON.parse(message.toString());
          if (translator.online) {
            await this.registerTranslator(translator);
          } else {
            await this.unregisterTranslator(translator);
          }
        }
        break;
      case 'botservice':
        if (action === 'status') {
          const botServiceStatus = JSON.parse(message.toString());
          if (botServiceStatus.online) {
            await this.updateBotServiceStatus(botServiceStatus);
          } else {
            // BotService went offline
            this.botservices.delete(botServiceStatus.uniqueId);
            logger.info(`BotService ${botServiceStatus.uniqueId} disconnected`);
          }
        }
        break;
      case 'mediahost':
        if (action === 'status') {
          const healthPayload = JSON.parse(message.toString());
          // uniqueId is the mediaHostId from topic: mediahost/out/{mediaHostId}/status
          await this.updateMediaHostHealth(uniqueId, healthPayload);
        }
        break;
      case 'scheduler':
        if (direction === 'in') {
          const { botId } = JSON.parse(message.toString());
          if (action === 'startbot') {
            await this.startBot(botId);
          }
          if (action === 'stopbot') {
            await this.stopBot(botId);
          }
        }
        break;
      default:
        logger.debug(`Received message for unknown type ${type}`);
    }
  });
}
