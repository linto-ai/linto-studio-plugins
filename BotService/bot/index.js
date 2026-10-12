const path = require('path')
const EventEmitter = require('events')
const { logger } = require('live-srt-lib')
const { getInterceptScript } = require('./webrtc-intercept')
const AudioMixer = require('./AudioMixer')

// Guards the dynamic manifest require() against path traversal; botType comes
// from the enum-constrained DB but we validate defensively.
const KNOWN_BOT_TYPES = ['jitsi', 'bigbluebutton', 'teams', 'visio']

// Cap on per-track audio buffered while waiting for the participant mapping
// (SFU pollers map ~2 s after join). ~150 × 20 ms frames ≈ 3 s of speech, so the
// bot's first words are attributed instead of dropped.
const MAX_EARLY_FRAMES = 150

// How long an early-audio buffer may linger before the reaper drops it: a track
// whose mapping never arrives would otherwise hold memory forever.
const EARLY_AUDIO_MAX_AGE_MS = parseInt(process.env.EARLY_AUDIO_MAX_AGE_SECONDS || '30', 10) * 1000
const EARLY_AUDIO_REAP_INTERVAL_MS = EARLY_AUDIO_MAX_AGE_MS

// Audio-silence watchdog. Once admitted the bot should be receiving PCM; if the
// in-page capture pipe dies silently the bot looks alive but no audio flows and
// no other watchdog fires. Tear it down after a prolonged gap. 0 disables it.
const AUDIO_SILENCE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.AUDIO_SILENCE_TIMEOUT_SECONDS || '30', 10)
  return Number.isFinite(v) && v > 0 ? v * 1000 : 0
})()
// How often the silence watchdog re-checks the last-audio timestamp.
const AUDIO_SILENCE_CHECK_INTERVAL_MS = 5000

// Parse an env timeout (in seconds) to ms, falling back to the default for a
// missing OR malformed value. Without the Number.isFinite guard a non-numeric env
// var yields NaN, and setTimeout(fn, NaN) fires ~immediately — the bot would
// leave the meeting on startup.
function envTimeoutMs (name, defaultSeconds) {
  const v = parseInt(process.env[name], 10)
  return (Number.isFinite(v) && v > 0 ? v : defaultSeconds) * 1000
}

// A capture track is identified by the loopback connection it streams on plus its
// in-page index: every document of the page (sub-frames, or the document that a
// navigation replaces) numbers its own tracks from 0 on its own connection.
function trackKey (connId, trackIndex) {
  return `c${connId}:${trackIndex}`
}

// Page-console noise from meeting SPAs we never want in our logs.
const IGNORED_CONSOLE = [
  'Content Security Policy', 'ERR_UNKNOWN_URL_SCHEME', 'net::ERR_', 'Failed to load resource',
  'Unhandled error/rejection', 'Wake Lock', 'i18n:', 'TrouterService', 'AtpSafelinksService'
]

/**
 * Bot — drives one headless browser context that joins a single meeting, captures
 * its audio via the injected WebRTC interceptor, and (for SFU platforms) mixes
 * per-participant tracks into a diarized stream. Emits audio/speaker/participant
 * events for the BrokerClient to forward to a Transcriber.
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
    this.emptyMeetingTimeoutMs = envTimeoutMs('EMPTY_MEETING_TIMEOUT_SECONDS', 60)
    // Absolute watchdog: if nobody is ever seen after the bot joins, the
    // empty-meeting timer never arms — so leave anyway after this window.
    this.joinTimeoutMs = envTimeoutMs('JOIN_TIMEOUT_SECONDS', 120)

    this.trackParticipants = new Map() // trackKey -> { id, name }
    this.removedTracks = new Map() // trackKey -> PCM frames received after its removal
    this.participants = new Map() // participantId -> { id, name }
    this.earlyAudio = new Map() // trackKey -> [Buffer] buffered until mapped (SFU)
    this.earlyAudioFirstSeen = new Map() // trackKey -> ts of first buffered frame (reaper)
    this.earlyAudioReaper = null // interval dropping stale unmapped early-audio
    this.hasSeenParticipant = false
    this.hasSeenAudio = false // one-shot latch for the "first audio frame" log
    this.lastAudioAt = 0 // ts of the most recent PCM frame (silence watchdog)
    this.audioSilenceWatchdog = null
    this.diarizationDegraded = false // native-diar → ASR fallback latch
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
      // Deep-clone: require() caches by path, so every bot of a given type would
      // otherwise SHARE one manifest object. A process runs many bots concurrently
      // (BrowserPool, up to MAX_CONCURRENT_BOTS), and _onDiarizationDegraded mutates
      // manifest.diarizationMode in place — without a per-bot copy that flip would
      // leak to every other bot of the same type in the process.
      return JSON.parse(JSON.stringify(require(path.join(__dirname, 'manifests', `${botType}.json`))))
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
        onBinary: (trackIndex, pcm, connId) => this.handleAudioData(trackIndex, pcm, connId),
        onJson: (json, connId) => this.handleJsonMessage(json, connId),
        // learn when the loopback audio pipe drops.
        onClose: (connId) => this.notifyAudioPipeClosed(connId)
      })

      const localWsUrl = `ws://127.0.0.1:${this.audioServer.getPort()}${this.wsPath}`
      await this.page.addInitScript(getInterceptScript(localWsUrl, this.manifest))

      if (this.manifest.blockExternalDomains) {
        // Allow the meeting host and its subdomains only; match on the parsed
        // request hostname (not a raw URL substring, which "evil.com?x=allowed"
        // would slip through and "allowed.evil.com" would wrongly pass).
        let allowed
        try {
          allowed = new URL(this.address).hostname
        } catch (e) {
          // a malformed address makes the allowlist meaningless — surface the cause.
          logger.error(`Bot[${this.contextId}]: invalid address for domain allowlist: ${this.address}`)
          throw e
        }
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
      logger.info(`Bot[${this.contextId}]: login rules completed (${this.manifest.loginRules?.length || 0} rules)`)
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
      const type = msg.type()
      const text = msg.text()
      // Surface interceptor warnings so degrade conditions are visible in the logs.
      if (type === 'warning' && text.includes('[WebRTC-Intercept]')) {
        logger.warn(`Bot[${this.contextId}] page: ${text}`)
        return
      }
      if (type !== 'error') return
      // page-level failures often explain a stuck join / dead capture.
      if (!IGNORED_CONSOLE.some(p => text.includes(p))) logger.warn(`Bot[${this.contextId}] page error: ${text}`)
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

  handleAudioData (trackIndex, pcmBuffer, connId = 0) {
    const key = trackKey(connId, trackIndex)
    // The page tears a track's capture down when the track ends, so PCM still
    // tagged with a removed track comes from a leaked capture: an ended track
    // keeps rendering silence, which must never reach the mix.
    if (this.removedTracks.has(key)) {
      this._noteRemovedTrackAudio(key)
      return
    }
    // note every PCM frame for the silence watchdog.
    this.lastAudioAt = Date.now()
    if (this.isSfu) {
      this._noteFirstAudio()
      if (!this.audioMixer) return
      const mapping = this.trackParticipants.get(key)
      if (mapping) {
        this.audioMixer.addAudio(mapping.id, pcmBuffer, Date.now(), mapping.name)
      } else {
        this._bufferEarlyAudio(key, pcmBuffer)
      }
    } else {
      // MCU/Teams: a single server-mixed track, forwarded as-is.
      // Teams puts anonymous bots in a LOBBY where the page carries no meeting audio;
      // forwarding it there would push lobby silence to the ASR. Hold until a
      // participant is detected (= admitted). Other MCU bots have no lobby → stream now.
      if (this.manifest.platformType === 'teams' && !this.hasSeenParticipant) return
      this._noteFirstAudio()
      this.emit('audio', pcmBuffer)
    }
  }

  // Count PCM of a removed track; warn on the first frame only, per track.
  _noteRemovedTrackAudio (key) {
    const ignored = this.removedTracks.get(key) + 1
    this.removedTracks.set(key, ignored)
    if (ignored === 1) logger.warn(`Bot[${this.contextId}]: ignoring PCM of removed track ${key} (its in-page capture is still running)`)
  }

  // Latch + log the first PCM frame we actually forward. Gated by the callers so
  // it never fires for lobby audio on MCU bots.
  _noteFirstAudio () {
    if (this.hasSeenAudio) return
    this.hasSeenAudio = true
    logger.info(`Bot[${this.contextId}]: first audio frame received`)
  }

  _bufferEarlyAudio (key, pcmBuffer) {
    let buf = this.earlyAudio.get(key)
    if (!buf) {
      buf = []
      this.earlyAudio.set(key, buf)
      this.earlyAudioFirstSeen.set(key, Date.now()) // age for the reaper
    }
    if (buf.length < MAX_EARLY_FRAMES) buf.push(pcmBuffer)
    this._armEarlyAudioReaper()
  }

  // Drop a track's early-audio buffer and its age marker together so the two maps
  // never diverge. Called on map/flush, on track removal, and by the reaper.
  _dropEarlyAudio (key) {
    this.earlyAudio.delete(key)
    this.earlyAudioFirstSeen.delete(key)
  }

  _flushEarlyAudio (key, participant) {
    const buffered = this.earlyAudio.get(key)
    if (!buffered || !this.audioMixer) { this._dropEarlyAudio(key); return }
    for (const pcm of buffered) {
      this.audioMixer.addAudio(participant.id, pcm, Date.now(), participant.name)
    }
    this._dropEarlyAudio(key)
  }

  // Periodically drop early-audio buffers whose track was never mapped so they
  // cannot leak. Lazily armed on first early-audio, torn down once nothing is
  // buffered; .unref()'d so it never keeps the process alive.
  _armEarlyAudioReaper () {
    if (this.earlyAudioReaper || this.disposed) return
    this.earlyAudioReaper = setInterval(() => this._reapEarlyAudio(), EARLY_AUDIO_REAP_INTERVAL_MS)
    if (typeof this.earlyAudioReaper.unref === 'function') this.earlyAudioReaper.unref()
  }

  _reapEarlyAudio (now = Date.now()) {
    for (const [key, firstSeen] of [...this.earlyAudioFirstSeen.entries()]) {
      if (now - firstSeen < EARLY_AUDIO_MAX_AGE_MS) continue
      logger.debug(`Bot[${this.contextId}]: reaping stale early-audio for track ${key} (never mapped)`)
      this._dropEarlyAudio(key)
    }
    if (this.earlyAudio.size === 0) this._cancelEarlyAudioReaper()
  }

  _cancelEarlyAudioReaper () {
    if (!this.earlyAudioReaper) return
    clearInterval(this.earlyAudioReaper)
    this.earlyAudioReaper = null
  }

  handleJsonMessage (json, connId = 0) {
    switch (json.type) {
      case 'trackAdded':
        break
      case 'trackRemoved':
        this._onTrackRemoved(json.trackIndex, connId)
        break
      case 'participantMapping':
        this._onParticipantMapping(json.trackIndex, json.participant, connId)
        break
      case 'speakerChanged':
        // Teams native diarization (page-polled). SFU speaker changes come from
        // the AudioMixer, not here.
        this.emit('speakerChanged', json)
        break
      case 'participantLeft':
        this._onParticipantLeft(json.participant)
        break
      case 'diarizationDegraded':
        this._onDiarizationDegraded(json)
        break
      default:
        // an unrecognized control type means interceptor / Node are out of sync.
        logger.warn(`Bot[${this.contextId}]: unknown control message ${json.type}`)
    }
  }

  _onParticipantMapping (trackIndex, participant, connId = 0) {
    const key = trackKey(connId, trackIndex)
    this.trackParticipants.set(key, participant)
    if (!this.participants.has(participant.id)) {
      this.participants.set(participant.id, participant)
      logger.info(`Bot[${this.contextId}]: participant joined: ${participant.name} (${this.participants.size} present)`)
      this.emit('participant-joined', { identity: participant.id, name: participant.name })
    }
    // latched "admitted" milestone — the bot is in the meeting (first mapping).
    if (!this.hasSeenParticipant) {
      logger.info(`Bot[${this.contextId}]: admitted to meeting, first participant mapped (${participant.name})`)
      this._armAudioSilenceWatchdog() // from now on we expect a steady PCM flow
    }
    this.hasSeenParticipant = true
    this._cancelJoinWatchdog()
    this._cancelEmptyMeetingTimer()
    this._flushEarlyAudio(key, participant)
  }

  _onTrackRemoved (trackIndex, connId = 0) {
    const key = trackKey(connId, trackIndex)
    const removed = this.trackParticipants.get(key)
    this.trackParticipants.delete(key)
    this.removedTracks.set(key, 0)
    // always clean the early-audio buffer for a removed track, mapped or not.
    this._dropEarlyAudio(key)
    if (!this.isSfu || !removed) return
    // SFU: a participant is gone once they have no remaining mapped tracks.
    const stillPresent = [...this.trackParticipants.values()].some(p => p.id === removed.id)
    if (!stillPresent) this._removeParticipant(removed.id, removed.name)
  }

  _onParticipantLeft (participant) {
    if (participant && participant.id) this._removeParticipant(participant.id, participant.name)
  }

  // Native (Teams) diarization went away. Fall back to ASR diarization fail-soft:
  // flip the manifest mode so any future reconnect advertises 'asr', and emit an
  // event so consumers can react. Idempotent — only the first degrade is acted on.
  _onDiarizationDegraded (json) {
    if (this.diarizationDegraded) return
    this.diarizationDegraded = true
    const reason = (json && json.reason) || 'unknown'
    if (this.manifest && this.manifest.diarizationMode === 'native') {
      this.manifest.diarizationMode = 'asr'
      logger.warn(`Bot[${this.contextId}]: native diarization unavailable (${reason}), falling back to ASR diarization`)
    } else {
      logger.warn(`Bot[${this.contextId}]: native diarization reported unavailable (${reason})`)
    }
    this.emit('diarization-degraded', { mode: 'asr', reason })
  }

  _removeParticipant (id, name) {
    if (!this.participants.has(id)) return
    this.participants.delete(id)
    logger.info(`Bot[${this.contextId}]: participant left: ${name} (${this.participants.size} remaining)`)
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
        logger.warn(`Bot[${this.contextId}]: join watchdog fired — no participant within ${this.joinTimeoutMs / 1000}s (wrong link / not admitted / empty room), leaving`)
        // a never-admitted leave is a failure, not a clean empty-meeting leave —
        // emit a distinct event so it is recorded as a join timeout, not success.
        this.emit('join-timeout')
      }
    }, this.joinTimeoutMs)
  }

  _cancelJoinWatchdog () {
    if (!this.joinWatchdog) return
    clearTimeout(this.joinWatchdog)
    this.joinWatchdog = null
  }

  // Once admitted the bot must keep receiving PCM. The in-page capture pipe can
  // die silently, leaving the bot apparently alive with no audio. Arm a periodic
  // check that tears it down after a prolonged gap. Disabled when timeout is 0.
  _armAudioSilenceWatchdog () {
    if (this.audioSilenceWatchdog || this.disposed || !AUDIO_SILENCE_TIMEOUT_MS) return
    // Treat "admitted" as the start of the audio clock so a slow first frame does
    // not trip the watchdog immediately.
    this.lastAudioAt = Date.now()
    this.audioSilenceWatchdog = setInterval(() => this._checkAudioSilence(), AUDIO_SILENCE_CHECK_INTERVAL_MS)
    if (typeof this.audioSilenceWatchdog.unref === 'function') this.audioSilenceWatchdog.unref()
  }

  _checkAudioSilence (now = Date.now()) {
    if (this.disposed || !AUDIO_SILENCE_TIMEOUT_MS) return
    if (now - this.lastAudioAt < AUDIO_SILENCE_TIMEOUT_MS) return
    logger.warn(`Bot[${this.contextId}]: no audio for ${AUDIO_SILENCE_TIMEOUT_MS / 1000}s after admission — capture pipe appears dead, tearing down`)
    this._cancelAudioSilenceWatchdog()
    // surface a fatal error so the BrokerClient stops the bot instead of hanging.
    this.emit('error', new Error('audio-capture-dead'))
  }

  _cancelAudioSilenceWatchdog () {
    if (!this.audioSilenceWatchdog) return
    clearInterval(this.audioSilenceWatchdog)
    this.audioSilenceWatchdog = null
  }

  // The LocalAudioServer reports an in-page loopback socket closed. Not fatal on
  // its own (the interceptor retries) but a strong signal the capture pipe is in
  // trouble; the audio-silence watchdog declares it dead if no audio resumes.
  // The tracks that streamed on it are forgotten: a document that reconnects
  // streams them on the new connection (and replays their participant mappings),
  // one that is gone (navigated away, removed frame) never sends for them again.
  // Participants are left alone, their presence comes from mappings and leaves.
  notifyAudioPipeClosed (connId = 0) {
    if (this.disposed) return
    logger.debug(`Bot[${this.contextId}]: loopback audio connection ${connId} closed (in-page interceptor will attempt to reconnect)`)
    const prefix = trackKey(connId, '')
    for (const key of [...this.trackParticipants.keys()]) {
      if (key.startsWith(prefix)) this.trackParticipants.delete(key)
    }
    for (const key of [...this.earlyAudio.keys()]) {
      if (key.startsWith(prefix)) this._dropEarlyAudio(key)
    }
    for (const key of [...this.removedTracks.keys()]) {
      if (key.startsWith(prefix)) this.removedTracks.delete(key)
    }
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
          // a failed optional rule on a join-critical action (the buttons/gates
          // that let the bot in) warrants a warn; the rest stay at debug.
          const joinCritical = !suppressErrors && (rule.action === 'click' || rule.action === 'waitForSelector')
          const level = joinCritical ? 'warn' : 'debug'
          logger[level](`Bot[${this.contextId}]: optional join rule failed (${rule.action} ${rule.selector || ''}): ${e.message}`)
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
        // an unknown action means the manifest references a verb this engine
        // does not implement.
        logger.warn(`Bot[${this.contextId}]: unknown rule action '${rule.action}' (manifest bug?)`)
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
    this._cancelAudioSilenceWatchdog() // no timer outlives the bot
    this._cancelEarlyAudioReaper()
    this.earlyAudio.clear()
    this.earlyAudioFirstSeen.clear()
    if (this.audioMixer) { this.audioMixer.stop(); this.audioMixer = null }
    // Best-effort graceful leave before tearing the context down (skip if the page
    // is already gone). Guarded so a throwing leave-rule cannot skip the
    // unregisterBot/destroyContext/removeAllListeners cleanup below and leak.
    if (this.manifest && this.manifest.leaveRules && this.page) {
      try {
        // Click the platform "leave" control and wait so the handshake reaches the
        // server before teardown — otherwise the UI shows a lingering "leaving…" ghost.
        await this.execRules(this.manifest.leaveRules, true)
        logger.info(`Bot[${this.contextId}]: graceful leave executed`)
      } catch (e) {
        logger.debug(`Bot[${this.contextId}]: leave rules failed during dispose: ${e.message}`)
      }
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
