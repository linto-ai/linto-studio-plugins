const { MqttClient, Component, logger } = require('live-srt-lib')

/**
 * BrokerClient Component
 * MQTT client for receiving meeting events and transcriptions.
 */
class BrokerClient extends Component {
  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error'
  }

  constructor(app) {
    super(app)
    const { CONNECTING, READY, ERROR } = this.constructor.states

    this.id = this.constructor.name
    this.uniqueId = `teamsappservice-${process.env.HOSTNAME || 'local'}`
    this.state = CONNECTING
    this.pub = 'teamsappservice'

    // Static subscriptions for meeting events
    this.subs = [
      'teamsappservice/in/meeting-joined',
      'teamsappservice/in/meeting-left',
      'teamsappservice/in/bot-error'
    ]

    // Track dynamic subscriptions for transcriptions per session/channel
    this._transcriptionSubs = new Map() // key: sessionId_channelId, value: count of subscribers

    this.emit('connecting')

    this.client = new MqttClient({
      uniqueId: this.uniqueId,
      pub: this.pub,
      subs: this.subs,
      retain: false
    })

    this.client.on('ready', () => {
      this.state = READY
      logger.info(`[TeamsAppService] BrokerClient connected to MQTT broker`)
      this.emit('ready')
    })

    this.client.on('error', (err) => {
      this.state = ERROR
      logger.error(`[TeamsAppService] BrokerClient MQTT error:`, err)
      this.emit('error', err)
    })

    this.init()
  }

  /**
   * Subscribe to transcription topics for a session/channel.
   * @param {string} sessionId
   * @param {string} channelId
   */
  async subscribeToTranscriptions(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`
    const currentCount = this._transcriptionSubs.get(key) || 0

    if (currentCount === 0) {
      // First subscriber, actually subscribe
      const partialTopic = `transcriber/out/${sessionId}/${channelId}/partial`
      const finalTopic = `transcriber/out/${sessionId}/${channelId}/final`

      await this.client.subscribe(partialTopic)
      await this.client.subscribe(finalTopic)

      logger.info(`[TeamsAppService] Subscribed to transcriptions for session=${sessionId}, channel=${channelId}`)
    }

    this._transcriptionSubs.set(key, currentCount + 1)
    logger.debug(`[TeamsAppService] Transcription subscribers for ${key}: ${currentCount + 1}`)
  }

  /**
   * Unsubscribe from transcription topics for a session/channel.
   * @param {string} sessionId
   * @param {string} channelId
   */
  async unsubscribeFromTranscriptions(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`
    const currentCount = this._transcriptionSubs.get(key) || 0

    if (currentCount <= 1) {
      // Last subscriber, actually unsubscribe
      const partialTopic = `transcriber/out/${sessionId}/${channelId}/partial`
      const finalTopic = `transcriber/out/${sessionId}/${channelId}/final`

      await this.client.unsubscribe(partialTopic)
      await this.client.unsubscribe(finalTopic)

      this._transcriptionSubs.delete(key)
      logger.info(`[TeamsAppService] Unsubscribed from transcriptions for session=${sessionId}, channel=${channelId}`)
    } else {
      this._transcriptionSubs.set(key, currentCount - 1)
      logger.debug(`[TeamsAppService] Transcription subscribers for ${key}: ${currentCount - 1}`)
    }
  }

  /**
   * Get subscriber count for a session/channel.
   * @param {string} sessionId
   * @param {string} channelId
   * @returns {number}
   */
  getSubscriberCount(sessionId, channelId) {
    return this._transcriptionSubs.get(`${sessionId}_${channelId}`) || 0
  }
}

module.exports = app => new BrokerClient(app)
