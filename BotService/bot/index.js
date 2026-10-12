const path = require('path')
const EventEmitter = require('events')
const { logger } = require('live-srt-lib')
const { getInterceptScript } = require('./webrtc-intercept')
const AudioMixer = require('./AudioMixer')

// Guards the dynamic manifest require() against path traversal; botType comes
// from the enum-constrained DB but we validate defensively.
const KNOWN_BOT_TYPES = ['jitsi', 'bigbluebutton', 'teams', 'visio']

// Audio-silence watchdog. Once admitted the bot should be receiving PCM; if the
// in-page capture pipe dies silently the bot looks alive but no audio flows and
// no other watchdog fires. Tear it down after a prolonged gap. 0 disables it.
const AUDIO_SILENCE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.AUDIO_SILENCE_TIMEOUT_SECONDS || '30', 10)
  return Number.isFinite(v) && v > 0 ? v * 1000 : 0
})()
// How often the silence watchdog re-checks the last-audio timestamp.
const AUDIO_SILENCE_CHECK_INTERVAL_MS = 5000

// Once tracks stream, how long without any participant found before warning
// (once): the pollers that find participants (Teams callingDebug, the LiveKit
// Room, Jitsi's conference) only look in the page's top-level document.
const NO_PARTICIPANT_WARN_MS = 30000

// How often a manifest's meetingEndedSelector is looked for, once admitted.
const MEETING_END_CHECK_MS = 5000

// Period of the per-bot audio health log: one line summing up the audio path
// (each track's input rate, the output rate against the wall clock, drops,
// stalls, PCM of removed tracks), so that a capture or mixing fault shows in the
// logs without a packet capture.
const AUDIO_HEALTH_INTERVAL_MS = 60000

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

// Bots created by this process: numbers each instance (see Bot.contextId).
let instanceSeq = 0

// Page-console noise from meeting SPAs we never want in our logs.
const IGNORED_CONSOLE = [
  'Content Security Policy', 'ERR_UNKNOWN_URL_SCHEME', 'net::ERR_', 'Failed to load resource',
  'Unhandled error/rejection', 'Wake Lock', 'i18n:', 'TrouterService', 'AtpSafelinksService'
]

/**
 * Bot — drives one headless browser context that joins a single meeting, captures
 * its audio via the injected WebRTC interceptor, and mixes the captured tracks
 * into one stream (diarized from per-participant tracks on SFU platforms). Emits
 * audio/speaker/participant events for the BrokerClient to forward to a Transcriber.
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
    // Its own browser context and loopback path, even for the same session and
    // channel: a bot replacing another one (stopbot then startbot) joins while
    // the previous one may still run its leave rules, and that one's teardown
    // (unregistering its path, destroying its context) must not hit the new one.
    this.contextId = `${session.id}_${channel.id}_${++instanceSeq}`
    this.wsPath = `/bot-${this.contextId}`
    this.botName = process.env.BOT_DISPLAY_NAME || 'LinTO Bot'
    this.emptyMeetingTimeoutMs = envTimeoutMs('EMPTY_MEETING_TIMEOUT_SECONDS', 60)
    // Absolute watchdog: if nobody is ever seen after the bot joins, the
    // empty-meeting timer never arms — so leave anyway after this window.
    this.joinTimeoutMs = envTimeoutMs('JOIN_TIMEOUT_SECONDS', 120)

    this.trackParticipants = new Map() // trackKey -> { id, name }
    this.removedTracks = new Map() // trackKey -> PCM frames received after its removal
    this.ignoredAudioFrames = 0 // PCM frames of removed tracks, in total
    this.participants = new Map() // participantId -> { id, name }
    this.loginComplete = false // the login rules ran to the end
    // In the meeting: a participant was found (the platforms with a participant
    // poller), or the meeting audio flows after the login rules (manifest
    // admission 'audio': platforms without one, BBB).
    this.admitted = false
    this.hasSeenParticipant = false
    this.hasSeenAudio = false // one-shot latch for the "first audio frame" log
    this.lastAudioAt = 0 // ts of the most recent PCM frame (silence watchdog)
    this.audioSilenceWatchdog = null
    this.audioHealthTimer = null
    this._audioHealth = null // counters at the start of the current health window
    this.noParticipantWarnMs = NO_PARTICIPANT_WARN_MS
    this.noParticipantTimer = null
    this.unidentifiedTracks = new Set() // keys of the tracks heard before any participant was found
    this.diarizationDegraded = false // native-diar → ASR fallback latch
    this.emptyMeetingTimer = null
    this.joinWatchdog = null
    this.meetingEndCheckMs = MEETING_END_CHECK_MS
    this.meetingEndTimer = null
    this.checkingMeetingEnd = false
    this.disposed = false

    this.manifest = this._loadManifest(botType)
    this.logger = logger
  }

  get isSfu () {
    return this.manifest && this.manifest.platformType === 'sfu'
  }

  // A platform without a participant poller (BBB: one mixed MCU stream, no roster
  // the page script can read) declares `admission: 'audio'` in its manifest: the
  // meeting audio, not a participant, tells that the bot is in the meeting, and
  // that the meeting is over once it is gone.
  get admitsOnAudio () {
    return !!this.manifest && this.manifest.admission === 'audio'
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
      this.loginComplete = true
      this._armJoinWatchdog()

      this._startMixer()
      logger.info(`Bot[${this.contextId}]: ${this.manifest.platformType} mode, AudioMixer started`)
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

  // Every platform goes through the mixer: a page can carry several tracks at
  // once (an SFU participant's mic and screen share, the track Teams replaces on
  // admission next to its successor) and they must be summed, never interleaved.
  // Speakers are derived from per-participant tracks on SFU platforms only: Teams
  // reports them from the page (callingDebug), BBB relies on ASR diarization.
  _startMixer () {
    this.audioMixer = new AudioMixer()
    this.audioMixer.on('audio', (buffer) => this.emit('audio', buffer))
    this._armAudioHealthLog()
    if (!this.isSfu) return
    this.audioMixer.on('speakerChanged', (event) => this.emit('speakerChanged', event))
    for (const [key, participant] of this.trackParticipants) this.audioMixer.setTrackParticipant(key, participant)
  }

  _armAudioHealthLog () {
    if (this.audioHealthTimer || this.disposed) return
    this._audioHealth = this._audioHealthCounters(Date.now(), this.audioMixer.getStats())
    this.audioHealthTimer = setInterval(() => this._logAudioHealth(), AUDIO_HEALTH_INTERVAL_MS)
    if (typeof this.audioHealthTimer.unref === 'function') this.audioHealthTimer.unref()
  }

  _audioHealthCounters (at, stats) {
    return {
      at,
      outputSamples: stats.outputSamples,
      droppedSamples: stats.droppedSamples,
      stalls: stats.stalls,
      ignoredFrames: this.ignoredAudioFrames,
      inputSamples: new Map(stats.tracks.map(t => [t.id, t.inputSamples]))
    }
  }

  // Log the audio health over the window since the previous call. The output
  // should run at x1.00 real time once admitted; a track flowing next to another
  // one is listed as such ("idle" when it is not delivering).
  _logAudioHealth (now = Date.now()) {
    if (!this.audioMixer || !this._audioHealth) return
    const prev = this._audioHealth
    const seconds = (now - prev.at) / 1000
    if (seconds <= 0) return
    const stats = this.audioMixer.getStats()
    const perSecond = (samples) => Math.round(samples / seconds)
    const output = stats.outputSamples - prev.outputSamples
    const tracks = stats.tracks.map(t => `${t.id}${t.active ? '' : ' idle'} ${perSecond(t.inputSamples - (prev.inputSamples.get(t.id) || 0))}/s`)
    logger.info(`Bot[${this.contextId}]: audio health over ${Math.round(seconds)}s: output ${perSecond(output)} samples/s ` +
      `(x${(output / (seconds * AudioMixer.SAMPLE_RATE)).toFixed(2)} real time), ` +
      `${stats.tracks.filter(t => t.active).length}/${stats.tracks.length} tracks flowing [${tracks.join(', ')}], ` +
      `${stats.droppedSamples - prev.droppedSamples} samples dropped, ${stats.stalls - prev.stalls} stalls, ` +
      `${this.ignoredAudioFrames - prev.ignoredFrames} frames of removed tracks ignored`)
    this._audioHealth = this._audioHealthCounters(now, stats)
  }

  _cancelAudioHealthLog () {
    if (!this.audioHealthTimer) return
    clearInterval(this.audioHealthTimer)
    this.audioHealthTimer = null
  }

  handleAudioData (trackIndex, pcmBuffer, connId = 0) {
    if (this.disposed) return
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
    if (this.admitsOnAudio) this._noteMeetingAudio()
    else if (!this.hasSeenParticipant) this._noteTrackWithoutParticipant(key)
    if (!this.audioMixer) return
    // Teams puts anonymous bots in a LOBBY where the page carries no meeting audio;
    // forwarding it there would push lobby silence to the ASR. Hold until a
    // participant is detected (= admitted). Other bots have no lobby → stream now.
    if (this.manifest.platformType === 'teams' && !this.hasSeenParticipant) return
    this._noteFirstAudio()
    // An SFU track is mixed from its first frame, before the poller maps it to its
    // participant (~2 s after join): only the speaker attribution waits for that.
    this.audioMixer.addAudio(key, pcmBuffer)
  }

  // Meeting audio on a platform admitting on audio: past the login rules (the BBB
  // client only plays the meeting audio once in it: "Listen only" was clicked),
  // the first frame is the admission; audio back after it was gone (the client
  // reconnecting its audio) cancels the leave.
  _noteMeetingAudio () {
    if (!this.admitted) {
      if (this.loginComplete) this._admit('meeting audio flowing after the login rules')
      return
    }
    if (this.emptyMeetingTimer) {
      logger.info(`Bot[${this.contextId}]: meeting audio back, staying`)
      this._cancelEmptyMeetingTimer()
    }
  }

  // Tracks stream but no participant was found: normal while waiting in a lobby,
  // a wrong assumption about the page if it lasts (the meeting client outside the
  // top-level document, where the pollers look): warn once if it does.
  _noteTrackWithoutParticipant (key) {
    this.unidentifiedTracks.add(key)
    if (this.noParticipantTimer || this.disposed) return
    this.noParticipantTimer = setTimeout(() => {
      if (this.hasSeenParticipant || this.disposed) return
      logger.warn(`Bot[${this.contextId}]: ${this.unidentifiedTracks.size} track(s) heard for ${this.noParticipantWarnMs / 1000}s but no participant found: ` +
        'still in a lobby, or the meeting client (Teams callingDebug, LiveKit Room, Jitsi conference) is not in the top-level document, where the participant pollers run')
    }, this.noParticipantWarnMs)
    if (typeof this.noParticipantTimer.unref === 'function') this.noParticipantTimer.unref()
  }

  // Count PCM of a removed track; warn on the first frame only, per track.
  _noteRemovedTrackAudio (key) {
    const ignored = this.removedTracks.get(key) + 1
    this.removedTracks.set(key, ignored)
    this.ignoredAudioFrames++
    if (ignored === 1) logger.warn(`Bot[${this.contextId}]: ignoring PCM of removed track ${key} (its in-page capture is still running)`)
  }

  // Latch + log the first PCM frame we actually forward. Gated by the caller so
  // it never fires for lobby audio on Teams bots.
  _noteFirstAudio () {
    if (this.hasSeenAudio) return
    this.hasSeenAudio = true
    logger.info(`Bot[${this.contextId}]: first audio frame received`)
  }

  handleJsonMessage (json, connId = 0) {
    // The page keeps reporting while the leave rules run: once disposing, its
    // participant leaves are the bot's own departure, and must not arm timers.
    if (this.disposed) return
    switch (json.type) {
      case 'trackAdded':
        break
      case 'trackRemoved':
        this._onTrackRemoved(json.trackIndex, connId)
        break
      case 'participantMapping':
        this._onParticipantMapping(json.trackIndex, json.participant, connId)
        break
      case 'trackUnmapped':
        this._onTrackUnmapped(json.trackIndex, connId)
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
    // Teams maps participants, not tracks (trackIndex is always 0): only SFU
    // mappings attribute a track's audio. After the join above: if the track is
    // the one speaking, the mixer announces its participant as the speaker now.
    if (this.isSfu && this.audioMixer && !this.removedTracks.has(key)) this.audioMixer.setTrackParticipant(key, participant)
    // latched "admitted" milestone — the bot is in the meeting (first mapping).
    this._admit(`first participant mapped (${participant.name})`)
    this.hasSeenParticipant = true
    this._cancelEmptyMeetingTimer()
  }

  // The bot is in the meeting (once): the join watchdog is over, a steady PCM flow
  // is expected from now on, and the meeting-end check starts.
  _admit (how) {
    if (this.admitted) return
    this.admitted = true
    logger.info(`Bot[${this.contextId}]: admitted to meeting, ${how}`)
    clearTimeout(this.noParticipantTimer)
    this._cancelJoinWatchdog()
    this._armAudioSilenceWatchdog()
    this._armMeetingEndCheck()
  }

  // The page no longer knows whose the track is (its receiver was reused, or its
  // owner is no longer among those claiming it): stop attributing its audio, under
  // a new tag; it is mapped again once its new owner is found. Its former
  // participant may still be present (on another track, or listening).
  _onTrackUnmapped (trackIndex, connId = 0) {
    const key = trackKey(connId, trackIndex)
    this.trackParticipants.delete(key)
    if (this.isSfu && this.audioMixer && this.audioMixer.hasTrack(key)) this.audioMixer.unmapTrack(key)
  }

  _onTrackRemoved (trackIndex, connId = 0) {
    const key = trackKey(connId, trackIndex)
    const removed = this.trackParticipants.get(key)
    this.trackParticipants.delete(key)
    this.removedTracks.set(key, 0)
    if (this.audioMixer) this.audioMixer.removeTrack(key)
    this._checkMeetingAudioGone()
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
    // Their tracks are no longer theirs: an SFU may reuse one for somebody else,
    // or for them, back (the page then maps it again, and they join again).
    for (const [key, participant] of [...this.trackParticipants]) {
      if (participant.id === id) this.trackParticipants.delete(key)
    }
    if (this.audioMixer) this.audioMixer.removeParticipant(id)
    this.emit('participant-left', { identity: id, name })
    this._checkEmptyMeeting()
  }

  _checkEmptyMeeting () {
    if (!this.hasSeenParticipant || this.participants.size > 0) return
    this._armEmptyMeetingTimer('meeting empty')
  }

  // A platform admitting on audio has no roster: its meeting is over when the
  // meeting audio is gone, every inbound track ended (the client closes its audio
  // connection when the meeting ends or the bot is removed: measured, a local
  // RTCPeerConnection close() ends its inbound tracks) or the page left the
  // meeting (its loopback connection closed). The same grace as an empty meeting
  // lets a client that reconnects its audio come back.
  _checkMeetingAudioGone () {
    if (!this.admitsOnAudio || !this.admitted || this.disposed) return
    if (this.audioMixer && this.audioMixer.trackIds().length > 0) return
    this._armEmptyMeetingTimer('meeting audio gone (every inbound track ended, or the page left the meeting)')
  }

  _armEmptyMeetingTimer (why) {
    if (this.emptyMeetingTimer) return
    logger.info(`Bot[${this.contextId}]: ${why}, auto-leave in ${this.emptyMeetingTimeoutMs / 1000}s`)
    this.emptyMeetingTimer = setTimeout(() => {
      this.emptyMeetingTimer = null
      this.emit('meeting-empty')
    }, this.emptyMeetingTimeoutMs)
  }

  // A manifest may name the page element that shows the meeting has ended
  // (meetingEndedSelector, e.g. BBB's meeting-ended screen): looked for every
  // meetingEndCheckMs once admitted, and the bot leaves (ending the session, as
  // an empty meeting) as soon as it is shown. Fail-soft: a selector that never
  // matches (another client version) only leaves the other end signals, and a
  // check that fails (page navigating, closing) is skipped.
  _armMeetingEndCheck () {
    const selector = this.manifest && this.manifest.meetingEndedSelector
    if (!selector || this.meetingEndTimer || this.disposed) return
    this.meetingEndTimer = setInterval(() => this._checkMeetingEnded(selector), this.meetingEndCheckMs)
    if (typeof this.meetingEndTimer.unref === 'function') this.meetingEndTimer.unref()
  }

  async _checkMeetingEnded (selector) {
    if (this.checkingMeetingEnd || !this.page || this.disposed) return
    this.checkingMeetingEnd = true
    try {
      const shown = await this.page.locator(selector).count()
      if (shown > 0 && !this.disposed) {
        logger.info(`Bot[${this.contextId}]: the meeting has ended (${selector} shown), leaving`)
        this._cancelMeetingEndCheck()
        this.emit('meeting-empty')
      }
    } catch (e) {
      logger.debug(`Bot[${this.contextId}]: meeting-end check failed: ${e.message}`)
    } finally {
      this.checkingMeetingEnd = false
    }
  }

  _cancelMeetingEndCheck () {
    if (!this.meetingEndTimer) return
    clearInterval(this.meetingEndTimer)
    this.meetingEndTimer = null
  }

  _cancelEmptyMeetingTimer () {
    if (!this.emptyMeetingTimer) return
    clearTimeout(this.emptyMeetingTimer)
    this.emptyMeetingTimer = null
  }

  _armJoinWatchdog () {
    if (this.joinWatchdog || this.admitted) return
    this.joinWatchdog = setTimeout(() => {
      this.joinWatchdog = null
      if (!this.admitted) {
        const missing = this.admitsOnAudio ? 'no meeting audio' : 'no participant'
        logger.warn(`Bot[${this.contextId}]: join watchdog fired — ${missing} within ${this.joinTimeoutMs / 1000}s (wrong link / not admitted / empty room), leaving`)
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
    // Leaving an empty meeting (or one whose audio is gone) already: no audio
    // then is no dead pipe, and the session ends cleanly at the timer.
    if (this.emptyMeetingTimer) return
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
    if (this.audioMixer) {
      for (const key of this.audioMixer.trackIds()) {
        if (key.startsWith(prefix)) this.audioMixer.removeTrack(key)
      }
    }
    for (const key of [...this.removedTracks.keys()]) {
      if (key.startsWith(prefix)) this.removedTracks.delete(key)
    }
    this._checkMeetingAudioGone()
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
    this._cancelAudioHealthLog()
    this._cancelMeetingEndCheck()
    clearTimeout(this.noParticipantTimer)
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
