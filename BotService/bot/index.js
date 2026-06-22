const path = require('path')
const EventEmitter = require('events')
const { logger } = require('live-srt-lib')
const { getInterceptScript } = require('./webrtc-intercept')
const AudioMixer = require('./AudioMixer')

// Allowlist guards the dynamic manifest require() against path traversal — botType
// originates from the (enum-constrained) DB but we validate here defensively.
const KNOWN_BOT_TYPES = ['jitsi', 'bigbluebutton', 'teams', 'visio']

// Cap on per-track audio buffered while we wait for the participant mapping to
// arrive (SFU pollers map ~2 s after join). ~150 × 20 ms frames ≈ 3 s of speech,
// so the bot's first words are attributed instead of dropped.
const MAX_EARLY_FRAMES = 150

// Page-console noise from meeting SPAs we never want in our logs.
const IGNORED_CONSOLE = [
  'Content Security Policy', 'ERR_UNKNOWN_URL_SCHEME', 'net::ERR_', 'Failed to load resource',
  'Unhandled error/rejection', 'Wake Lock', 'i18n:', 'TrouterService', 'AtpSafelinksService'
]

/**
 * Bot — drives one headless browser context that joins a single meeting, captures
 * its audio via the injected WebRTC interceptor, and (for SFU platforms) mixes
 * per-participant tracks into a diarized stream. Transport-agnostic: it emits
 * audio/speaker/participant events for the BrokerClient to forward to a Transcriber.
 *
 * @emits audio            Buffer — S16LE 16 kHz mono PCM
 * @emits speakerChanged   {position, speaker:{id,name}|null} — native diarization
 * @emits participant-joined {identity, name}
 * @emits participant-left   {identity, name}
 * @emits meeting-empty    — every mapped participant has left
 * @emits error            Error — fatal page error (caller should stop the bot)
 */
class Bot extends EventEmitter {
  constructor ({ session, channel, address, botType, browserPool, audioServer }) {
    super()
    this.session = session
    this.channel = channel
    this.address = address
    this.botType = botType
    this.browserPool = browserPool
    this.audioServer = audioServer
    this.page = null
    this.audioMixer = null
    this.contextId = `${session.id}_${channel.id}`
    this.wsPath = `/bot-${this.contextId}`
    this.botName = process.env.BOT_DISPLAY_NAME || 'LinTO Bot'
    this.emptyMeetingTimeoutMs = parseInt(process.env.EMPTY_MEETING_TIMEOUT_SECONDS || '60', 10) * 1000
    // Absolute watchdog: if NOBODY is ever seen after the bot joins (wrong link,
    // never admitted from the lobby, room already empty, mapping never resolves),
    // the empty-meeting timer never arms — so leave anyway after this window.
    this.joinTimeoutMs = parseInt(process.env.JOIN_TIMEOUT_SECONDS || '120', 10) * 1000

    this.trackParticipants = new Map() // trackIndex -> { id, name }
    this.participants = new Map() // participantId -> { id, name }
    this.earlyAudio = new Map() // trackIndex -> [Buffer] buffered until mapped (SFU)
    this.hasSeenParticipant = false
    this.emptyMeetingTimer = null
    this.joinWatchdog = null
    this.disposed = false

    this.manifest = this._loadManifest(botType)
    this.logger = logger
  }

  get isSfu () {
    return this.manifest && this.manifest.platformType === 'sfu'
  }

  _loadManifest (botType) {
    if (!KNOWN_BOT_TYPES.includes(botType)) {
      logger.error(`Bot: unknown botType '${botType}'`)
      return null
    }
    try {
      return require(path.join(__dirname, 'manifests', `${botType}.json`))
    } catch (e) {
      logger.error(`Bot: failed to load manifest for ${botType}: ${e.message}`)
      return null
    }
  }

  /**
   * Join the meeting: open a context, wire audio capture, navigate and run the
   * platform login rules. Returns true once the bot is in the meeting.
   */
  async init () {
    if (!this.manifest) return false
    try {
      logger.info(`Bot[${this.contextId}]: initializing ${this.botType}`)

      const result = await this.browserPool.createContext(this.contextId)
      if (!result) {
        logger.error(`Bot[${this.contextId}]: no browser context available (pool full)`)
        return false
      }
      this.page = result.page
      this._wirePageDiagnostics()

      // Loopback audio sink for the in-page interceptor.
      this.audioServer.registerBot(this.wsPath, {
        onBinary: (trackIndex, pcm) => this.handleAudioData(trackIndex, pcm),
        onJson: (json) => this.handleJsonMessage(json),
        onClose: () => {}
      })

      const localWsUrl = `ws://127.0.0.1:${this.audioServer.getPort()}${this.wsPath}`
      await this.page.addInitScript(getInterceptScript(localWsUrl, this.manifest))

      if (this.manifest.blockExternalDomains) {
        // Allow the meeting host and its subdomains only; match on the parsed
        // request hostname (not a raw URL substring, which "evil.com?x=allowed"
        // would slip through and "allowed.evil.com" would wrongly pass).
        const allowed = new URL(this.address).hostname
        await this.page.route('**/*', (route) => {
          let host = ''
          try { host = new URL(route.request().url()).hostname } catch (e) { host = '' }
          const ok = host === allowed || host.endsWith(`.${allowed}`)
          ok ? route.continue() : route.abort()
        })
      }

      logger.info(`Bot[${this.contextId}]: joining ${this.address}`)
      await this.page.goto(this.address, { timeout: 50000 })
      await this.execRules(this.manifest.loginRules)
      this._armJoinWatchdog()

      if (this.isSfu) {
        this._startMixer()
        logger.info(`Bot[${this.contextId}]: SFU mode, AudioMixer started`)
      } else {
        logger.info(`Bot[${this.contextId}]: ${this.manifest.platformType} mode, pass-through audio`)
      }
    } catch (error) {
      logger.error(`Bot[${this.contextId}]: init failed: ${error.message}`)
      await this.dispose()
      return false
    }
    logger.info(`Bot[${this.contextId}]: initialization complete`)
    return true
  }

  _wirePageDiagnostics () {
    this.page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (!IGNORED_CONSOLE.some(p => text.includes(p))) logger.debug(`Bot[${this.contextId}] page: ${text}`)
    })
    this.page.on('crash', () => {
      logger.error(`Bot[${this.contextId}]: page crashed`)
      this.emit('error', new Error('Page crashed'))
    })
  }

  _startMixer () {
    this.audioMixer = new AudioMixer()
    this.audioMixer.on('audio', (buffer) => this.emit('audio', buffer))
    this.audioMixer.on('speakerChanged', (event) => this.emit('speakerChanged', event))
    this.audioMixer.start()
  }

  handleAudioData (trackIndex, pcmBuffer) {
    if (this.isSfu && this.audioMixer) {
      const mapping = this.trackParticipants.get(trackIndex)
      if (mapping) {
        this.audioMixer.addAudio(mapping.id, pcmBuffer, Date.now(), mapping.name)
      } else {
        this._bufferEarlyAudio(trackIndex, pcmBuffer)
      }
    } else {
      // MCU/Teams: a single server-mixed track, forward as-is.
      this.emit('audio', pcmBuffer)
    }
  }

  _bufferEarlyAudio (trackIndex, pcmBuffer) {
    let buf = this.earlyAudio.get(trackIndex)
    if (!buf) { buf = []; this.earlyAudio.set(trackIndex, buf) }
    if (buf.length < MAX_EARLY_FRAMES) buf.push(pcmBuffer)
  }

  _flushEarlyAudio (trackIndex, participant) {
    const buffered = this.earlyAudio.get(trackIndex)
    if (!buffered || !this.audioMixer) return
    for (const pcm of buffered) {
      this.audioMixer.addAudio(participant.id, pcm, Date.now(), participant.name)
    }
    this.earlyAudio.delete(trackIndex)
  }

  handleJsonMessage (json) {
    switch (json.type) {
      case 'trackAdded':
        break
      case 'trackRemoved':
        this._onTrackRemoved(json.trackIndex)
        break
      case 'participantMapping':
        this._onParticipantMapping(json.trackIndex, json.participant)
        break
      case 'speakerChanged':
        // Teams native diarization (page-polled). SFU speaker changes come from
        // the AudioMixer, not here.
        this.emit('speakerChanged', json)
        break
      case 'participantLeft':
        this._onParticipantLeft(json.participant)
        break
      default:
        logger.debug(`Bot[${this.contextId}]: unknown control message ${json.type}`)
    }
  }

  _onParticipantMapping (trackIndex, participant) {
    this.trackParticipants.set(trackIndex, participant)
    if (!this.participants.has(participant.id)) {
      this.participants.set(participant.id, participant)
      this.emit('participant-joined', { identity: participant.id, name: participant.name })
    }
    this.hasSeenParticipant = true
    this._cancelJoinWatchdog()
    this._cancelEmptyMeetingTimer()
    this._flushEarlyAudio(trackIndex, participant)
  }

  _onTrackRemoved (trackIndex) {
    const removed = this.trackParticipants.get(trackIndex)
    this.trackParticipants.delete(trackIndex)
    this.earlyAudio.delete(trackIndex)
    if (!this.isSfu || !removed) return
    // SFU: a participant is gone once they have no remaining mapped tracks.
    const stillPresent = [...this.trackParticipants.values()].some(p => p.id === removed.id)
    if (!stillPresent) this._removeParticipant(removed.id, removed.name)
  }

  _onParticipantLeft (participant) {
    if (participant && participant.id) this._removeParticipant(participant.id, participant.name)
  }

  _removeParticipant (id, name) {
    if (!this.participants.has(id)) return
    this.participants.delete(id)
    if (this.audioMixer) this.audioMixer.removeParticipant(id)
    this.emit('participant-left', { identity: id, name })
    this._checkEmptyMeeting()
  }

  _checkEmptyMeeting () {
    if (!this.hasSeenParticipant || this.participants.size > 0) return
    if (this.emptyMeetingTimer) return
    logger.info(`Bot[${this.contextId}]: meeting empty, auto-leave in ${this.emptyMeetingTimeoutMs / 1000}s`)
    this.emptyMeetingTimer = setTimeout(() => {
      this.emptyMeetingTimer = null
      this.emit('meeting-empty')
    }, this.emptyMeetingTimeoutMs)
  }

  _cancelEmptyMeetingTimer () {
    if (!this.emptyMeetingTimer) return
    clearTimeout(this.emptyMeetingTimer)
    this.emptyMeetingTimer = null
  }

  _armJoinWatchdog () {
    if (this.joinWatchdog || this.hasSeenParticipant) return
    this.joinWatchdog = setTimeout(() => {
      this.joinWatchdog = null
      if (!this.hasSeenParticipant) {
        logger.warn(`Bot[${this.contextId}]: no participant seen within ${this.joinTimeoutMs / 1000}s, leaving`)
        this.emit('meeting-empty')
      }
    }, this.joinTimeoutMs)
  }

  _cancelJoinWatchdog () {
    if (!this.joinWatchdog) return
    clearTimeout(this.joinWatchdog)
    this.joinWatchdog = null
  }

  getParticipantsList () {
    return [...this.participants.values()].map(p => ({ id: p.id, name: p.name }))
  }

  async execRules (rules, suppressErrors = false) {
    for (const rule of rules || []) {
      try {
        await this.execRule(rule)
      } catch (e) {
        if (rule.optional || suppressErrors) {
          logger.debug(`Bot[${this.contextId}]: rule skipped (${rule.action} ${rule.selector || ''}): ${e.message}`)
        } else {
          throw e
        }
      }
    }
  }

  async execRule (rule) {
    const timeout = rule.timeout || 30000
    switch (rule.action) {
      case 'fill':
        await this.page.locator(rule.selector).fill(this._template(rule.value), { timeout })
        break
      case 'click':
        await this.page.locator(rule.selector).click({ timeout })
        break
      case 'waitForSelector':
        await this.page.locator(rule.selector).waitFor({ timeout })
        break
      case 'waitForTimeout':
        await this.page.waitForTimeout(rule.timeout)
        break
      case 'evaluate':
        await this.page.evaluate(rule.script)
        break
      case 'press':
        await this.page.keyboard.press(rule.key)
        break
      case 'goto':
        await this.page.goto(rule.url, { timeout })
        break
      case 'select':
        await this.page.locator(rule.selector).selectOption(rule.value, { timeout })
        break
      case 'hover':
        await this.page.locator(rule.selector).hover({ timeout })
        break
      case 'focus':
        await this.page.locator(rule.selector).focus({ timeout })
        break
      case 'clearInput':
        await this.page.locator(rule.selector).clear({ timeout })
        break
      default:
        logger.debug(`Bot[${this.contextId}]: unknown rule action ${rule.action}`)
    }
  }

  _template (value) {
    return typeof value === 'string' ? value.replace(/\{\{botName\}\}/g, this.botName) : value
  }

  async dispose () {
    if (this.disposed) return // idempotent: init-failure path + stopBot both call us
    this.disposed = true
    this._cancelJoinWatchdog()
    this._cancelEmptyMeetingTimer()
    if (this.audioMixer) { this.audioMixer.stop(); this.audioMixer = null }
    // Best-effort graceful leave before tearing the context down (skip if the page
    // is already gone, e.g. an init failure or a browser crash).
    if (this.manifest && this.manifest.leaveRules && this.page) {
      await this.execRules(this.manifest.leaveRules, true)
    }
    this.page = null
    this.audioServer.unregisterBot(this.wsPath)
    await this.browserPool.destroyContext(this.contextId)
    this.removeAllListeners()
    logger.info(`Bot[${this.contextId}]: disposed`)
  }
}

module.exports = Bot
module.exports.KNOWN_BOT_TYPES = KNOWN_BOT_TYPES
