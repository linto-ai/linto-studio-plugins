const { logger } = require('live-srt-lib')

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    // transcriber/out/+/+/final/translations
    if (topic.endsWith('final/translations')) {
      const parts = topic.split('/');
      const sessionId = parts[2];
      const channelId = parts[3];
      const translation = JSON.parse(message.toString());
      await this.chainChannelPersist(sessionId, channelId, () => this.saveTranslation(translation, sessionId, channelId));
      return;
    }

    // transcriber/out/+/+/final
    if (topic.endsWith('final')) {
      const [type, direction, sessionId, channelId, action] = topic.split('/');
      const transcription = JSON.parse(message.toString());
      await this.chainChannelPersist(sessionId, channelId, () => this.saveTranscription(transcription, sessionId, channelId));
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
            sessionId: sessionId,
            status: newStreamStatus,
            channelId: channelId
          } = JSON.parse(message.toString());
          this.chainChannelPersist(sessionId, channelId, () => this.updateSession(transcriberId, sessionId, channelId, newStreamStatus));
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
      case 'botservice':
        if (action === 'status') {
          const botservice = JSON.parse(message.toString());
          if (botservice.online) {
            this.registerBotService(botservice);
          } else {
            this.unregisterBotService(botservice);
          }
        }
        // botservice/out/<botId>/bot-error — a bot failed fatally (T10).
        if (action === 'bot-error') {
          const { botId, reason } = JSON.parse(message.toString());
          await this.recordBotError(botId, reason);
        }
        break;
      default:
        logger.debug(`Received message for unknown type ${type}`);
    }
  });
}
