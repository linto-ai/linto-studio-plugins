const { logger } = require('live-srt-lib')

/**
 * Controller for handling MQTT message events in BrokerClient.
 */
module.exports = function () {
  const self = this

  // Handle incoming MQTT messages
  this.client.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString())

      // Handle meeting-joined event
      if (topic === 'teamsappservice/in/meeting-joined') {
        logger.info(`[TeamsAppService] Received meeting-joined: sessionId=${payload.sessionId}, channelId=${payload.channelId}, threadId=${payload.threadId}`)
        self.emit('meeting-joined', payload)
        return
      }

      // Handle meeting-left event
      if (topic === 'teamsappservice/in/meeting-left') {
        logger.info(`[TeamsAppService] Received meeting-left: sessionId=${payload.sessionId}, channelId=${payload.channelId}, threadId=${payload.threadId}`)
        self.emit('meeting-left', payload)
        return
      }

      // Handle transcription messages
      if (topic.startsWith('transcriber/out/')) {
        const parts = topic.split('/')
        if (parts.length >= 5) {
          const sessionId = parts[2]
          const channelId = parts[3]
          const type = parts[4] // 'partial' or 'final'

          logger.debug(`[TeamsAppService] Received ${type} transcription for session=${sessionId}, channel=${channelId}`)

          self.emit('transcription', {
            sessionId,
            channelId,
            type,
            data: payload
          })
        }
      }
    } catch (err) {
      logger.error(`[TeamsAppService] Error parsing MQTT message on topic ${topic}:`, err)
    }
  })
}
