#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * bot-real-path.js — node-level integration harness for the REAL bot capture
 * path, with NO external meeting room and NO cloud ASR.
 *
 * Driven by tests/integration/scenarios/19-bot-real-path.sh. It wires the actual
 * BotService capture modules end-to-end against a stub Transcriber WS:
 *
 *   [in-page WebRTC loopback page]
 *        │  publishes a synthetic oscillator audio track over a real
 *        │  RTCPeerConnection offer/answer to itself
 *        ▼
 *   real BrowserPool (headless Chromium)  — production BotService/bot/BrowserPool.js
 *        │
 *   real webrtc-intercept (production BotService/bot/webrtc-intercept.js, injected
 *        │  verbatim via page.addInitScript): patches RTCPeerConnection, captures
 *        │  the inbound track, resamples it to 16 kHz S16LE in-page, and streams
 *        │  binary frames back over a loopback WebSocket.
 *        ▼
 *   real LocalAudioServer (production BotService/bot/LocalAudioServer.js): the
 *        │  loopback ws server + the exact binary/JSON wire de-framing.
 *        ▼
 *   pass-through bridge (this harness): re-emits each captured PCM frame as the
 *        │  Bot's 'audio' event — byte-for-byte what Bot.handleAudioData() does in
 *        │  its mcu (non-SFU) branch: `this.emit('audio', pcmBuffer)`. We bind the
 *        │  real TranscriberStream to this emitter exactly as BrokerClient does.
 *        ▼
 *   real TranscriberStream (production BotService/bot/TranscriberStream.js): the
 *        │  real init/ACK handshake, ack-gated buffering and audio forwarding.
 *        ▼
 *   STUB Transcriber WebSocket server (this file): replies {type:'ack'} like the
 *        real Transcriber's WebsocketServer, then counts the PCM bytes/frames it
 *        receives. It stands in for the Transcriber + fake ASR; the assertion is
 *        that real captured PCM reaches the Transcriber side.
 *
 * Why drive the modules directly instead of the Bot class: the Bot's
 * _loadManifest() requires a JSON manifest file in bot/manifests/, and the
 * BotService unit suite (tests/manifests.test.js) asserts that directory contains
 * EXACTLY the production manifests — so we cannot drop a test manifest there
 * without breaking an unrelated unit test. Driving BrowserPool + getInterceptScript
 * + LocalAudioServer + TranscriberStream directly keeps a ZERO footprint in
 * BotService while still exercising the real capture chain. The only piece this
 * harness reimplements is Bot's one-line mcu pass-through (emit('audio', pcm)),
 * which is reproduced faithfully above; the heavyweight capture/transport code is
 * all the real thing.
 *
 * Exit codes (consumed by the bash scenario):
 *   0   PASS  — real captured PCM reached the stub Transcriber
 *   1   FAIL  — wiring ran but no/insufficient PCM arrived (a real regression)
 *  42   SKIP  — headless Chromium could not launch in this environment
 *               (e.g. CI without `npx playwright install chromium`, or a
 *               Playwright/browser build mismatch). The scenario treats 42 as a
 *               clean skip, exactly like the other gated scenarios.
 */

const http = require('http')
const path = require('path')
const fs = require('fs')
const EventEmitter = require('events')

// --- Resolve the real BotService modules (production code under test) ----------
const BOT_DIR = path.resolve(__dirname, '../../../BotService/bot')
const BOTSERVICE_DIR = path.resolve(__dirname, '../../../BotService')

// `ws` is installed under BotService/node_modules, not next to this harness file,
// so resolve it from there (matches how ws-stream-bot.js locates the module).
let WebSocketServer, WebSocket
try {
  ({ WebSocketServer, WebSocket } = require(require.resolve('ws', { paths: [BOTSERVICE_DIR] })))
} catch (e) {
  console.error(`SKIP: cannot load the 'ws' module from ${BOTSERVICE_DIR} (${e.message}); run 'cd BotService && npm ci'`)
  process.exit(42)
}

let BrowserPool, LocalAudioServer, TranscriberStream, getInterceptScript
try {
  BrowserPool = require(path.join(BOT_DIR, 'BrowserPool.js'))
  LocalAudioServer = require(path.join(BOT_DIR, 'LocalAudioServer.js'))
  TranscriberStream = require(path.join(BOT_DIR, 'TranscriberStream.js'));
  ({ getInterceptScript } = require(path.join(BOT_DIR, 'webrtc-intercept.js')))
} catch (e) {
  console.error(`SKIP: cannot load BotService bot modules (${e.message}); run 'cd BotService && npm ci'`)
  process.exit(42)
}

const LOOPBACK_PAGE = path.resolve(__dirname, '../fixtures/webrtc-loopback.html')

// In-process "test platform" manifest — a plain object passed to the real
// getInterceptScript() (it only reads platformType/debug). 'mcu' => no
// platform-specific participant poller is shipped and the single captured track
// is forwarded as-is, exactly the Bot's pass-through branch. No file on disk.
const TEST_MANIFEST = { platformType: 'mcu', diarizationMode: 'asr', debug: false }

// Tunables (kept generous; the real capture chain needs a moment to spin up the
// AudioContext/AudioWorklet inside Chromium before PCM starts flowing).
const OVERALL_TIMEOUT_MS = parseInt(process.env.BOT_REAL_PATH_TIMEOUT_MS || '60000', 10)
const MIN_PCM_FRAMES = parseInt(process.env.BOT_REAL_PATH_MIN_FRAMES || '5', 10)
const MIN_PCM_BYTES = parseInt(process.env.BOT_REAL_PATH_MIN_BYTES || '2000', 10)

function log (...a) { console.log('[bot-real-path]', ...a) }

// --- Stub Transcriber WS: mirrors the real WebsocketServer init/ack handshake --
function startStubTranscriber () {
  return new Promise((resolve, reject) => {
    const stats = { init: null, ackSent: false, pcmFrames: 0, pcmBytes: 0, control: [] }
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      log('stub-transcriber: bot connected')
      ws.on('message', (message, isBinary) => {
        // Text frame (or non-binary buffer) = a control/init JSON message.
        if (!isBinary || typeof message === 'string') {
          let msg
          try { msg = JSON.parse(message.toString()) } catch (e) { return }
          if (msg.type === 'init') {
            stats.init = msg
            log('stub-transcriber: received init', JSON.stringify(msg))
            // Mirror the real Transcriber: ack the init so the stream un-gates audio.
            ws.send(JSON.stringify({ type: 'ack', message: 'Init done' }))
            stats.ackSent = true
          } else {
            stats.control.push(msg)
          }
          return
        }
        // Binary frame = PCM audio (S16LE 16k mono) forwarded by TranscriberStream.
        if (Buffer.isBuffer(message) && message.length > 0) {
          stats.pcmFrames++
          stats.pcmBytes += message.length
        }
      })
      ws.on('error', (e) => log('stub-transcriber: ws error', e.message))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      log(`stub-transcriber: listening on 127.0.0.1:${port}`)
      resolve({ server, wss, port, stats, close: () => { try { wss.close() } catch (_) {} ; try { server.close() } catch (_) {} } })
    })
  })
}

// --- Tiny HTTP server serving the loopback "meeting" page ----------------------
function startPageServer () {
  return new Promise((resolve, reject) => {
    const html = fs.readFileSync(LOOPBACK_PAGE)
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      log(`page-server: serving loopback page on 127.0.0.1:${port}`)
      resolve({ server, port, close: () => { try { server.close() } catch (_) {} } })
    })
  })
}

async function main () {
  let pool, audioServer, ws, stream, stub, pageSrv
  const wsPath = '/bot-realpath'
  const cleanup = async () => {
    try { if (stream) stream.dispose() } catch (_) {}
    try { if (ws) ws.close() } catch (_) {}
    try { if (audioServer) { audioServer.unregisterBot(wsPath); await audioServer.stop() } } catch (_) {}
    try { if (pool) await pool.destroy() } catch (_) {}
    try { if (stub) stub.close() } catch (_) {}
    try { if (pageSrv) pageSrv.close() } catch (_) {}
  }

  // 1) Bring up the REAL BrowserPool. This is the CI gate: if headless Chromium
  //    cannot launch here, SKIP cleanly (exit 42) rather than fail.
  pool = new BrowserPool({ maxContexts: 1 })
  try {
    await pool.init()
    if (!pool.browser || !pool.browser.isConnected()) {
      throw new Error('browser did not connect after init')
    }
    log('BrowserPool: Chromium launched OK')
  } catch (e) {
    console.error(`SKIP: headless Chromium unavailable (${e.message.split('\n')[0]})`)
    await cleanup()
    process.exit(42)
  }

  // 2) Real LocalAudioServer + stub Transcriber WS + page server.
  audioServer = new LocalAudioServer()
  await audioServer.start()
  stub = await startStubTranscriber()
  pageSrv = await startPageServer()

  // 3) A minimal Bot-shaped emitter: the real TranscriberStream binds to its
  //    'audio'/'speakerChanged'/'participant-*' events and reads .manifest +
  //    .getParticipantsList(). LocalAudioServer forwards captured PCM here as the
  //    'audio' event — byte-for-byte what Bot.handleAudioData() does in mcu mode.
  const bot = new EventEmitter()
  bot.manifest = TEST_MANIFEST
  bot.getParticipantsList = () => []

  // 4) Register the loopback sink and inject the REAL interceptor into the page,
  //    then navigate to the local loopback "meeting" — exactly Bot.init()'s steps.
  audioServer.registerBot(wsPath, {
    onBinary: (trackIndex, pcm) => bot.emit('audio', pcm), // mcu pass-through
    onJson: () => {},
    onClose: () => {}
  })

  const result = await pool.createContext('realpath')
  if (!result || !result.page) {
    console.error('FAIL: BrowserPool.createContext returned no page')
    await cleanup()
    process.exit(1)
  }
  const page = result.page
  const localWsUrl = `ws://127.0.0.1:${audioServer.getPort()}${wsPath}`
  await page.addInitScript(getInterceptScript(localWsUrl, TEST_MANIFEST))
  await page.goto(`http://127.0.0.1:${pageSrv.port}/`, { timeout: 50000 })
  log('Bot path: joined loopback page; real webrtc-intercept injected')

  // 5) Real TranscriberStream bridging the bot to the stub Transcriber WS —
  //    exactly as BrokerClient._openSocket() wires it in production.
  const transcriberUrl = `ws://127.0.0.1:${stub.port}/transcriber-ws/realpath-sess,0`
  ws = new WebSocket(transcriberUrl)
  stream = new TranscriberStream(ws, bot, { maxBuffer: 500, buffer: { buffered: [], droppedFrames: 0 } })

  // 6) Wait until real captured PCM reaches the stub Transcriber, or time out.
  const deadline = Date.now() + OVERALL_TIMEOUT_MS
  let lastLog = 0
  while (Date.now() < deadline) {
    const s = stub.stats
    if (s.ackSent && s.pcmFrames >= MIN_PCM_FRAMES && s.pcmBytes >= MIN_PCM_BYTES) {
      log(`PASS: init received=${!!s.init}, ack sent=${s.ackSent}, PCM frames=${s.pcmFrames}, PCM bytes=${s.pcmBytes}`)
      await cleanup()
      process.exit(0)
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now()
      log(`waiting… ack=${s.ackSent} frames=${s.pcmFrames} bytes=${s.pcmBytes}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  const s = stub.stats
  console.error(`FAIL: timed out after ${OVERALL_TIMEOUT_MS}ms — ` +
    `init=${!!s.init} ack=${s.ackSent} pcmFrames=${s.pcmFrames} pcmBytes=${s.pcmBytes} ` +
    `(need frames>=${MIN_PCM_FRAMES}, bytes>=${MIN_PCM_BYTES})`)
  await cleanup()
  process.exit(1)
}

main().catch(async (e) => {
  console.error('FAIL: unexpected error:', e && e.stack ? e.stack : e)
  process.exit(1)
})
