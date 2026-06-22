const http = require('http')
const { WebSocketServer } = require('ws')
const { logger } = require('live-srt-lib')

// Frame wire format, emitted by the in-page webrtc-intercept capture:
//   binary: [uint16BE trackIndex][uint16BE reserved=0][...PCM S16LE 16kHz]
//   json:   a UTF-8 JSON object (control message: trackAdded/participantMapping/…)
// JSON is distinguished from PCM by sniffing the first two bytes for `{"`.
const HEADER_BYTES = 4
const JSON_BRACE = 0x7B // '{'
const JSON_QUOTE = 0x22 // '"'

/**
 * LocalAudioServer — a single loopback (127.0.0.1) WebSocket server shared by
 * every bot in the process. Each bot registers a handler under a unique path
 * and the in-page interceptor connects back to it, so audio never leaves the
 * machine and there is one server regardless of the number of concurrent bots.
 */
class LocalAudioServer {
  constructor () {
    this.server = null
    this.wss = null
    this.port = 0
    this.handlers = new Map() // path -> { onBinary, onJson, onClose }
    this.connections = new Map() // path -> ws
  }

  /** Bind to an ephemeral loopback port. Resolves once listening. */
  start () {
    return new Promise((resolve, reject) => {
      this.server = http.createServer()
      this.wss = new WebSocketServer({ server: this.server })
      this.wss.on('connection', (ws, req) => this._onConnection(ws, req))

      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        logger.info(`LocalAudioServer: listening on 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  _onConnection (ws, req) {
    const path = req.url || '/'
    const handler = this.handlers.get(path)
    if (!handler) {
      logger.warn(`LocalAudioServer: no handler for path ${path}, closing`)
      ws.close()
      return
    }
    this.connections.set(path, ws)

    ws.on('message', (message, isBinary) => this._dispatch(path, handler, message, isBinary))
    ws.on('close', () => {
      // Guard against a stale close from a connection already replaced by a reconnect.
      if (this.connections.get(path) === ws) this.connections.delete(path)
      if (handler.onClose) handler.onClose()
    })
    ws.on('error', (err) => logger.error(`LocalAudioServer: ws error on ${path}: ${err.message}`))
  }

  _dispatch (path, handler, message, isBinary) {
    if (typeof message === 'string') {
      this._handleJson(path, handler, message)
      return
    }
    if (!Buffer.isBuffer(message)) return

    // `ws` delivers text frames as Buffers when isBinary is false.
    if (isBinary === false) {
      this._handleJson(path, handler, message.toString())
      return
    }
    // A JSON control message may also arrive on a binary frame — sniff `{"`.
    if (message.length > 1 && message[0] === JSON_BRACE && message[1] === JSON_QUOTE) {
      this._handleJson(path, handler, message.toString())
      return
    }
    if (message.length > HEADER_BYTES && handler.onBinary) {
      const trackIndex = message.readUInt16BE(0)
      handler.onBinary(trackIndex, message.subarray(HEADER_BYTES))
    }
  }

  _handleJson (path, handler, raw) {
    if (!handler.onJson) return
    try {
      handler.onJson(JSON.parse(raw))
    } catch (e) {
      logger.error(`LocalAudioServer: JSON parse error on ${path}: ${e.message}`)
    }
  }

  getPort () {
    return this.port
  }

  registerBot (path, handlers) {
    this.handlers.set(path, handlers)
    logger.debug(`LocalAudioServer: handler registered for ${path}`)
  }

  unregisterBot (path) {
    const ws = this.connections.get(path)
    if (ws) {
      try { ws.close() } catch (e) { /* already closing */ }
      this.connections.delete(path)
    }
    this.handlers.delete(path)
    logger.debug(`LocalAudioServer: handler unregistered for ${path}`)
  }

  async stop () {
    for (const ws of this.connections.values()) {
      try { ws.close() } catch (e) { /* already closing */ }
    }
    this.connections.clear()
    this.handlers.clear()
    if (this.wss) { this.wss.close(); this.wss = null }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve))
      this.server = null
    }
    this.port = 0
    logger.info('LocalAudioServer: stopped')
  }
}

module.exports = LocalAudioServer
