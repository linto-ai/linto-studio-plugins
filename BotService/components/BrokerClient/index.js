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

// Memory ceiling (T13): when rss/heap crosses this, the replica advertises EMPTY
// capabilities so the Scheduler routes elsewhere, and refuses new startBot. 0 (or
// an unparseable value) disables the ceiling. Default 2 GB is a sensible bound for
// a browser-pool-backed replica before paging/OOM risk.
const MAX_RSS_MB = (() => {
  const v = parseInt(process.env.BOTSERVICE_MAX_RSS_MB || '2048', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
})()

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

    // T13: under-pressure flag. When true the heartbeat advertises EMPTY
    // capabilities (so Scheduler.selectBotService skips us) and startBot is
    // refused. Recovers once memory drops back under the ceiling.
    this.overloaded = false

    // T9: lightweight in-memory lifecycle counters, reset never (cumulative over
    // the process lifetime) — exposed in the heartbeat `metrics` object.
    this.metrics = {
      botJoinAttempts: 0,
      botJoinSuccesses: 0,
      botJoinFailures: 0,
      participantChurn: 0
    }

    this.browserPool = new BrowserPool({ maxContexts: parseInt(process.env.MAX_CONCURRENT_BOTS || '10', 10) })
    this.audioServer = new LocalAudioServer()
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true })

    // A Chromium crash kills every bot's page at once: tear those bots down so
    // their mixers/Transcriber sockets don't leak (the pool already dropped the
    // dead contexts). The next startbot relaunches a fresh browser.
    this.browserPool.on('disconnected', () => this._handleBrowserLost())

    this._wire()
  }

  async _handleBrowserLost () {
    logger.warn(`BotService: browser lost, stopping ${this.bots.size} bot(s)`)
    await Promise.all([...this.bots.keys()].map(key => {
      const [sessionId, channelId] = key.split('_')
      return this.stopBot(sessionId, channelId)
    }))
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

  // T13: re-evaluate the memory ceiling against the given memory snapshot.
  // Sets/clears this.overloaded and logs on the transition edges.
  _evaluatePressure (mem) {
    if (!MAX_RSS_MB) return
    const rssMb = mem.rss / (1024 * 1024)
    const wasOverloaded = this.overloaded
    this.overloaded = rssMb >= MAX_RSS_MB
    if (this.overloaded && !wasOverloaded) {
      logger.warn(`BotService: memory ceiling reached (rss ${rssMb.toFixed(0)}MB >= ${MAX_RSS_MB}MB) — advertising no capabilities, refusing new bots`)
    } else if (!this.overloaded && wasOverloaded) {
      logger.info(`BotService: memory back under ceiling (rss ${rssMb.toFixed(0)}MB < ${MAX_RSS_MB}MB) — capabilities restored`)
    }
  }

  _publishStatus (force = false) {
    // Memory must be re-checked on every heartbeat regardless of the dedup below,
    // so backpressure transitions are not swallowed when activeBots is unchanged.
    const mem = process.memoryUsage()
    const prevOverloaded = this.overloaded
    this._evaluatePressure(mem)
    // T4/T13: an overload transition changes advertised capabilities, so it must
    // always be published even if the bot count did not move.
    const overloadChanged = prevOverloaded !== this.overloaded
    if (!force && !overloadChanged && this.bots.size === this.lastPublishedCount) return
    this.lastPublishedCount = this.bots.size
    this.client.publishStatus({
      activeBots: this.bots.size,
      // T4: report load so the Scheduler can weight routing by memory pressure.
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      // T9: cumulative lifecycle metrics.
      metrics: { ...this.metrics },
      // T13: advertise no capabilities while overloaded so we are skipped.
      capabilities: this.overloaded ? [] : this.capabilities
    })
  }

  // NOTE: enableDisplaySub / subSource are accepted for contract compatibility
  // (Studio still posts them, the Scheduler forwards them) but intentionally
  // unused in v1 — in-meeting caption injection was dropped (redundant with the
  // platforms' native captions and Studio's live captions; see the redesign notes).
  async startBot ({ session, channel, address, botType, websocketUrl, botId, enableDisplaySub, subSource }) {
    const key = `${session.id}_${channel.id}`
    // T13: refuse new work while over the memory ceiling (we also advertise no
    // capabilities, but a startbot may already be in flight when we crossed it).
    if (this.overloaded) {
      logger.warn(`BotService: refusing startBot ${key} — over memory ceiling (backpressure)`)
      this._publishBotError(botId, 'botservice-overloaded')
      return
    }
    logger.info(`BotService: starting bot ${key} (${botType})`)
    await this.stopBot(session.id, channel.id) // replace any stale instance

    // T9: every accepted startBot is a join attempt.
    this.metrics.botJoinAttempts++

    const bot = new Bot({ session, channel, address, botType, browserPool: this.browserPool, audioServer: this.audioServer })
    const record = { bot, ws: null, botId }
    this.bots.set(key, record)

    // Join the meeting BEFORE opening the Transcriber WS: login can be slow and
    // we don't want the Transcriber's connection-idle timeout to fire mid-join.
    const ok = await bot.init()
    if (!ok) {
      // T9 + T10: a failed join is a fatal bot error.
      this.metrics.botJoinFailures++
      this._publishBotError(botId, 'join-failed')
      await this.stopBot(session.id, channel.id)
      return
    }
    // A stopbot that arrived during the (slow) init replaced/removed our record:
    // the just-initialized bot is now an orphan — dispose it directly (stopBot
    // would no-op on the missing key and leak the live context).
    if (this.bots.get(key) !== record) {
      logger.info(`BotService: bot ${key} was stopped during init, disposing orphan`)
      await bot.dispose()
      return
    }

    // T9: the bot has joined the meeting successfully.
    this.metrics.botJoinSuccesses++
    this._connectTranscriber(key, record, websocketUrl)
    this._publishStatus()
  }

  // T10: publish a structured fatal bot error so the Scheduler can record/log it.
  _publishBotError (botId, reason) {
    if (botId === undefined || botId === null) return
    this.client.publish(`botservice/out/${botId}/bot-error`, { botId, reason }, 1, false, true)
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
      // T10: a runtime fatal error (page crash, browser disconnect, manifest
      // load failure) is published structurally for the Scheduler.
      this._publishBotError(botId, error.message || 'bot-error')
      this.stopBot(bot.session.id, bot.channel.id).catch(() => {})
    })
    // T9: count participant churn (joins + leaves) reported by the bot.
    bot.on('participant-joined', () => { this.metrics.participantChurn++ })
    bot.on('participant-left', () => { this.metrics.participantChurn++ })
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
