const { logger } = require('live-srt-lib')

// Defensive JSON parse for inbound MQTT payloads. A retained topic can be cleared
// with an empty payload, and a misbehaving publisher can send malformed JSON;
// either would otherwise throw out of this async message handler and crash the
// Scheduler. Return null (and log) instead so the offending message is skipped.
function parsePayload(message, topic) {
  const raw = message.toString().trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    logger.warn(`Ignoring malformed JSON on ${topic}: ${err.message}`)
    return null
  }
}

module.exports = async function () {
  this.client.on("message", async (topic, message) => {
    // transcriber/out/+/+/final/translations
    if (topic.endsWith('final/translations')) {
      const parts = topic.split('/');
      const sessionId = parts[2];
      const channelId = parts[3];
      const translation = parsePayload(message, topic);
      if (!translation) return;
      await this.chainChannelPersist(sessionId, channelId, () => this.saveTranslation(translation, sessionId, channelId));
      return;
    }

    // transcriber/out/+/+/final
    if (topic.endsWith('final')) {
      const [type, direction, sessionId, channelId, action] = topic.split('/');
      const transcription = parsePayload(message, topic);
      if (!transcription) return;
      await this.chainChannelPersist(sessionId, channelId, () => this.saveTranscription(transcription, sessionId, channelId));
      return;
    }

    //`transcriber/out/+/status`
    const [type, direction, uniqueId, action] = topic.split('/');
    switch (type) {
      case 'transcriber':
        if (action === 'status') {
          const transcriber = parsePayload(message, topic);
          if (!transcriber) break;
          if (transcriber.online) {
            await this.registerTranscriber(transcriber);
          } else {
            await this.unregisterTranscriber(transcriber);
          }
        }
        // Session updated by a transcriber (channel status change)
        if (action === 'session'){
          const payload = parsePayload(message, topic);
          if (!payload) break;
          const {
            transcriberId: transcriberId,
            sessionId: sessionId,
            status: newStreamStatus,
            channelId: channelId
          } = payload;
          this.chainChannelPersist(sessionId, channelId, () => this.updateSession(transcriberId, sessionId, channelId, newStreamStatus));
        }
        break;
      case 'translator':
        if (action === 'status') {
          const translator = parsePayload(message, topic);
          if (!translator) break;
          if (translator.online) {
            await this.registerTranslator(translator);
          } else {
            await this.unregisterTranslator(translator);
          }
        }
        break;
      case 'scheduler':
        if (direction === 'in') {
          const payload = parsePayload(message, topic);
          if (!payload) break;
          const { botId } = payload;
          if (action === 'startbot') {
            await this.startBot(botId);
          }
          if (action === 'stopbot') {
            await this.stopBot(botId, { endSession: payload.endSession === true });
          }
        }
        break;
      case 'botservice':
        if (action === 'status') {
          const botservice = parsePayload(message, topic);
          if (!botservice) break;
          if (botservice.online) {
            this.registerBotService(botservice);
          } else {
            this.unregisterBotService(botservice);
          }
        }
        // botservice/out/<botId>/bot-error — a bot failed fatally.
        if (action === 'bot-error') {
          const payload = parsePayload(message, topic);
          if (!payload) break;
          const { botId, reason } = payload;
          await this.recordBotError(botId, reason);
        }
        break;
      default:
        logger.debug(`Received message for unknown type ${type}`);
    }
  });
}
