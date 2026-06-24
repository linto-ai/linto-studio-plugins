const { logger } = require('live-srt-lib')

// WebSocket.readyState OPEN per the WHATWG spec (the `ws` package matches it).
const OPEN = 1

// Warn at most once per this many dropped pre-ack frames: a full buffer means
// the ACK is slow/absent and the start of the transcript is being lost, which
// is worth surfacing — but the drop is counted every time, the log is throttled.
const DROP_WARN_EVERY = 100

// How long to wait for the `ack` after sending `init` before treating the socket
// as failed. A Transcriber that accepts the connection but never acks would
// otherwise buffer to maxBuffer and silently drop the start of the transcript.
const ACK_TIMEOUT_MS = parseInt(process.env.TRANSCRIBER_ACK_TIMEOUT_SECONDS || '10', 10) * 1000

/**
 * TranscriberStream — bridges one Bot's output to one Transcriber over the
 * existing WS ingest protocol, decoupled from how the socket is created so it
 * can be unit-tested with a fake ws.
 *
 * Handshake: on socket open it sends the `init` frame and then holds audio until
 * the Transcriber replies `{type:'ack'}` (ACK-gating), at which point buffered
 * frames are flushed. Speaker/participant control messages are forwarded as JSON.
 *
 * Reconnect resilience: the ACK-gated audio buffer (and its dropped-frames
 * counter) is held in an injected shared state object so it survives a socket
 * teardown. On a transient Transcriber WS close the BrokerClient builds a fresh
 * TranscriberStream over a new socket reusing the SAME `opts.buffer`; the init
 * handshake re-runs and the retained frames are flushed in order on the new ack.
 * When no buffer is injected the stream owns its own (standalone behavior).
 *
 * @param {object} ws   a ws-like object: on(event,cb), send(data), readyState
 * @param {EventEmitter} bot  emits 'audio' | 'speakerChanged' | 'participant-joined' | 'participant-left'
 * @param {object} [opts] { maxBuffer, buffer } where buffer is { buffered:[], droppedFrames:0 }
 */
class TranscriberStream {
  constructor (ws, bot, opts = {}) {
    this.ws = ws
    this.bot = bot
    this.maxBuffer = opts.maxBuffer || 500
    this.ackTimeoutMs = opts.ackTimeoutMs || ACK_TIMEOUT_MS
    this.ready = false
    this._ackTimer = null
    this._ackedOnce = false // latch the "first ack" info log
    this._disposed = false
    // ACK-gated frames + dropped-frames counter live in a shared state object so
    // they outlive this stream across a reconnect. Default to a private one.
    this.state = opts.buffer || { buffered: [], droppedFrames: 0 }
    if (!Array.isArray(this.state.buffered)) this.state.buffered = []
    if (typeof this.state.droppedFrames !== 'number') this.state.droppedFrames = 0
    this._lastWarnedDrops = this.state.droppedFrames
    this._wire()
  }

  // Accessors kept for backward-compat: tests/other code read .buffered directly.
  get buffered () { return this.state.buffered }
  set buffered (v) { this.state.buffered = v }
  get droppedFrames () { return this.state.droppedFrames }
  set droppedFrames (v) { this.state.droppedFrames = v }

  _wire () {
    // Send init and arm the ack watchdog together so a Transcriber that never
    // acks cannot hang us forever.
    this.ws.on('open', () => { this._sendInit(); this._armAckWatchdog() })
    this.ws.on('message', (message) => {
      try {
        if (JSON.parse(message.toString()).type === 'ack') {
          this._cancelAckWatchdog()
          // Log the first ack only (a reconnect re-acks; do not re-announce).
          if (!this._ackedOnce) {
            this._ackedOnce = true
            logger.info(`TranscriberStream: transcriber ack received, ${this.state.buffered.length} buffered frames flushed`)
          }
          this.ready = true
          this._flush()
        }
      } catch (e) { /* non-JSON */ }
    })
    // On socket close, drop back to ack-gated buffering so audio produced during
    // the reconnect gap is retained in the shared buffer until the replacement
    // stream flushes it; the handshake is over, so cancel the watchdog.
    this.ws.on('close', () => { this.ready = false; this._cancelAckWatchdog() })
    // Keep references to the bound bot handlers so detach() can remove them. On
    // reconnect the BrokerClient replaces this stream; without detaching, the dead
    // stream would keep buffering/forwarding bot events alongside the new one.
    this._onAudio = (buffer) => this._sendAudio(buffer)
    this._onSpeaker = (event) => this._sendControl(event)
    this._onJoin = (p) => this._sendControl({ type: 'participant', action: 'join', participant: { id: p.identity, name: p.name } })
    this._onLeave = (p) => this._sendControl({ type: 'participant', action: 'leave', participant: { id: p.identity, name: p.name } })
    this.bot.on('audio', this._onAudio)
    this.bot.on('speakerChanged', this._onSpeaker)
    this.bot.on('participant-joined', this._onJoin)
    this.bot.on('participant-left', this._onLeave)
  }

  /**
   * Stop bridging this bot — used when the BrokerClient swaps in a fresh stream
   * on reconnect. Removes the bot listeners (the shared audio buffer is left
   * intact so the replacement stream can flush it).
   */
  detach () {
    this.bot.removeListener('audio', this._onAudio)
    this.bot.removeListener('speakerChanged', this._onSpeaker)
    this.bot.removeListener('participant-joined', this._onJoin)
    this.bot.removeListener('participant-left', this._onLeave)
    // A detached stream is being replaced; its watchdog must not fire against a
    // socket nobody is listening to anymore.
    this._cancelAckWatchdog()
  }

  /**
   * Arm the init-ack watchdog. If the Transcriber accepts the socket but never
   * sends `{type:'ack'}` within ackTimeoutMs, declare the handshake failed: close
   * the socket (whose 'close' drives the BrokerClient's reconnect-or-stop logic)
   * and emit a non-fatal 'transcriber-error'. A dedicated event rather than
   * 'error' avoids the unhandled-'error' throw EventEmitter raises by default.
   * No-op if already ready or disposed.
   */
  _armAckWatchdog () {
    if (this.ready || this._disposed) return
    this._cancelAckWatchdog()
    this._ackTimer = setTimeout(() => {
      this._ackTimer = null
      if (this.ready || this._disposed) return
      logger.warn(`TranscriberStream: no ack within ${this.ackTimeoutMs / 1000}s, treating handshake as failed`)
      const err = new Error('TranscriberStream: init ack timeout')
      // Surface as an error so the owner (BrokerClient) decides reconnect vs stop.
      if (this.bot && typeof this.bot.emit === 'function') this.bot.emit('transcriber-error', err)
      try { if (typeof this.ws.close === 'function') this.ws.close() } catch (e) { /* best effort */ }
    }, this.ackTimeoutMs)
    if (this._ackTimer && typeof this._ackTimer.unref === 'function') this._ackTimer.unref()
  }

  _cancelAckWatchdog () {
    if (!this._ackTimer) return
    clearTimeout(this._ackTimer)
    this._ackTimer = null
  }

  /**
   * Tear this stream down — stop bridging the bot and cancel the watchdog so no
   * timer leaks past the stream's life. Idempotent.
   */
  dispose () {
    if (this._disposed) return
    this._disposed = true
    this._cancelAckWatchdog()
    this.detach()
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
    // While not yet ack'd on the (re)connected socket, retain frames even if the
    // socket is not open, so audio produced during a reconnect gap survives.
    if (this.ready) { if (this._isOpen()) this.ws.send(buffer); return }
    if (this.state.buffered.length >= this.maxBuffer) {
      this.state.buffered.shift() // drop oldest
      this.state.droppedFrames++
      // Throttled: do not log on every dropped frame.
      if (this.state.droppedFrames - this._lastWarnedDrops >= DROP_WARN_EVERY) {
        this._lastWarnedDrops = this.state.droppedFrames
        logger.warn(`TranscriberStream: pre-ack buffer full, ${this.state.droppedFrames} frames dropped (ACK slow/absent)`)
      }
    }
    this.state.buffered.push(buffer)
  }

  /** Number of pre-ack frames dropped because the buffer overflowed. */
  getDroppedFrames () {
    return this.state.droppedFrames
  }

  _sendControl (obj) {
    // Control messages (speakerChanged / participant) are NOT ack-gated: the
    // Transcriber creates the SpeakerTracker while processing `init` (before it
    // sends `ack`) and tolerates control before audio, so forwarding as soon as
    // the socket is open avoids dropping speaker boundaries during the handshake.
    if (this._isOpen()) this.ws.send(JSON.stringify(obj))
  }

  _flush () {
    for (const buffer of this.state.buffered) { if (this._isOpen()) this.ws.send(buffer) }
    this.state.buffered = []
  }
}

module.exports = TranscriberStream
module.exports.OPEN = OPEN
