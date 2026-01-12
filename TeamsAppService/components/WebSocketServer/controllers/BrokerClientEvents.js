const { logger } = require('live-srt-lib')

/**
 * Controller for handling BrokerClient events in WebSocketServer.
 * Forwards transcriptions from MQTT to connected Socket.IO clients.
 */
module.exports = function () {
  const brokerClient = this.app.components['BrokerClient']

  if (!brokerClient) {
    logger.warn('[TeamsAppService] BrokerClient not available for WebSocketServer')
    return
  }

  const self = this

  // Forward transcriptions to Socket.IO clients
  brokerClient.on('transcription', (payload) => {
    const { sessionId, channelId, type, data } = payload

    // Broadcast to the appropriate room
    self.broadcastTranscription(sessionId, channelId, type, data)
  })

  // Notify clients of broker status changes
  brokerClient.on('ready', () => {
    if (self.io) {
      self.io.emit('broker_ok')
    }
  })

  brokerClient.on('error', () => {
    if (self.io) {
      self.io.emit('broker_ko')
    }
  })
}
