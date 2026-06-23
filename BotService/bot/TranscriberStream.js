const { logger } = require('live-srt-lib')

// WebSocket.readyState OPEN per the WHATWG spec (the `ws` package matches it).
const OPEN = 1

// Warn at most once per this many dropped pre-ack frames: a full buffer means
// the ACK is slow/absent and the start of the transcript is being lost, which
// is worth surfacing — but the drop is counted every time, the log is throttled.
const DROP_WARN_EVERY = 100

/**
 * TranscriberStream — bridges one Bot's output to one Transcriber over the
 * existing WS ingest protocol, decoupled from how the socket is created so it
 * can be unit-tested with a fake ws.
 *
 * Handshake: on socket open it sends the `init` frame and then holds audio until
 * the Transcriber replies `{type:'ack'}` (ACK-gating), at which point buffered
 * frames are flushed. Speaker/participant control messages are forwarded as JSON.
 *
 * @param {object} ws   a ws-like object: on(event,cb), send(data), readyState
 * @param {EventEmitter} bot  emits 'audio' | 'speakerChanged' | 'participant-joined' | 'participant-left'
 * @param {object} [opts] { maxBuffer }
 */
class TranscriberStream {
  constructor (ws, bot, opts = {}) {
    this.ws = ws
    this.bot = bot
    this.maxBuffer = opts.maxBuffer || 500
    this.ready = false
    this.buffered = []
    // Pre-ack frames dropped because the buffer was full (ACK slow/absent). A
    // non-zero value localizes a gap at the very start of the transcript.
    this.droppedFrames = 0
    this._lastWarnedDrops = 0
    this._wire()
  }

  _wire () {
    this.ws.on('open', () => this._sendInit())
    this.ws.on('message', (message) => {
      try { if (JSON.parse(message.toString()).type === 'ack') { this.ready = true; this._flush() } } catch (e) { /* non-JSON */ }
    })
    this.bot.on('audio', (buffer) => this._sendAudio(buffer))
    this.bot.on('speakerChanged', (event) => this._sendControl(event))
    this.bot.on('participant-joined', (p) => this._sendControl({ type: 'participant', action: 'join', participant: { id: p.identity, name: p.name } }))
    this.bot.on('participant-left', (p) => this._sendControl({ type: 'participant', action: 'leave', participant: { id: p.identity, name: p.name } }))
  }

  _isOpen () {
    return this.ws.readyState === OPEN
  }

  _sendInit () {
    this.ws.send(JSON.stringify({
      type: 'init',
      encoding: 'pcm',
      sampleRate: 16000,
      diarizationMode: (this.bot.manifest && this.bot.manifest.diarizationMode) || 'asr',
      participants: this.bot.getParticipantsList()
    }))
  }

  _sendAudio (buffer) {
    if (!this._isOpen()) return
    if (this.ready) { this.ws.send(buffer); return }
    if (this.buffered.length >= this.maxBuffer) {
      this.buffered.shift() // drop oldest
      this.droppedFrames++
      // Throttled: do not log on every dropped frame.
      if (this.droppedFrames - this._lastWarnedDrops >= DROP_WARN_EVERY) {
        this._lastWarnedDrops = this.droppedFrames
        logger.warn(`TranscriberStream: pre-ack buffer full, ${this.droppedFrames} frames dropped (ACK slow/absent)`)
      }
    }
    this.buffered.push(buffer)
  }

  /** Number of pre-ack frames dropped because the buffer overflowed. */
  getDroppedFrames () {
    return this.droppedFrames
  }

  _sendControl (obj) {
    // Control messages (speakerChanged / participant) are NOT ack-gated: the
    // Transcriber creates the SpeakerTracker while processing `init` (before it
    // sends `ack`) and tolerates control before audio, so forwarding as soon as
    // the socket is open avoids dropping speaker boundaries during the handshake.
    if (this._isOpen()) this.ws.send(JSON.stringify(obj))
  }

  _flush () {
    for (const buffer of this.buffered) { if (this._isOpen()) this.ws.send(buffer) }
    this.buffered = []
  }
}

module.exports = TranscriberStream
module.exports.OPEN = OPEN
