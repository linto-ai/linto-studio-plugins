const { Component, MqttClient, logger } = require('live-srt-lib')
const WebSocket = require('ws')
const { v4: uuidv4 } = require('uuid')
const Bot = require('../../bot')
const BrowserPool = require('../../bot/BrowserPool')
const LocalAudioServer = require('../../bot/LocalAudioServer')
const TranscriberStream = require('../../bot/TranscriberStream')

const HEARTBEAT_MS = 15000
// ACK-gated audio buffer: the Transcriber WS sends 'ack' after init; until then
// we hold frames (≈10 s at 20 ms) so the first words spoken during the handshake
// are not lost. Beyond the cap we drop oldest to bound memory.
const MAX_AUDIO_BUFFER_CHUNKS = 500

const CAPABILITIES = (process.env.BOT_CAPABILITIES || Bot.KNOWN_BOT_TYPES.join(','))
  .split(',').map(s => s.trim()).filter(Boolean)

/**
 * BrokerClient — the single component of the BotService. It owns the shared
 * BrowserPool and LocalAudioServer, advertises capabilities + load to the
 * Scheduler (status + heartbeat), and on command spawns a Bot, then bridges the
 * bot's audio/diarization to a Transcriber over the existing WS ingest protocol.
 *
 * Topics (mirrors the transcriber/translator convention):
 *   out  botservice/out/<uniqueId>/status   {uniqueId, online, activeBots, capabilities}
 *   in   botservice/in/<uniqueId>/startbot  {session, channel, address, botType, websocketUrl, botId, ...}
 *   in   botservice/in/<uniqueId>/stopbot   {sessionId, channelId}
 */
class BrokerClient extends Component {
  constructor (app) {
    super(app)
    this.id = this.constructor.name
    this.uniqueId = `botservice-${uuidv4()}`
    this.pub = `botservice/out/${this.uniqueId}`
    this.subs = [`botservice/in/${this.uniqueId}/#`]
    this.capabilities = CAPABILITIES
    this.bots = new Map() // `${sessionId}_${channelId}` -> { bot, ws }
    this.heartbeatTimer = null
    this.lastPublishedCount = -1

    this.browserPool = new BrowserPool({ maxContexts: parseInt(process.env.MAX_CONCURRENT_BOTS || '10', 10) })
    this.audioServer = new LocalAudioServer()
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true })

    this._wire()
  }

  _wire () {
    this.client.on('ready', async () => {
      try {
        await this.browserPool.init()
        await this.audioServer.start()
      } catch (err) {
        logger.error(`BotService: failed to start infrastructure: ${err.message}`)
        return
      }
      this._publishStatus(true)
      this.heartbeatTimer = setInterval(() => this._publishStatus(true), HEARTBEAT_MS)
      logger.info(`BotService ${this.uniqueId} ready (capabilities: ${this.capabilities.join(', ')})`)
    })

    this.client.on('message', (topic, message) => {
      const action = topic.split('/')[3] // botservice/in/<uniqueId>/<action>
      let data
      try { data = JSON.parse(message.toString()) } catch (e) { logger.error(`BotService: bad message on ${topic}`); return }
      if (action === 'startbot') {
        this.startBot(data).catch(err => logger.error(`BotService startBot error: ${err.message}`))
      } else if (action === 'stopbot') {
        this.stopBot(data.sessionId, data.channelId).catch(err => logger.error(`BotService stopBot error: ${err.message}`))
      }
    })
  }

  _publishStatus (force = false) {
    if (!force && this.bots.size === this.lastPublishedCount) return
    this.lastPublishedCount = this.bots.size
    this.client.publishStatus({ activeBots: this.bots.size, capabilities: this.capabilities })
  }

  async startBot ({ session, channel, address, botType, websocketUrl, botId, enableDisplaySub, subSource }) {
    const key = `${session.id}_${channel.id}`
    logger.info(`BotService: starting bot ${key} (${botType})`)
    await this.stopBot(session.id, channel.id) // replace any stale instance

    const bot = new Bot({ session, channel, address, botType, browserPool: this.browserPool, audioServer: this.audioServer })
    const record = { bot, ws: null, botId }
    this.bots.set(key, record)

    // Join the meeting BEFORE opening the Transcriber WS: login can be slow and
    // we don't want the Transcriber's connection-idle timeout to fire mid-join.
    const ok = await bot.init()
    if (!ok || !this.bots.has(key)) {
      await this.stopBot(session.id, channel.id)
      return
    }

    this._connectTranscriber(key, record, websocketUrl)
    this._publishStatus()
  }

  _connectTranscriber (key, record, websocketUrl) {
    const { bot, botId } = record
    const ws = new WebSocket(websocketUrl)
    record.ws = ws
    // Data plane: handshake + ACK-gated audio + speaker/participant forwarding.
    record.stream = new TranscriberStream(ws, bot, { maxBuffer: MAX_AUDIO_BUFFER_CHUNKS })

    // Control plane: lifecycle (a closed transcriber socket ends the stream).
    ws.on('close', () => this.stopBot(bot.session.id, bot.channel.id))
    ws.on('error', (err) => logger.error(`BotService: transcriber WS error for ${key}: ${err.message}`))
    bot.on('error', (error) => {
      logger.error(`BotService: bot ${key} error: ${error.message}`)
      this.stopBot(bot.session.id, bot.channel.id).catch(() => {})
    })
    bot.on('meeting-empty', () => {
      logger.info(`BotService: bot ${key} meeting empty, leaving`)
      this._requestSchedulerCleanup(botId)
      this.stopBot(bot.session.id, bot.channel.id).catch(() => {})
    })
  }

  // On autonomous leave (empty meeting), ask the Scheduler to delete the Bot row
  // and mark the channel inactive — same path Session-API uses for DELETE /bots.
  _requestSchedulerCleanup (botId) {
    if (botId === undefined || botId === null) return
    this.client.publish('scheduler/in/schedule/stopbot', { botId }, 1, false, true)
  }

  async stopBot (sessionId, channelId) {
    const key = `${sessionId}_${channelId}`
    const record = this.bots.get(key)
    if (!record) return
    this.bots.delete(key) // delete first to make event-driven re-entry a no-op
    logger.info(`BotService: stopping bot ${key}`)
    if (record.ws) { try { record.ws.close() } catch (e) { /* already closing */ } }
    if (record.bot) { try { await record.bot.dispose() } catch (e) { logger.error(`BotService: dispose ${key}: ${e.message}`) } }
    this._publishStatus()
  }

  async destroy () {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    await Promise.all([...this.bots.keys()].map(key => {
      const [sessionId, channelId] = key.split('_')
      return this.stopBot(sessionId, channelId)
    }))
    await this.browserPool.destroy()
    await this.audioServer.stop()
  }
}

module.exports = app => new BrokerClient(app)
