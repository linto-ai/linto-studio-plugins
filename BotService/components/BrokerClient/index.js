const { Component, MqttClient, logger } = require('live-srt-lib')
const WebSocket = require('ws')
const { v4: uuidv4 } = require('uuid')
const Bot = require('../../bot')
const BrowserPool = require('../../bot/BrowserPool')
const LocalAudioServer = require('../../bot/LocalAudioServer')
const TranscriberStream = require('../../bot/TranscriberStream')
const { processTreeMemory } = require('./processTree')
const { readCgroupMemory, memoryBudget } = require('./memory')

const HEARTBEAT_MS = 15000

// How long a stopped bot may take to leave and close its browser context (its
// leave rules take up to ~8 s) before its context is closed by force and it no
// longer counts as load.
const DISPOSE_TIMEOUT_MS = 30000
// ACK-gated audio buffer: the Transcriber WS sends 'ack' after init; until then
// we hold frames (≈10 s at 20 ms) so the first words spoken during the handshake
// are not lost. Beyond the cap we drop oldest to bound memory.
const MAX_AUDIO_BUFFER_CHUNKS = 500

// A transient Transcriber blip (socket closed without an intentional stop) must
// not kill the bot: retry with bounded backoff, re-run the init handshake and
// flush the retained audio buffer on the new ack; only give up after the retries.
const RECONNECT_MAX_RETRIES = parseInt(process.env.BOTSERVICE_WS_RECONNECT_RETRIES || '3', 10)
const RECONNECT_BASE_MS = parseInt(process.env.BOTSERVICE_WS_RECONNECT_BASE_MS || '1000', 10)

// Memory ceiling in MB: when the replica's memory crosses it, the replica
// advertises EMPTY capabilities (so the Scheduler routes elsewhere) and refuses
// new startBot. null when unset: derived from the memory limit (see memory.js).
// 0 (or a malformed value) disables it.
const MAX_RSS_MB = (() => {
  const raw = process.env.BOTSERVICE_MAX_RSS_MB
  if (raw === undefined || raw === '') return null
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : 0
})()

const MB = 1024 * 1024
// How each memory figure is called in the logs.
const MEMORY_SOURCES = { cgroup: 'container working set', pss: 'process-tree PSS', rss: 'Node rss' }

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
    // Bots stopped but still being disposed (leave rules, then their browser
    // context closed): record -> promise settled once it is released. They still
    // hold a context of the pool, so they count in the advertised load, and a new
    // bot for the same channel waits for its predecessor's.
    this.disposing = new Map()
    // Starts in progress, per channel: { cancelled }. A stopbot for the channel,
    // or a newer startbot, cancels it, even while it waits for the previous bot
    // to leave (there is no record to stop yet then).
    this.pendingStarts = new Map()
    this.disposeTimeoutMs = DISPOSE_TIMEOUT_MS
    this.heartbeatTimer = null
    this.lastPublishedCount = -1

    // Under-pressure flag: when true the heartbeat advertises EMPTY capabilities
    // and startBot is refused. Recovers once memory drops back under the ceiling.
    this.overloaded = false
    // Memory readers (replaced in tests).
    this.readCgroupMemory = readCgroupMemory // () => {version, used, limit}|null
    this.readProcessTree = processTreeMemory // () => {rss, pss, processes}|null

    // Cumulative lifecycle counters, exposed in the heartbeat `metrics` object.
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
        // Without browser+audio infra this replica can never serve a bot; exit so
        // the orchestrator restarts us with a clean slate rather than leaving a zombie.
        logger.error(`BotService: failed to start infrastructure: ${err.message} — exiting for orchestrator restart`)
        process.exit(1)
        return
      }
      this._publishStatus(true)
      this.heartbeatTimer = setInterval(() => this._publishStatus(true), HEARTBEAT_MS)
      logger.info(`BotService ${this.uniqueId} ready (capabilities: ${this.capabilities.join(', ')})`)
    })

    this.client.on('message', (topic, message) => {
      const action = topic.split('/')[3] // botservice/in/<uniqueId>/<action>
      let data
      try { data = JSON.parse(message.toString()) } catch (e) { logger.error(`BotService: malformed MQTT message on ${topic}: ${e.message}`); return }
      if (action === 'startbot') {
        this.startBot(data).catch(err => logger.error(`BotService startBot error: ${err.message}`))
      } else if (action === 'stopbot') {
        this.stopBot(data.sessionId, data.channelId).catch(err => logger.error(`BotService stopBot error: ${err.message}`))
      }
    })
  }

  // The memory figure the ceiling applies to, and the ceiling (memory.js): the
  // container's working set under a memory limit, where the meeting pages
  // (Chromium renderers) are counted as the OOM killer counts them.
  _memoryBudget (mem) {
    return memoryBudget(MAX_RSS_MB, { cgroup: this.readCgroupMemory(), readTree: () => this.readProcessTree(), nodeRss: mem.rss })
  }

  // Re-evaluate the memory ceiling; sets/clears this.overloaded and logs on edges.
  // budget: { used, source, limit, ceiling } in bytes (_memoryBudget).
  _evaluatePressure (budget) {
    if (!budget.ceiling) return
    const usedMb = (budget.used / MB).toFixed(0)
    const ceilingMb = (budget.ceiling / MB).toFixed(0)
    const of = `${MEMORY_SOURCES[budget.source]} ${usedMb}MB`
    const limit = budget.limit ? `, limit ${(budget.limit / MB).toFixed(0)}MB` : ''
    const wasOverloaded = this.overloaded
    this.overloaded = budget.used >= budget.ceiling
    if (this.overloaded && !wasOverloaded) {
      logger.warn(`BotService: memory ceiling reached (${of} >= ${ceilingMb}MB${limit}) — advertising no capabilities, refusing new bots`)
    } else if (!this.overloaded && wasOverloaded) {
      logger.info(`BotService: memory back under ceiling (${of} < ${ceilingMb}MB${limit}) — capabilities restored`)
    }
  }

  _publishStatus (force = false) {
    // Memory must be re-checked on every heartbeat regardless of the dedup below,
    // so backpressure transitions are not swallowed when activeBots is unchanged.
    const mem = process.memoryUsage()
    const budget = this._memoryBudget(mem)
    const prevOverloaded = this.overloaded
    this._evaluatePressure(budget)
    // An overload transition changes advertised capabilities, so it must always be
    // published even if the bot count did not move.
    const overloadChanged = prevOverloaded !== this.overloaded
    // Bots being disposed still hold their browser context: the load is what the
    // pool actually holds, so that routing does not take a slot still in use for
    // a free one.
    const activeBots = this.bots.size + this.disposing.size
    if (!force && !overloadChanged && activeBots === this.lastPublishedCount) return
    this.lastPublishedCount = activeBots
    this.client.publishStatus({
      activeBots,
      // Report load so the Scheduler can weight routing by memory pressure.
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      // What the memory ceiling applies to (bytes; limit and ceiling null if none):
      // 'cgroup' (container working set), 'pss' (process tree) or 'rss' (Node).
      memoryUsed: budget.used,
      memorySource: budget.source,
      memoryLimit: budget.limit,
      memoryCeiling: budget.ceiling,
      metrics: { ...this.metrics },
      // Advertise no capabilities while overloaded so we are skipped.
      capabilities: this.overloaded ? [] : this.capabilities
    })
  }

  // NOTE: enableDisplaySub / subSource are accepted for contract compatibility
  // (Studio still posts them, the Scheduler forwards them) but intentionally
  // unused in v1 — in-meeting caption injection was dropped (redundant with the
  // platforms' native captions and Studio's live captions; see the redesign notes).
  async startBot ({ session, channel, address, botType, websocketUrl, botId, enableDisplaySub, subSource }) {
    const key = `${session.id}_${channel.id}`
    // Refuse new work while over the memory ceiling (a startbot may already have
    // been in flight when we crossed it, despite advertising no capabilities).
    // Measured afresh: startbots can come in bursts between two heartbeats.
    this._publishStatus()
    if (this.overloaded) {
      logger.warn(`BotService: refusing startBot ${key} — over memory ceiling (backpressure)`)
      this._publishBotError(botId, 'botservice-overloaded')
      return
    }
    logger.info(`BotService: starting bot ${key} (${botType})`)
    const start = { cancelled: false }
    const superseded = this.pendingStarts.get(key)
    if (superseded) superseded.cancelled = true
    this.pendingStarts.set(key, start)
    try {
      await this._startBot(key, start, { session, channel, address, botType, websocketUrl, botId })
    } finally {
      if (this.pendingStarts.get(key) === start) this.pendingStarts.delete(key)
    }
  }

  async _startBot (key, start, { session, channel, address, botType, websocketUrl, botId }) {
    await this._stopChannel(key) // replace any stale instance, or wait for the one leaving
    if (start.cancelled) {
      // Stopped (or superseded by a newer startbot) while the previous bot left:
      // nothing joined, nothing to report.
      logger.info(`BotService: start of bot ${key} (botId ${botId}) cancelled before joining`)
      return
    }

    this.metrics.botJoinAttempts++

    const bot = new Bot({ session, channel, address, botType, browserPool: this.browserPool, audioServer: this.audioServer })
    // The ACK-gated audio buffer (and its dropped-frames counter) lives on the
    // record, not inside TranscriberStream, so it survives a transient WS close
    // and reconnect — the new stream reuses this same object and flushes it.
    const record = {
      bot,
      ws: null,
      botId,
      websocketUrl,
      stream: null,
      audioBuffer: { buffered: [], droppedFrames: 0 },
      // Reconnect bookkeeping. `stopping` distinguishes an intentional stop
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
    // A stopbot (or a newer startbot) that arrived during the (slow) init removed
    // our record: the bot was stopped on purpose, so a join that failed meanwhile
    // is no join failure to report. Make sure it is disposed (idempotent).
    if (this.bots.get(key) !== record || start.cancelled) {
      logger.info(`BotService: bot ${key} was stopped during init, disposing orphan`)
      if (this.bots.get(key) === record) await this._stopChannel(key)
      else if (record.stopping) await this.disposing.get(record) // the stop disposes it
      else await this._dispose(key, record, () => bot.dispose())
      this._publishStatus()
      return
    }
    if (!ok) {
      // A failed join is a fatal bot error.
      this.metrics.botJoinFailures++
      this._publishBotError(botId, 'join-failed')
      await this._stopChannel(key)
      return
    }

    this.metrics.botJoinSuccesses++
    this._connectTranscriber(key, record, websocketUrl)
    this._publishStatus()
  }

  // Publish a structured fatal bot error so the Scheduler can record/log it.
  _publishBotError (botId, reason) {
    if (!Number.isInteger(botId) || botId <= 0) return // ignore missing/invalid bot ids (incl. 0)
    this.client.publish(`botservice/out/${botId}/bot-error`, { botId, reason }, 1, false, true)
  }

  _connectTranscriber (key, record, websocketUrl) {
    const { bot, botId } = record

    // Bot-lifecycle wiring is per-bot, NOT per-socket: it must be installed once,
    // or a reconnect (which opens a fresh socket) would re-register these and
    // double-count churn / double-fire stops. The socket wiring below is redone
    // on every (re)connect.
    bot.on('error', (error) => {
      logger.error(`BotService: bot ${key} (botId ${botId}) error: ${error.message}`)
      // A runtime fatal error (page crash, browser disconnect, manifest load
      // failure) is published structurally for the Scheduler.
      this._publishBotError(botId, error.message || 'bot-error')
      // Surface a teardown failure instead of swallowing it (it would otherwise
      // leak the browser context / mixer / ws).
      this.stopBot(bot.session.id, bot.channel.id, record).catch(err => logger.error(`BotService: stopBot failed for ${key} (botId ${botId}): ${err.message}`))
    })
    // Count participant churn (joins + leaves) reported by the bot.
    bot.on('participant-joined', () => { this.metrics.participantChurn++ })
    bot.on('participant-left', () => { this.metrics.participantChurn++ })
    bot.on('meeting-empty', () => {
      logger.info(`BotService: bot ${key} (botId ${botId}) meeting empty, leaving`)
      // Everyone left a real meeting → END the session, exactly as a manual stop
      // would: the Scheduler finalizes it (terminated + sessions/ended) so Studio
      // stores the conversation. endSession distinguishes this from a plain bot
      // removal (DELETE /bots) or a never-admitted leave.
      this._requestSchedulerCleanup(botId, { endSession: true })
      this.stopBot(bot.session.id, bot.channel.id, record).catch(err => logger.error(`BotService: stopBot failed for ${key} (botId ${botId}): ${err.message}`))
    })
    // A join-watchdog leave (never admitted: wrong link / not admitted / empty
    // room) is a FAILURE, not a clean empty-meeting leave. Record it as a distinct
    // bot-error so the Scheduler does not count it as a success.
    bot.on('join-timeout', () => {
      logger.warn(`BotService: bot ${key} (botId ${botId}) never admitted (join timeout), leaving`)
      this._publishBotError(botId, 'join-timeout')
      this._requestSchedulerCleanup(botId)
      this.stopBot(bot.session.id, bot.channel.id, record).catch(err => logger.error(`BotService: stopBot failed for ${key} (botId ${botId}): ${err.message}`))
    })
    // The Transcriber picks its diarization mode from the `init` frame and has no
    // mid-stream control to change it, so the Teams native→ASR fallback only takes
    // effect by reconnecting: the bot has already flipped manifest.diarizationMode
    // to 'asr', so re-opening the socket re-runs the handshake advertising 'asr'
    // and the Transcriber drops native diarization. The bot latches this event, so
    // we reconnect once.
    bot.on('diarization-degraded', ({ reason } = {}) => {
      logger.warn(`BotService: bot ${key} (botId ${botId}) diarization degraded (${reason}), reconnecting transcriber in ASR diarization mode`)
      const current = this.bots.get(key)
      if (!current || current !== record || record.stopping) return
      // Re-open the socket; the existing one is replaced (its close handler is a
      // no-op for a stale socket). The fresh init advertises diarizationMode 'asr'.
      if (record.ws) { try { record.ws.close() } catch (e) { /* already closing */ } }
      this._openSocket(key, record, record.websocketUrl)
    })
    // The TranscriberStream's init-ack watchdog emits 'transcriber-error' on the
    // bot; just log it. The watchdog has already closed the socket it owns, which
    // drives the reconnect-or-stop via the close handler, so nothing to act on here.
    bot.on('transcriber-error', (error) => {
      logger.warn(`BotService: bot ${key} (botId ${botId}) transcriber error: ${error && error.message ? error.message : error}`)
    })

    this._openSocket(key, record, websocketUrl)
    logger.info(`BotService: bot ${key} (botId ${botId}) streaming to transcriber ${websocketUrl}`)
  }

  // Open (or re-open) the Transcriber WS for a record and wire its data plane.
  // The audio buffer lives on the record, so a fresh stream over a new socket
  // re-runs the init handshake and flushes the retained frames on the new ack.
  _openSocket (key, record, websocketUrl) {
    const { bot } = record
    // Detach the previous stream's bot listeners so a reconnect does not leave a
    // dead stream double-buffering/forwarding alongside the fresh one.
    if (record.stream) { try { record.stream.detach() } catch (e) { /* best-effort */ } }
    const ws = new WebSocket(websocketUrl)
    record.ws = ws
    // Data plane: handshake + ACK-gated audio + speaker/participant forwarding.
    record.stream = new TranscriberStream(ws, bot, { maxBuffer: MAX_AUDIO_BUFFER_CHUNKS, buffer: record.audioBuffer })

    ws.on('open', () => { record.reconnectAttempts = 0 }) // a clean open resets backoff
    // Control plane: a transcriber socket close ends the stream — but a transient
    // blip (not an intentional stop) triggers a bounded reconnect first.
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

  // Schedule a reconnect with bounded exponential backoff. After the retries are
  // exhausted we give up and stopBot — a sustained Transcriber outage is fatal.
  _scheduleReconnect (key, record) {
    if (record.reconnectAttempts >= RECONNECT_MAX_RETRIES) {
      // Exhausting the retries is fatal (the bot is torn down), so publish a
      // structured bot-error so the Scheduler records WHY the bot vanished.
      logger.error(`BotService: transcriber WS for ${key} (botId ${record.botId}) gave up after ${record.reconnectAttempts} reconnect attempts, stopping bot`)
      this._publishBotError(record.botId, 'transcriber-unreachable')
      this.stopBot(record.bot.session.id, record.bot.channel.id, record).catch(err => logger.error(`BotService: stopBot failed for ${key} (botId ${record.botId}): ${err.message}`))
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

  // On autonomous leave, ask the Scheduler to delete the Bot row and mark the
  // channel inactive — same path Session-API uses for DELETE /bots. When
  // endSession is set (empty meeting: everyone left a real meeting), also ask the
  // Scheduler to END the session so Studio finalizes it like a manual stop.
  _requestSchedulerCleanup (botId, { endSession = false } = {}) {
    if (!Number.isInteger(botId) || botId <= 0) return // ignore missing/invalid bot ids (incl. 0)
    this.client.publish('scheduler/in/schedule/stopbot', { botId, endSession }, 1, false, true)
  }

  // Run a stopped bot's teardown, counted in `disposing` until it is over (once
  // per record: a second call waits for the first), or until disposeTimeoutMs:
  // a teardown that never completes (a Playwright close stuck on a wedged
  // browser) would otherwise count as load forever, and keep every later start
  // of the channel waiting. Its context is then closed by force (see
  // _forceRelease) and the teardown left to finish, or not, on its own.
  async _dispose (key, record, teardown) {
    if (this.disposing.has(record)) return this.disposing.get(record)
    record.key = key
    let timer
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => { this._forceRelease(key, record); resolve() }, this.disposeTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const done = Promise.race([teardown(), timedOut]).finally(() => {
      clearTimeout(timer)
      this.disposing.delete(record)
    })
    this.disposing.set(record, done)
    return done
  }

  // Release what a bot stuck in its teardown still holds: its loopback path, and
  // its browser context (the pool frees the slot at once, whatever the close
  // then does).
  _forceRelease (key, record) {
    const bot = record.bot
    logger.warn(`BotService: bot ${key} (botId ${record.botId}) not disposed after ${this.disposeTimeoutMs / 1000}s, closing its browser context by force`)
    if (!bot) return
    try { if (bot.wsPath) this.audioServer.unregisterBot(bot.wsPath) } catch (e) { /* best effort */ }
    if (bot.contextId) {
      Promise.resolve(this.browserPool.destroyContext(bot.contextId))
        .catch((e) => logger.debug(`BotService: forced close of ${bot.contextId}: ${e.message}`))
    }
  }

  // Settled once every bot of the channel being disposed has released its context.
  _disposalsOf (key) {
    return Promise.all([...this.disposing].filter(([record]) => record.key === key).map(([, done]) => done))
  }

  // Stop the channel's bot, and cancel a start of the channel in progress. A
  // bot's own lifecycle events (error, meeting end, join timeout, transcriber
  // unreachable) pass its record: they stop that bot only, so that a late event
  // of a bot already replaced neither stops its successor nor cancels its start.
  async stopBot (sessionId, channelId, own = null) {
    const key = `${sessionId}_${channelId}`
    if (own) return this.bots.get(key) === own ? this._stopChannel(key) : undefined
    const start = this.pendingStarts.get(key)
    if (start) start.cancelled = true
    return this._stopChannel(key)
  }

  async _stopChannel (key) {
    const record = this.bots.get(key)
    // Nothing running: a bot of the channel may still be leaving. Waiting for it
    // lets a replacement (startBot stops the channel first) reuse its context
    // rather than be refused by a full pool while it is released.
    if (!record) return this._disposalsOf(key)
    this.bots.delete(key) // delete first to make event-driven re-entry a no-op
    // Mark intentional stop so the socket-close handler does NOT reconnect, and
    // cancel any pending reconnect from an earlier transient drop.
    record.stopping = true
    if (record.reconnectTimer) { clearTimeout(record.reconnectTimer); record.reconnectTimer = null }
    logger.info(`BotService: stopping bot ${key}`)
    // Stop bridging first: the leave rules run by dispose() take seconds, during
    // which the page still captures, and audio for a socket we close on purpose
    // would only fill the pre-ack buffer (and be reported as a slow ack).
    await this._dispose(key, record, async () => {
      if (record.stream) { try { record.stream.dispose() } catch (e) { /* best-effort */ } }
      if (record.ws) { try { record.ws.close() } catch (e) { /* already closing */ } }
      if (record.bot) { try { await record.bot.dispose() } catch (e) { logger.error(`BotService: dispose ${key}: ${e.message}`) } }
    })
    this._publishStatus()
  }

  async destroy () {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const start of this.pendingStarts.values()) start.cancelled = true
    await Promise.all([...this.bots.keys()].map(key => {
      const [sessionId, channelId] = key.split('_')
      return this.stopBot(sessionId, channelId)
    }))
    await this.browserPool.destroy()
    await this.audioServer.stop()
  }
}

module.exports = app => new BrokerClient(app)
