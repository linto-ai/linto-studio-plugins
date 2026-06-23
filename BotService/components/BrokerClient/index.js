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

// T8: Transcriber WS reconnect resilience. A transient Transcriber blip (socket
// closed without an intentional stop) should NOT kill the bot: we retry the
// connection with a bounded backoff, re-run the init handshake and flush the
// retained audio buffer on the new ack. Only after exhausting the retries do we
// give up and stopBot. Overridable for fast unit tests.
const RECONNECT_MAX_RETRIES = parseInt(process.env.BOTSERVICE_WS_RECONNECT_RETRIES || '3', 10)
const RECONNECT_BASE_MS = parseInt(process.env.BOTSERVICE_WS_RECONNECT_BASE_MS || '1000', 10)

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
    // T8: the ACK-gated audio buffer (and its dropped-frames counter) lives on the
    // record, not inside TranscriberStream, so it survives a transient WS close
    // and reconnect — the new stream reuses this same object and flushes it.
    const record = {
      bot,
      ws: null,
      botId,
      websocketUrl,
      stream: null,
      audioBuffer: { buffered: [], droppedFrames: 0 },
      // T8: reconnect bookkeeping. `stopping` distinguishes an intentional stop
      // (meeting empty / explicit stopbot / fatal error) from a transient drop:
      // only a transient drop triggers a reconnect.
      stopping: false,
      reconnectAttempts: 0,
      reconnectTimer: null
    }
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

    // Bot-lifecycle wiring is per-bot, NOT per-socket: it must be installed once,
    // or a T8 reconnect (which opens a fresh socket) would re-register these and
    // double-count churn / double-fire stops. The socket wiring below is redone
    // on every (re)connect.
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

    this._openSocket(key, record, websocketUrl)
  }

  // T8: open (or re-open) the Transcriber WS for a record and wire its data plane.
  // The audio buffer lives on the record, so a fresh stream over a new socket
  // re-runs the init handshake and flushes the retained frames on the new ack.
  _openSocket (key, record, websocketUrl) {
    const { bot } = record
    // T8: detach the previous stream's bot listeners so a reconnect does not leave
    // a dead stream double-buffering/forwarding alongside the fresh one. The shared
    // audio buffer stays on the record, so the new stream flushes it on re-ack.
    if (record.stream) { try { record.stream.detach() } catch (e) { /* best-effort */ } }
    const ws = new WebSocket(websocketUrl)
    record.ws = ws
    // Data plane: handshake + ACK-gated audio + speaker/participant forwarding.
    record.stream = new TranscriberStream(ws, bot, { maxBuffer: MAX_AUDIO_BUFFER_CHUNKS, buffer: record.audioBuffer })

    ws.on('open', () => { record.reconnectAttempts = 0 }) // a clean open resets backoff
    // Control plane: a transcriber socket close ends the stream — but a transient
    // blip (not an intentional stop) triggers a bounded reconnect first (T8).
    ws.on('close', () => {
      // Only act for the socket still attached to this record (a stale socket from
      // a previous attempt must not drive lifecycle).
      if (record.ws !== ws) return
      if (record.stopping) return // intentional stop already tearing the bot down
      if (this.bots.get(key) !== record) return // record gone (stopBot raced ahead)
      this._scheduleReconnect(key, record)
    })
    ws.on('error', (err) => logger.error(`BotService: transcriber WS error for ${key}: ${err.message}`))
  }

  // T8: schedule a reconnect with bounded exponential backoff. After the retries
  // are exhausted we give up and stopBot — a sustained Transcriber outage is fatal.
  _scheduleReconnect (key, record) {
    if (record.reconnectAttempts >= RECONNECT_MAX_RETRIES) {
      logger.warn(`BotService: transcriber WS for ${key} gave up after ${record.reconnectAttempts} reconnect attempts, stopping bot`)
      this.stopBot(record.bot.session.id, record.bot.channel.id).catch(() => {})
      return
    }
    record.reconnectAttempts++
    const delay = RECONNECT_BASE_MS * Math.pow(2, record.reconnectAttempts - 1)
    logger.warn(`BotService: transcriber WS for ${key} closed, reconnect attempt ${record.reconnectAttempts}/${RECONNECT_MAX_RETRIES} in ${delay}ms`)
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null
      if (record.stopping || this.bots.get(key) !== record) return
      this._openSocket(key, record, record.websocketUrl)
    }, delay)
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
    // T8: mark intentional stop so the socket-close handler does NOT reconnect,
    // and cancel any pending reconnect from an earlier transient drop.
    record.stopping = true
    if (record.reconnectTimer) { clearTimeout(record.reconnectTimer); record.reconnectTimer = null }
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
