const assert = require('assert')
const { describe, it } = require('mocha')
const { getInterceptScript } = require('../bot/webrtc-intercept')

const WS = 'ws://127.0.0.1:12345/bot-sess_1'

// ── Fake-browser harness ─────────────────────────────────────────────────────
// The intercept script is an IIFE that runs entirely in the page against browser
// globals (window/document/navigator/WebSocket/AudioContext/timers/Date). To test
// its REAL runtime behaviour deterministically we execute it inside a controllable
// fake environment: timers never fire on their own (we drive them by hand), Date.now
// is a settable clock, and WebSocket/AudioContext are recording fakes. No real
// network, browser, or wall-clock sleeping is involved.

function flush () { return new Promise((r) => setImmediate(r)) }

// A deterministic clock + timer scheduler. setTimeout/setInterval register callbacks
// that only run when the test explicitly drives them; advance() moves the clock.
function makeClock () {
  let now = 1000
  let seq = 1
  const timeouts = new Map() // id -> { cb, at }
  const intervals = new Map() // id -> { cb, every, last }
  const api = {
    now: () => now,
    Date: class FakeDate {
      static now () { return now }
      constructor () { this._t = now }
      getTime () { return this._t }
    },
    setTimeout (cb, ms) { const id = seq++; timeouts.set(id, { cb, at: now + (ms || 0) }); return id },
    clearTimeout (id) { timeouts.delete(id) },
    setInterval (cb, ms) { const id = seq++; intervals.set(id, { cb, every: ms || 1, last: now }); return id },
    clearInterval (id) { intervals.delete(id) },
    intervals,
    timeouts,
    // Fire any due timeouts (those whose deadline <= now).
    runDueTimeouts () {
      for (const [id, t] of [...timeouts]) {
        if (t.at <= now) { timeouts.delete(id); t.cb() }
      }
    },
    // Move the clock forward and fire due timeouts.
    advance (ms) { now += ms; api.runDueTimeouts(); return now },
    setNow (v) { now = v },
    // Manually tick every active interval once (deterministic poll).
    tickIntervals () { for (const t of [...intervals.values()]) t.cb() }
  }
  return api
}

// A fake WebSocket that records frames and lets the test drive open/close/error.
function makeFakeWS (clock) {
  const instances = []
  function FakeWebSocket (url) {
    this.url = url
    this.binaryType = 'blob'
    this.readyState = 0 // CONNECTING
    this.sent = []
    this.onopen = null
    this.onclose = null
    this.onerror = null
    instances.push(this)
  }
  FakeWebSocket.CONNECTING = 0
  FakeWebSocket.OPEN = 1
  FakeWebSocket.CLOSING = 2
  FakeWebSocket.CLOSED = 3
  FakeWebSocket.prototype.send = function (data) { this.sent.push(data) }
  FakeWebSocket.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose() }
  FakeWebSocket.prototype._open = function () { this.readyState = 1; if (this.onopen) this.onopen() }
  FakeWebSocket.prototype._fail = function () { this.readyState = 3; if (this.onclose) this.onclose() }
  FakeWebSocket.instances = instances
  return FakeWebSocket
}

// A fake AudioContext/MediaStream graph. Records nodes/sinks; the test triggers
// worklet/scriptprocessor callbacks to feed PCM through the pipeline. By default a
// context runs at opts.sampleRate whatever rate is asked for (the JS resampling
// path); opts.honorsRate grants a requested rate like Chromium does, and
// opts.rateRefused makes asking for one throw.
function makeAudioEnv (opts = {}) {
  // workletNodes: the per-track capture nodes; transports: the 'pcm-transport' nodes.
  const env = { workletNodes: [], transports: [], scriptProcessors: [], sources: [], contextOptions: [], addModuleCalls: 0, sampleRate: opts.sampleRate || 48000 }
  class FakeAudioWorkletNode {
    constructor (ctx, name, options) {
      this.name = name
      this.options = options
      this.port = { onmessage: null, posted: [], postMessage (m) { this.posted.push(m) } }
      this.connected = []
      this.disconnected = false
      if (name === 'pcm-transport') env.transports.push(this); else env.workletNodes.push(this)
    }
    connect (n) { this.connected.push(n) }
    disconnect () { this.disconnected = true }
  }
  class FakeAudioContext {
    constructor (ctxOpts) {
      if (opts.ctorThrows) throw new Error('AudioContext boom')
      const requested = ctxOpts && ctxOpts.sampleRate
      if (requested && opts.rateRefused) throw new Error('sample rate not supported')
      env.contextOptions.push(ctxOpts)
      this.state = opts.state || 'suspended'
      this.sampleRate = requested && opts.honorsRate ? requested : env.sampleRate
      this.destination = { id: 'dest' }
      this.audioWorklet = {
        // opts.addModule lets a test hold the module load pending.
        addModule: (url) => {
          env.addModuleCalls++
          return opts.addModule ? opts.addModule(url) : (async () => { if (opts.workletThrows) throw new Error('no worklet') })()
        }
      }
    }
    async resume () { this.state = 'running' }
    createMediaStreamSource () {
      // opts.failSources: how many of the first sources fail to be created.
      if (env.sources.length < (opts.failSources || 0)) { env.sources.push(null); throw new Error('source boom') }
      const source = { disconnected: false, connect () {}, disconnect () { this.disconnected = true } }
      env.sources.push(source)
      return source
    }
    createMediaStreamDestination () { return { stream: { getAudioTracks: () => [{ id: 'gum-a' }] } } }
    createOscillator () { return { connect () {}, start () {} } }
    createGain () { return { gain: {}, connect () {} } }
    createScriptProcessor () {
      const proc = { onaudioprocess: null, disconnected: false, connect () {}, disconnect () { this.disconnected = true } }
      env.scriptProcessors.push(proc)
      return proc
    }
  }
  env.AudioContext = FakeAudioContext
  env.AudioWorkletNode = FakeAudioWorkletNode
  return env
}

// A track that supports addEventListener('ended', …) and exposes a fire() helper.
function makeTrack (id, kind = 'audio') {
  const listeners = {}
  return {
    id,
    kind,
    addEventListener (ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb) },
    fire (ev) { (listeners[ev] || []).forEach((cb) => cb()) }
  }
}

// Build the full fake global environment and execute the generated IIFE in it.
// Returns handles for driving the script after init.
function runScript (script, opts = {}) {
  const clock = makeClock()
  const FakeWebSocket = makeFakeWS(clock)
  const audio = opts.audio || makeAudioEnv(opts.audioOpts || {})
  const warnings = []
  const logs = []

  // RTCPeerConnection: records construction args and the registered track handler.
  const pcInstances = []
  function OriginalRTCPeerConnection (config, constraints) {
    this.config = config
    this.constraints = constraints
    this._trackHandler = null
    pcInstances.push(this)
  }
  OriginalRTCPeerConnection.prototype.addEventListener = function (ev, cb) {
    if (ev === 'track') this._trackHandler = cb
  }
  if (opts.withGenerateCertificate) {
    OriginalRTCPeerConnection.generateCertificate = function () { return 'cert:' + this.name }
    OriginalRTCPeerConnection.name = 'orig'
  }

  const elements = opts.elements || []
  const sinks = [] // <audio> elements the capture attached tracks to
  const winListeners = {}
  const fakeWindow = {
    AudioContext: audio.AudioContext,
    webkitAudioContext: audio.AudioContext,
    RTCPeerConnection: OriginalRTCPeerConnection,
    webkitRTCPeerConnection: opts.withWebkitRTC ? OriginalRTCPeerConnection : undefined,
    WebSocket: FakeWebSocket,
    APP: opts.APP,
    callingDebug: opts.callingDebug,
    addEventListener (ev, cb) { (winListeners[ev] = winListeners[ev] || []).push(cb) }
  }
  // opts.subFrame runs the script as in an iframe (window.top is another window).
  fakeWindow.top = opts.subFrame ? {} : fakeWindow
  const fakeDocument = {
    createElement (tag) {
      const el = {
        srcObject: null, muted: false, autoplay: false, paused: false,
        getContext () { return { fillRect () {} } },
        captureStream () { return { getVideoTracks: () => [{ id: 'v' }] } },
        play () { return Promise.resolve() },
        pause () { this.paused = true }
      }
      if (tag === 'audio') sinks.push(el)
      return el
    },
    // opts.elements: the page's elements, or a function returning them (as of now).
    querySelectorAll () {
      if (opts.onQuerySelectorAll) opts.onQuerySelectorAll()
      return typeof elements === 'function' ? elements() : elements
    }
  }
  const fakeNavigator = {
    mediaDevices: opts.noMediaDevices ? undefined : {
      getUserMedia: opts.origGUM || function () { return Promise.resolve('orig') },
      enumerateDevices: opts.origEnum || function () { return Promise.resolve(['orig']) }
    }
  }
  const fakeConsole = {
    log: (...a) => logs.push(a.join(' ')),
    // Keep the full warning string. SFU warn() passes the prefix as a separate arg
    // while Teams warnTeams() inlines it; joining all args captures both forms.
    warn: (...a) => warnings.push(a.join(' '))
  }

  const fn = new Function(
    'window', 'document', 'navigator', 'WebSocket', 'AudioWorkletNode', 'AudioContext',
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'Date', 'URL', 'Blob', 'MediaStream',
    script
  )
  const FakeURL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
  const blobs = [] // source of every Blob built (the AudioWorklet module)
  function FakeBlob (parts) { blobs.push(parts.join('')) }
  function FakeMediaStream (tracks) { this.tracks = tracks; this.getAudioTracks = () => tracks }
  fn(
    fakeWindow, fakeDocument, fakeNavigator, FakeWebSocket, audio.AudioWorkletNode, audio.AudioContext,
    fakeConsole, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval,
    clock.Date, FakeURL, FakeBlob, FakeMediaStream
  )

  const fireWindow = (ev) => (winListeners[ev] || []).forEach((cb) => cb())
  return { clock, FakeWebSocket, audio, sinks, blobs, warnings, logs, pcInstances, fakeWindow, fakeNavigator, fakeDocument, OriginalRTCPeerConnection, fireWindow }
}

// Parse the JSON text frames a fake WS received (binary frames are ArrayBuffers).
function jsonFrames (ws) {
  return ws.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f))
}
function binaryFrames (ws) {
  return ws.sent.filter((f) => typeof f !== 'string')
}
// Deliver render quanta the way the transport processor posts them:
// [trackIndex, samples, trackIndex, samples, ...].
function feed (ctx, ...quanta) {
  ctx.audio.transports[0].port.onmessage({ data: quanta })
}
// Open the loopback WS that connectWs() created (first instance) and flush.
async function openLoopback (ctx) {
  await flush()
  const ws = ctx.FakeWebSocket.instances[ctx.FakeWebSocket.instances.length - 1]
  ws._open()
  await flush()
  return ws
}

describe('webrtc-intercept getInterceptScript()', () => {
  it('produces syntactically valid JavaScript', () => {
    const script = getInterceptScript(WS, { platformType: 'sfu' })
    assert.doesNotThrow(() => new Function(script)) // compiles (parses) without executing
  })

  it('intercepts RTCPeerConnection and captures PCM at 16kHz', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('RTCPeerConnection'))
    assert.ok(s.includes('pcm-capture'))
    assert.ok(s.includes('createScriptProcessor')) // AudioWorklet fallback
    assert.ok(s.includes('TARGET_SAMPLE_RATE = 16000'))
    assert.ok(s.includes('float32ToInt16'))
  })

  it('embeds the loopback WS URL as a safely-escaped string literal', () => {
    const tricky = 'ws://127.0.0.1:1/bot-"; alert(1);//'
    const s = getInterceptScript(tricky, { platformType: 'mcu' })
    assert.ok(s.includes(JSON.stringify(tricky)))
    assert.doesNotThrow(() => new Function(s))
  })

  it('enables SFU participant mapping (Jitsi + LiveKit) only for sfu', () => {
    const sfu = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(sfu.includes('findLivekitRoom'))
    assert.ok(sfu.includes('window.APP'))
    assert.ok(!sfu.includes('callingDebug'))

    const mcu = getInterceptScript(WS, { platformType: 'mcu' })
    assert.ok(!mcu.includes('findLivekitRoom'))
    assert.ok(!mcu.includes('callingDebug'))
  })

  it('enables Teams speaker polling only for teams', () => {
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('callingDebug'))
    assert.ok(teams.includes('voiceLevel'))
    assert.ok(!teams.includes('findLivekitRoom'))
  })

  it('threads the debug flag through', () => {
    assert.ok(getInterceptScript(WS, { platformType: 'sfu', debug: true }).includes('const DEBUG = true'))
    assert.ok(getInterceptScript(WS, { platformType: 'sfu' }).includes('const DEBUG = false'))
  })


  // Teams native-diar fallback + logging.
  it('logs and signals a degrade when Teams callingDebug disappears', () => {
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('console.warn'), 'warns via the page-console bridge')
    assert.ok(teams.includes('diarizationDegraded'), 'signals a degrade control message')
    assert.ok(teams.includes('NATIVE_DIAR_MISS_LIMIT'), 'detects prolonged unavailability')
    assert.ok(teams.includes("mode: 'asr'") || teams.includes('mode: "asr"'), 'fallback to ASR')
    assert.ok(teams.includes('noteCallingDebugMissing'), 'a throwing callingDebug is handled, not swallowed')
    assert.doesNotThrow(() => new Function(teams))
    // SFU build never ships the Teams degrade logic.
    const sfu = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(!sfu.includes('diarizationDegraded'))
  })

  // Sanitize participant id/name before sending.
  it('sanitizes participant id/name (control chars + length cap) before sending', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('sanitizeParticipant'), 'sanitizes participants')
    assert.ok(s.includes('SANITIZE_MAX_LEN'), 'length-caps the values')
    assert.ok(/const clean = sanitizeParticipant/.test(s), 'mapTrack routes through the sanitizer')
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('sanitizeParticipant'), 'Teams mappings go through the sanitizer')
  })

  // ── Helpers to extract pure functions from the generated source ─────────────
  function extractFn (script, name, deps) {
    // Grab a top-level `function NAME(...) { ... }` body by brace-matching.
    const sig = 'function ' + name
    const start = script.indexOf(sig)
    assert.ok(start > -1, name + ' present in script')
    let i = script.indexOf('{', start)
    let depth = 0
    for (; i < script.length; i++) {
      if (script[i] === '{') depth++
      else if (script[i] === '}') { depth--; if (depth === 0) { i++; break } }
    }
    const src = script.slice(start, i)
    return new Function((deps || '') + '\n' + src + '\nreturn ' + name + ';')()
  }

  // Construct a patched RTCPeerConnection and dispatch a 'track' event for `track`.
  function emitTrack (ctx, track) {
    const PC = ctx.fakeWindow.RTCPeerConnection
    const pc = new PC({}, {})
    if (pc._trackHandler) pc._trackHandler({ track })
    return pc
  }

  // The JS resampler only runs when the browser refuses a 16 kHz AudioContext. The
  // one it replaces was stateless per chunk and floored each chunk's output length
  // (128 frames at 44.1 kHz -> 46 samples instead of 46.44): ~15850 samples/s
  // instead of 16000, a discontinuity at every chunk boundary and no anti-aliasing.
  describe('createResampler() (behavioral)', () => {
    const script = getInterceptScript(WS, { platformType: 'sfu' })
    const createResampler = extractFn(script, 'createResampler',
      script.match(/const TARGET_SAMPLE_RATE = \d+;/)[0] + script.match(/const ANTI_ALIAS_HZ = \d+;/)[0])

    const tone = (freq, rate, n) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * freq * i / rate))
    // Deterministic pseudo-random generator (LCG) in [0, 1).
    function lcg (seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 } }
    // Feed `input` to a fresh resampler in chunks of chunkLen() samples; return the
    // concatenated output.
    function run (rate, input, chunkLen) {
      const resample = createResampler(rate)
      const parts = []
      let total = 0
      for (let i = 0; i < input.length;) {
        const n = Math.min(chunkLen(), input.length - i)
        const out = Float32Array.from(resample(input.subarray(i, i + n)))
        parts.push(out)
        total += out.length
        i += n
      }
      const all = new Float32Array(total)
      let offset = 0
      for (const part of parts) { all.set(part, offset); offset += part.length }
      return all
    }
    const dbRms = (a, from, ref) => {
      let sum = 0
      for (let i = from; i < a.length; i++) sum += a[i] * a[i]
      return 20 * Math.log10(Math.sqrt(sum / (a.length - from)) / ref)
    }

    it('yields exactly 16000 samples per second of input, whatever the chunking (no drift)', () => {
      for (const rate of [44100, 48000, 22050, 8000]) {
        const n = rate * 60 // one minute
        const rnd = lcg(rate)
        const out = run(rate, new Float32Array(n), () => 1 + Math.floor(rnd() * 600))
        // Output sample k sits at input position k*rate/16000 and is interpolated
        // towards the next input sample, so it exists once that one was received.
        assert.strictEqual(out.length, Math.ceil((n - 1) * 16000 / rate), rate + ' Hz')
      }
    })

    it('does not depend on the chunk boundaries (bit-identical to a single pass)', () => {
      const input = tone(440, 44100, 44100 * 2)
      const whole = run(44100, input, () => input.length)
      const rnd = lcg(7)
      const chunked = run(44100, input, () => 1 + Math.floor(rnd() * 300))
      assert.deepStrictEqual(chunked, whole)
    })

    it('passes the speech band and attenuates what would alias by more than 30 dB', () => {
      const ref = 0.5 / Math.SQRT2 // RMS of the input tones
      const settle = 1600 // output samples skipped while the filter settles
      for (const rate of [44100, 48000]) {
        const pass = run(rate, tone(1000, rate, rate), () => 128)
        assert.ok(Math.abs(dbRms(pass, settle, ref)) < 0.5, rate + ' Hz: 1 kHz within 0.5 dB')
        // 12 kHz folds down to 4 kHz at a 16 kHz output rate.
        const alias = run(rate, tone(12000, rate, rate), () => 128)
        assert.ok(dbRms(alias, settle, ref) < -30, rate + ' Hz: 12 kHz down by more than 30 dB')
      }
    })

    it('decimates 48 kHz by exactly 3 (no interpolation needed)', () => {
      const resample = createResampler(48000)
      assert.strictEqual(resample(new Float32Array(6)).length, 2)
      assert.strictEqual(resample(new Float32Array(48)).length, 16)
    })

    it('upsamples 8 kHz without filtering, interpolating between samples', () => {
      const resample = createResampler(8000)
      const out = resample(Float32Array.from([0, 1, 2]))
      assert.deepStrictEqual(Array.from(out), [0, 0.5, 1, 1.5])
      // The next chunk continues where the previous one stopped (2 -> 3).
      assert.deepStrictEqual(Array.from(resample(Float32Array.from([3]))), [2, 2.5])
    })
  })

  describe('float32ToInt16() (behavioral)', () => {
    const float32ToInt16 = extractFn(getInterceptScript(WS, { platformType: 'sfu' }), 'float32ToInt16')

    it('maps 0.0 to 0', () => {
      assert.strictEqual(float32ToInt16(Float32Array.from([0]))[0], 0)
    })

    it('clips values > 1.0 to the positive max (32767)', () => {
      assert.strictEqual(float32ToInt16(Float32Array.from([5.0]))[0], 32767)
    })

    it('clips values < -1.0 to the negative max (-32768)', () => {
      assert.strictEqual(float32ToInt16(Float32Array.from([-5.0]))[0], -32768)
    })

    it('maps exactly 1.0 to 32767 and exactly -1.0 to -32768', () => {
      const out = float32ToInt16(Float32Array.from([1.0, -1.0]))
      assert.strictEqual(out[0], 32767)
      assert.strictEqual(out[1], -32768)
    })

    it('scales positive and negative fractions with the correct asymmetric factor', () => {
      const out = float32ToInt16(Float32Array.from([0.5, -0.5]))
      // Positive scales by 32767, negative by 32768; Int16Array assignment truncates.
      assert.strictEqual(out[0], Math.trunc(0.5 * 32767))
      assert.strictEqual(out[1], Math.trunc(-0.5 * 32768))
    })
  })

  describe('16 kHz capture (behavioral)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    const pcmSamples = (frames) => frames.reduce((n, f) => n + (f.byteLength - 4) / 2, 0)

    it('asks for a 16 kHz AudioContext and sends its samples as they are when granted', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000, honorsRate: true } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t16'))
      await flush(); await flush()
      assert.ok(ctx.audio.contextOptions.some((o) => o && o.sampleRate === 16000), 'context requested at 16 kHz')
      feed(ctx, 0, Float32Array.from([0.5, -0.5, 0.25]))
      const bin = binaryFrames(ws)[0]
      const view = new DataView(bin)
      assert.strictEqual(bin.byteLength, 4 + 3 * 2, 'no resampling at 16 kHz')
      assert.strictEqual(view.getInt16(4, true), Math.trunc(0.5 * 32767))
      assert.strictEqual(view.getInt16(6, true), Math.trunc(-0.5 * 32768))
      assert.strictEqual(ctx.warnings.filter((w) => w.includes('16 kHz AudioContext')).length, 0)
    })

    it('falls back to the default rate and the JS resampler when 16 kHz is refused (warned)', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000, rateRefused: true } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t48'))
      await flush(); await flush()
      assert.ok(ctx.warnings.some((w) => w.includes('16 kHz AudioContext unavailable')))
      feed(ctx, 0, new Float32Array(48))
      assert.strictEqual(pcmSamples(binaryFrames(ws)), 16)
    })

    it('carries the resampling phase across chunks: 44.1 kHz in 128-frame chunks gives exactly 16000/s', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 44100 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t44'))
      await flush(); await flush()
      // One second of render quanta (the last one partial).
      for (let sent = 0; sent < 44100; sent += 128) feed(ctx, 0, new Float32Array(Math.min(128, 44100 - sent)))
      assert.strictEqual(pcmSamples(binaryFrames(ws)), Math.ceil(44099 * 16000 / 44100)) // 16000, not 344 * 46
    })

    it('the ScriptProcessor fallback resamples with the same stateful resampler', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 44100, workletThrows: true } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('tsp'))
      await flush(); await flush()
      const proc = ctx.audio.scriptProcessors[0]
      for (let sent = 0; sent < 44100 * 2; sent += 4096) {
        const n = Math.min(4096, 44100 * 2 - sent)
        proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(n) } })
      }
      assert.strictEqual(pcmSamples(binaryFrames(ws)), Math.ceil((44100 * 2 - 1) * 16000 / 44100)) // 32000
    })
  })

  // Per-node worklet ports reorder tracks after a main-thread stall (each port's
  // backlog is drained in one go); one transport keeps every quantum in render order.
  describe('ordered delivery through one transport (behavioral)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })

    it('loads the module once and starts a single transport for tracks set up together', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      await openLoopback(ctx)
      emitTrack(ctx, makeTrack('a'))
      emitTrack(ctx, makeTrack('b'))
      await flush(); await flush(); await flush()
      assert.strictEqual(ctx.audio.addModuleCalls, 1)
      assert.strictEqual(ctx.audio.transports.length, 1)
      assert.deepStrictEqual(ctx.audio.transports[0].connected, [{ id: 'dest' }], 'transport kept processing')
      assert.deepStrictEqual(ctx.audio.workletNodes.map((n) => n.options.processorOptions.trackIndex).sort(), [0, 1])
    })

    it('sends the quanta of a transport message in render order, each tagged with its track', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('a'))
      emitTrack(ctx, makeTrack('b'))
      await flush(); await flush(); await flush()
      feed(ctx, 0, new Float32Array(4), 1, new Float32Array(4), 0, new Float32Array(4), 1, new Float32Array(4))
      assert.deepStrictEqual(binaryFrames(ws).map((f) => new DataView(f).getUint16(0, false)), [0, 1, 0, 1])
    })

    it('worklet module: captures share one queue that the transport posts in render order', async () => {
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      await openLoopback(ctx)
      emitTrack(ctx, makeTrack('m'))
      await flush(); await flush()
      const registered = {}
      class FakeProcessor {
        constructor () { this.port = { onmessage: null, posted: [], postMessage (m) { this.posted.push(m) } } }
      }
      new Function('AudioWorkletProcessor', 'registerProcessor', ctx.blobs[ctx.blobs.length - 1])(
        FakeProcessor, (name, cls) => { registered[name] = cls })
      const a = new registered['pcm-capture']({ processorOptions: { trackIndex: 0 } })
      const b = new registered['pcm-capture']({ processorOptions: { trackIndex: 1 } })
      const transport = new registered['pcm-transport']()
      const quantum = (v) => [[Float32Array.from([v, v])]]
      assert.strictEqual(a.process(quantum(0.25)), true)
      b.process(quantum(0.5))
      a.process(quantum(0.75))
      b.process([[]]) // no channel (no input connected): nothing queued
      transport.process()
      const posted = transport.port.posted
      assert.strictEqual(posted.length, 1)
      assert.deepStrictEqual(posted[0].filter((x, i) => i % 2 === 0), [0, 1, 0])
      assert.deepStrictEqual(posted[0].filter((x, i) => i % 2 === 1).map((q) => q[0]), [0.25, 0.5, 0.75])
      transport.process()
      assert.strictEqual(posted.length, 1, 'nothing posted for an empty queue')
      a.port.onmessage({ data: 'stop' })
      assert.strictEqual(a.process(quantum(1)), false, 'a stopped capture processor ends')
      transport.process()
      assert.strictEqual(posted.length, 1, 'and queues nothing more')
    })
  })

  describe('setupTrackCapture()/handleNewTrack() (behavioral)', () => {
    it('AudioWorklet path: worklet message sends a resampled PCM binary frame', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t-audio'))
      await flush(); await flush()
      assert.strictEqual(ctx.audio.workletNodes.length, 1, 'a worklet node was created')
      const node = ctx.audio.workletNodes[0]
      assert.strictEqual(node.name, 'pcm-capture')
      assert.deepStrictEqual(node.options.processorOptions, { trackIndex: 0 }, 'the processor tags its quanta with the track index')
      // Feed 6 samples @48k -> 2 samples @16k -> 4 bytes PCM + 4 byte header.
      feed(ctx, 0, Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]))
      const bins = binaryFrames(ws)
      assert.strictEqual(bins.length, 1)
      assert.strictEqual(bins[0].byteLength, 4 + 2 * 2, 'header(4) + 2 int16 samples')
    })

    it('resamples to 16kHz: 48kHz worklet input collapses 3:1 in the PCM frame', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t1'))
      await flush(); await flush()
      feed(ctx, 0, new Float32Array(48)) // 48 @48k -> 16 @16k
      const bins = binaryFrames(ws)
      assert.strictEqual(bins[0].byteLength, 4 + 16 * 2)
    })

    it('ScriptProcessor fallback path resamples and sends PCM when AudioWorklet fails', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000, workletThrows: true } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t1'))
      await flush(); await flush()
      assert.strictEqual(ctx.audio.workletNodes.length, 0, 'no worklet node on fallback')
      assert.strictEqual(ctx.audio.scriptProcessors.length, 1, 'fell back to ScriptProcessor')
      assert.ok(ctx.warnings.some((w) => w.includes('AudioWorklet unavailable')), 'fallback warned')
      const proc = ctx.audio.scriptProcessors[0]
      proc.onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) } })
      const bins = binaryFrames(ws)
      assert.strictEqual(bins.length, 1)
      assert.strictEqual(bins[0].byteLength, 4 + 2 * 2)
    })

    it('handles AudioContext construction failure gracefully (no throw, no capture)', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const audio = makeAudioEnv({ ctorThrows: true })
      const ctx = runScript(s, { audio })
      const ws = await openLoopback(ctx)
      assert.doesNotThrow(() => emitTrack(ctx, makeTrack('t1')))
      await flush(); await flush()
      // trackAdded JSON still announced, but no capture node and no crash.
      assert.ok(jsonFrames(ws).some((f) => f.type === 'trackAdded'))
      assert.strictEqual(ctx.audio.workletNodes.length, 0)
      assert.strictEqual(binaryFrames(ws).length, 0)
      assert.ok(ctx.warnings.some((w) => w.includes('capture setup failed for track 0: AudioContext boom')), ctx.warnings.join(' | '))
    })

    // Capture setup failures used to be logged in DEBUG only: a track lost to the
    // transcript left no trace in production logs.
    it('a track whose capture cannot be set up is reported, released, and does not affect the others', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000, state: 'running', failSources: 1 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('broken'))
      await flush(); await flush()
      emitTrack(ctx, makeTrack('fine'))
      await flush(); await flush(); await flush()
      assert.ok(ctx.warnings.some((w) => w.includes('capture setup failed for track 0: source boom')), ctx.warnings.join(' | '))
      assert.strictEqual(ctx.sinks[0].srcObject, null, "the failed track's sink is released")
      assert.deepStrictEqual(ctx.audio.workletNodes.map((n) => n.options.processorOptions.trackIndex), [1])
      feed(ctx, 0, new Float32Array(4), 1, new Float32Array(4))
      assert.deepStrictEqual(binaryFrames(ws).map((f) => new DataView(f).getUint16(0, false)), [1], 'track 1 streams')
    })

    it('reports capture failures at most once per 10 s, counting the ones in between', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000, state: 'running', failSources: 4 } })
      await openLoopback(ctx)
      const fail = async (id) => { emitTrack(ctx, makeTrack(id)); await flush(); await flush() }
      await fail('a'); await fail('b'); await fail('c')
      assert.strictEqual(ctx.warnings.filter((w) => w.includes('capture setup failed')).length, 1)
      ctx.clock.advance(10000)
      await fail('d')
      const reports = ctx.warnings.filter((w) => w.includes('capture setup failed'))
      assert.strictEqual(reports.length, 2)
      assert.ok(reports[1].includes('track 3') && reports[1].includes('(and 2 other failure(s) since the last report)'), reports[1])
    })

    it('a quantum that fails to convert only costs its own track', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('a'))
      emitTrack(ctx, makeTrack('b'))
      await flush(); await flush(); await flush()
      feed(ctx, 0, null, 1, new Float32Array(4)) // track 0's quantum is broken
      assert.deepStrictEqual(binaryFrames(ws).map((f) => new DataView(f).getUint16(0, false)), [1])
      assert.ok(ctx.warnings.some((w) => w.includes('capture of track 0 failed')))
    })

    it('handleNewTrack ignores null/undefined and non-audio tracks without crashing', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      const ws = await openLoopback(ctx)
      const PC = ctx.fakeWindow.RTCPeerConnection
      const pc = new PC({}, {})
      assert.doesNotThrow(() => pc._trackHandler({ track: null }))
      assert.doesNotThrow(() => pc._trackHandler({ track: undefined }))
      assert.doesNotThrow(() => pc._trackHandler({ track: makeTrack('v1', 'video') }))
      await flush()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').length, 0)
    })

    it('does not process the same track twice (processedTracks dedup)', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      const ws = await openLoopback(ctx)
      const track = makeTrack('dup')
      emitTrack(ctx, track)
      emitTrack(ctx, track)
      await flush(); await flush()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').length, 1)
      assert.strictEqual(ctx.audio.workletNodes.length, 1)
    })

    it('track ended fires trackRemoved and clears track maps in order', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      const ws = await openLoopback(ctx)
      const track = makeTrack('end-me')
      emitTrack(ctx, track)
      await flush(); await flush()
      track.fire('ended')
      const removed = jsonFrames(ws).filter((f) => f.type === 'trackRemoved')
      assert.strictEqual(removed.length, 1)
      assert.strictEqual(removed[0].trackId, 'end-me')
      assert.strictEqual(removed[0].trackIndex, 0)
      // After removal the same track id can be re-added (proves maps were cleared).
      emitTrack(ctx, track)
      await flush()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').length, 2)
    })
  })

  // An ended track keeps feeding its source node in Chromium (silence, at the full
  // rate): a live Teams call streamed 170 s of zeros for a replaced track. The
  // capture graph must be dismantled so the track's PCM stops.
  describe('ended track teardown (behavioral)', () => {
    async function capturedTrack (audioOpts) {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts })
      const ws = await openLoopback(ctx)
      const track = makeTrack('t-end')
      emitTrack(ctx, track)
      await flush(); await flush()
      return { ctx, ws, track }
    }

    it('AudioWorklet path: stops the processor, disconnects node and source, releases the sink', async () => {
      const { ctx, ws, track } = await capturedTrack({ sampleRate: 16000 })
      const node = ctx.audio.workletNodes[0]
      feed(ctx, 0, new Float32Array(8))
      assert.strictEqual(binaryFrames(ws).length, 1, 'captured while live')
      track.fire('ended')
      feed(ctx, 0, new Float32Array(8)) // a quantum still in flight from the worklet
      assert.strictEqual(binaryFrames(ws).length, 1, 'in-flight quanta of an ended track are dropped')
      assert.deepStrictEqual(node.port.posted, ['stop'], 'the processor stops queueing quanta')
      assert.strictEqual(node.disconnected, true)
      assert.strictEqual(ctx.audio.sources[0].disconnected, true)
      assert.strictEqual(ctx.sinks[0].paused, true)
      assert.strictEqual(ctx.sinks[0].srcObject, null)
      const removedAt = ws.sent.findIndex((f) => typeof f === 'string' && JSON.parse(f).type === 'trackRemoved')
      assert.strictEqual(removedAt, ws.sent.length - 1, 'trackRemoved is the last frame of the track')
    })

    it('ScriptProcessor path: drops onaudioprocess and disconnects', async () => {
      const { ctx, track } = await capturedTrack({ sampleRate: 16000, workletThrows: true })
      const proc = ctx.audio.scriptProcessors[0]
      assert.strictEqual(typeof proc.onaudioprocess, 'function')
      track.fire('ended')
      assert.strictEqual(proc.onaudioprocess, null)
      assert.strictEqual(proc.disconnected, true)
      assert.strictEqual(ctx.audio.sources[0].disconnected, true)
      assert.strictEqual(ctx.sinks[0].srcObject, null)
    })

    it('builds nothing for a track that ends while the AudioContext resumes', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s) // context starts suspended: setup awaits resume()
      await openLoopback(ctx)
      const track = makeTrack('t-early-end')
      emitTrack(ctx, track)
      track.fire('ended') // before resume() settles
      await flush(); await flush()
      assert.strictEqual(ctx.audio.sources.length, 0, 'no source node')
      assert.strictEqual(ctx.sinks.length, 0, 'no sink element')
      assert.strictEqual(ctx.audio.workletNodes.length, 0, 'no capture node')
    })

    it('tears down what was built when the track ends while the worklet module loads', async () => {
      let loaded
      const addModule = () => new Promise((resolve) => { loaded = resolve })
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { addModule } })
      const ws = await openLoopback(ctx)
      const track = makeTrack('t-mid-end')
      emitTrack(ctx, track)
      await flush(); await flush() // resumed, source + sink built, module load pending
      assert.strictEqual(ctx.audio.sources.length, 1)
      track.fire('ended')
      loaded()
      await flush(); await flush()
      assert.strictEqual(ctx.audio.workletNodes.length, 0, 'no capture node for an ended track')
      assert.strictEqual(ctx.audio.scriptProcessors.length, 0, 'no fallback either')
      assert.strictEqual(ctx.audio.sources[0].disconnected, true)
      assert.strictEqual(ctx.sinks[0].srcObject, null)
      assert.strictEqual(binaryFrames(ws).length, 0)
    })

    it('ignores a track that is already ended when it is announced', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      const ws = await openLoopback(ctx)
      const track = makeTrack('t-dead')
      track.readyState = 'ended'
      emitTrack(ctx, track)
      await flush(); await flush()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').length, 0)
      assert.strictEqual(ctx.audio.sources.length, 0)
    })

    it('does not replay the participant mapping of an ended track after a reconnect', async () => {
      const room = { state: 'connected', localParticipant: {}, remoteParticipants: [{ identity: 'id1', name: 'Alice', trackPublications: { forEach (cb) { [{ kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: { id: 't-map' } } }].forEach(cb) } } }] }
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [{ __reactFiber$x: { memoizedProps: { room }, memoizedState: null, return: null } }] })
      const ws = await openLoopback(ctx)
      const track = makeTrack('t-map')
      emitTrack(ctx, track)
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantMapping').length, 1)
      track.fire('ended')
      ws.readyState = 3; ws.onclose() // loopback drops
      ctx.clock.advance(1000); await flush()
      const ws2 = ctx.FakeWebSocket.instances[ctx.FakeWebSocket.instances.length - 1]
      assert.notStrictEqual(ws2, ws)
      ws2._open(); await flush()
      assert.strictEqual(jsonFrames(ws2).filter((f) => f.type === 'participantMapping').length, 0)
    })
  })

  // addInitScript runs the script in every frame of the page: a live Teams join
  // opened 8 loopback sockets on one path within 3 s.
  describe('frames (behavioral)', () => {
    const lkRoom = (trackId) => ({
      state: 'connected',
      localParticipant: {},
      remoteParticipants: [{ identity: 'id1', name: 'Alice', trackPublications: { forEach (cb) { [{ kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: { id: trackId } } }].forEach(cb) } } }]
    })
    const fiber = (room) => [{ __reactFiber$x: { memoizedProps: { room }, memoizedState: null, return: null } }]

    it('the top frame connects at once', () => {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'teams' }))
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 1)
    })

    it('a sub-frame opens no socket until it captures a track, then announces it on open', async () => {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'sfu' }), { subFrame: true })
      await flush()
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 0, 'no socket for a frame without media')
      emitTrack(ctx, makeTrack('sub-t'))
      emitTrack(ctx, makeTrack('sub-t2'))
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 1, 'one socket once it captures')
      const ws = await openLoopback(ctx)
      assert.deepStrictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').map((f) => [f.trackId, f.trackIndex]),
        [['sub-t', 0], ['sub-t2', 1]], 'the tracks added before the socket opened are announced')
    })

    it('a sub-frame runs no Teams poller: no participantLeft, no degrade', async () => {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'teams' }), { subFrame: true, callingDebug: undefined })
      emitTrack(ctx, makeTrack('sub-t'))
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      assert.strictEqual(ctx.clock.intervals.size, 0, 'no poller started')
      for (let i = 0; i < 40; i++) { ctx.clock.tickIntervals(); ctx.clock.advance(200) }
      assert.deepStrictEqual(jsonFrames(ws).map((f) => f.type), ['trackAdded'])
    })

    it('a sub-frame runs no SFU poller', async () => {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'sfu' }), { subFrame: true, elements: fiber(lkRoom('sub-t')) })
      emitTrack(ctx, makeTrack('sub-t'))
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      assert.strictEqual(ctx.clock.intervals.size, 0, 'no poller started')
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantMapping').length, 0)
    })

    it('every (re)connect announces the live tracks and their mappings, not the ended ones', async () => {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'sfu' }), { elements: fiber(lkRoom('t-live')) })
      await flush()
      emitTrack(ctx, makeTrack('t-live')) // before the first open: not sent yet
      const ended = makeTrack('t-ended')
      emitTrack(ctx, ended)
      const ws1 = await openLoopback(ctx)
      assert.deepStrictEqual(jsonFrames(ws1).map((f) => [f.type, f.trackIndex]), [['trackAdded', 0], ['trackAdded', 1]])
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals() // maps t-live
      ended.fire('ended')
      ws1.readyState = 3; ws1.onclose() // the Node side restarts
      ctx.clock.advance(1000); await flush()
      const ws2 = await openLoopback(ctx)
      assert.notStrictEqual(ws2, ws1)
      assert.deepStrictEqual(jsonFrames(ws2).map((f) => [f.type, f.trackIndex]), [['trackAdded', 0], ['participantMapping', 0]])
      assert.strictEqual(jsonFrames(ws2)[1].participant.name, 'Alice')
    })
  })

  describe('RTCPeerConnection patching (behavioral)', () => {
    it('patches both RTCPeerConnection and webkitRTCPeerConnection when present', () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { withWebkitRTC: true })
      assert.strictEqual(ctx.fakeWindow.RTCPeerConnection, ctx.fakeWindow.webkitRTCPeerConnection)
      assert.notStrictEqual(ctx.fakeWindow.RTCPeerConnection, ctx.OriginalRTCPeerConnection)
    })

    it('PatchedRTCPeerConnection forwards constructor args to the original', () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      const cfg = { iceServers: ['stun'] }
      const con = { optional: [] }
      const pc = new ctx.fakeWindow.RTCPeerConnection(cfg, con)
      assert.strictEqual(pc.config, cfg)
      assert.strictEqual(pc.constraints, con)
      assert.strictEqual(ctx.pcInstances.length, 1)
    })

    it('generateCertificate is callable on the patched constructor when the original has it', () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { withGenerateCertificate: true })
      assert.strictEqual(typeof ctx.fakeWindow.RTCPeerConnection.generateCertificate, 'function')
      assert.doesNotThrow(() => ctx.fakeWindow.RTCPeerConnection.generateCertificate())
    })
  })

  describe('mapTrack() (behavioral via SFU LiveKit)', () => {
    function livekitElements (room) {
      const el = { __reactFiber$x: { memoizedProps: { room }, memoizedState: null, return: null } }
      return [el]
    }
    function makeLivekitRoom (parts) {
      return { state: 'connected', remoteParticipants: parts, localParticipant: {} }
    }
    function audioPub (trackId, subscribed) {
      return { kind: 'audio', isSubscribed: !!subscribed, setSubscribed () { this.isSubscribed = true; this._forced = true }, track: { mediaStreamTrack: { id: trackId } } }
    }
    function participant (identity, name, pubs) {
      return { identity, name, trackPublications: { forEach (cb) { pubs.forEach(cb) } } }
    }

    it('maps a track once; the second poll for the same track is a no-op', async () => {
      const pub = audioPub('lk-track', true)
      const p = participant('id1', 'Alice', [pub])
      const room = makeLivekitRoom([p])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: livekitElements(room) })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk-track'))
      await flush(); await flush()
      ctx.clock.advance(3000) // start the pollers
      ctx.clock.tickIntervals() // pollJitsi (no APP) + pollLivekit -> maps
      ctx.clock.tickIntervals() // second round -> already mapped, no-op
      const maps = jsonFrames(ws).filter((f) => f.type === 'participantMapping')
      assert.strictEqual(maps.length, 1, 'mapped exactly once')
    })

    it('sentMappings carries the exact sanitized participant object', async () => {
      const pub = audioPub('lk-track', true)
      const dirty = 'Al' + String.fromCharCode(27) + String.fromCharCode(10) + 'ice'
      const p = participant('idX', dirty, [pub])
      const room = makeLivekitRoom([p])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: livekitElements(room) })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk-track'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      const map = jsonFrames(ws).find((f) => f.type === 'participantMapping')
      assert.ok(map, 'mapping emitted')
      assert.strictEqual(map.participant.id, 'idX')
      assert.strictEqual(map.participant.name, 'Al  ice', 'control chars replaced by spaces')
    })
  })

  describe('WebSocket reconnect / frame construction (behavioral)', () => {
    it('retries exactly 10 times at 1000ms then warns and disposes', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      await flush()
      // Fail every connection attempt; each onclose schedules the next retry.
      for (let attempt = 0; attempt < 10; attempt++) {
        const inst = ctx.FakeWebSocket.instances[ctx.FakeWebSocket.instances.length - 1]
        inst._fail()
        await flush()
        ctx.clock.advance(1000) // fire the reconnect timer -> new WebSocket
        await flush()
      }
      // 1 initial + 10 retries = 11 instances created.
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 11)
      // The 11th attempt fails: reconnectAttempts already at max -> give up + warn.
      const last = ctx.FakeWebSocket.instances[10]
      last._fail()
      await flush()
      assert.ok(ctx.warnings.some((w) => w.includes('gave up after 10 retries')))
      // disposed now true: a further close schedules NO new socket.
      const before = ctx.FakeWebSocket.instances.length
      ctx.clock.advance(5000)
      await flush()
      assert.strictEqual(ctx.FakeWebSocket.instances.length, before, 'no reconnection after dispose')
    })

    it('a non-disposed onclose reconnects (control for the disposed case)', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, {})
      await flush()
      const inst = ctx.FakeWebSocket.instances[0]
      inst._open(); await flush()
      inst.readyState = 3; inst.onclose() // server-side close, disposed still false
      await flush()
      ctx.clock.advance(1000); await flush()
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 2, 'a non-disposed close reconnects')
    })

    it('beforeunload sets disposed so a subsequent onclose schedules no reconnect', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, {})
      await flush()
      const inst = ctx.FakeWebSocket.instances[0]
      inst._open(); await flush()
      ctx.fireWindow('beforeunload') // disposed = true, intervals/timer cleared
      inst.readyState = 3; inst.onclose()
      await flush()
      ctx.clock.advance(2000); await flush()
      assert.strictEqual(ctx.FakeWebSocket.instances.length, 1, 'no reconnect after beforeunload dispose')
    })

    it('binary frame header bytes are assembled big-endian (trackIndex, reserved)', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('hdr'))
      await flush(); await flush()
      feed(ctx, 0, Float32Array.from([1.0, -1.0])) // 16k -> no resample
      const bin = binaryFrames(ws)[0]
      const view = new DataView(bin)
      assert.strictEqual(view.getUint16(0, false), 0, 'trackIndex 0 big-endian')
      assert.strictEqual(view.getUint16(2, false), 0, 'reserved 0')
      assert.strictEqual(view.getInt16(4, true), 32767, 'first PCM sample = +full scale')
      assert.strictEqual(view.getInt16(6, true), -32768, 'second PCM sample = -full scale')
      assert.strictEqual(bin.byteLength, 4 + 2 * 2)
    })

    it('binary frame carries the full 4-byte header + all PCM for length > 4', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('big'))
      await flush(); await flush()
      feed(ctx, 0, new Float32Array(10)) // 10 samples
      const bin = binaryFrames(ws)[0]
      assert.strictEqual(bin.byteLength, 4 + 10 * 2)
    })

    it('sends no frame for a chunk that yields no PCM', async () => {
      // An empty chunk, or one too short to complete a resampled sample, would
      // only produce a header-only frame, which the Node side drops anyway.
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('empty'))
      await flush(); await flush()
      feed(ctx, 0, new Float32Array(0))
      assert.strictEqual(binaryFrames(ws).length, 0)
    })

    it('sendBinary is a no-op while the loopback WS is not OPEN', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      // Do NOT open the loopback ws.
      await flush()
      emitTrack(ctx, makeTrack('closed'))
      await flush(); await flush()
      feed(ctx, 0, Float32Array.from([0.5]))
      assert.strictEqual(binaryFrames(ctx.FakeWebSocket.instances[0]).length, 0)
    })
  })

  describe('SFU pollJitsi (behavioral)', () => {
    function jitsiAPP (participants) {
      return { conference: { _room: { getParticipants: () => participants } } }
    }
    function jitsiTrack (type, id) {
      return { getType: () => type, track: { id } }
    }
    function jitsiParticipant (id, name, tracks) {
      return { getId: () => id, getDisplayName: () => name, getTracks: () => tracks }
    }

    it('maps only audio tracks, never video/screen-share', async () => {
      const p = jitsiParticipant('p1', 'Alice', [jitsiTrack('video', 'v'), jitsiTrack('audio', 'a-track'), jitsiTrack('desktop', 'd')])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { APP: jitsiAPP([p]) })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('a-track'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      const maps = jsonFrames(ws).filter((f) => f.type === 'participantMapping')
      assert.strictEqual(maps.length, 1)
      assert.strictEqual(maps[0].participant.id, 'p1')
    })

    it('maps multiple audio tracks from one participant to distinct track indices', async () => {
      const p = jitsiParticipant('p1', 'Alice', [jitsiTrack('audio', 'a1'), jitsiTrack('audio', 'a2')])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { APP: jitsiAPP([p]) })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('a1'))
      emitTrack(ctx, makeTrack('a2'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      const maps = jsonFrames(ws).filter((f) => f.type === 'participantMapping')
      assert.strictEqual(maps.length, 2)
      const indices = maps.map((m) => m.trackIndex).sort()
      assert.deepStrictEqual(indices, [0, 1])
    })

    it('an exception inside window.APP.conference does not propagate', async () => {
      const APP = { conference: { get _room () { throw new Error('jitsi boom') } } }
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { APP })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('x'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      assert.doesNotThrow(() => ctx.clock.tickIntervals())
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantMapping').length, 0)
    })
  })

  describe('SFU findLivekitRoom / pollLivekit (behavioral)', () => {
    function fiberChainEl (room, depth) {
      // Build a return-chain `depth` levels deep; the Room sits at the deepest level.
      let f = { memoizedProps: { theRoom: room }, memoizedState: null, return: null }
      for (let i = 0; i < depth; i++) f = { memoizedProps: null, memoizedState: null, return: f }
      return { __reactFiber$abc: f }
    }
    function lkRoom (parts, state) {
      return { state: state || 'connected', localParticipant: {}, remoteParticipants: parts }
    }
    function lkPart (identity, name, pubs) {
      return { identity, name, trackPublications: { forEach (cb) { pubs.forEach(cb) } } }
    }
    function lkPub (id, subscribed, settable) {
      const pub = { kind: 'audio', isSubscribed: !!subscribed, track: { mediaStreamTrack: { id } } }
      if (settable) pub.setSubscribed = function () { this.isSubscribed = true; pub._forced = true }
      else pub.setSubscribed = 'not-a-fn'
      return pub
    }

    it('finds a Room nested deeply in the fiber return chain', async () => {
      const pub = lkPub('lk1', true, true)
      const room = lkRoom([lkPart('id1', 'Bob', [pub])])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [fiberChainEl(room, 40)] })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk1'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      const maps = jsonFrames(ws).filter((f) => f.type === 'participantMapping')
      assert.strictEqual(maps.length, 1)
      assert.strictEqual(maps[0].participant.name, 'Bob')
    })

    it('handles elements with no __reactFiber key gracefully', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [{ id: 'plain' }, { class: 'x' }] })
      await openLoopback(ctx)
      ctx.clock.advance(3000)
      assert.doesNotThrow(() => ctx.clock.tickIntervals())
    })

    it('stops traversal at the 60-level depth limit (Room below limit is not found)', async () => {
      const pub = lkPub('deep', true, true)
      const room = lkRoom([lkPart('id', 'Deep', [pub])])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      // Room sits 80 levels deep -> beyond the 60 cap -> never found.
      const ctx = runScript(s, { elements: [fiberChainEl(room, 80)] })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('deep'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantMapping').length, 0)
    })

    it('forces subscription when isSubscribed=false and setSubscribed is callable', async () => {
      const pub = lkPub('lk-unsub', false, true)
      const room = lkRoom([lkPart('id1', 'Carol', [pub])])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [fiberChainEl(room, 2)] })
      await openLoopback(ctx)
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      assert.strictEqual(pub.isSubscribed, true)
      assert.strictEqual(pub._forced, true)
    })

    it('does not call setSubscribed when it is not a function', async () => {
      const pub = lkPub('lk-bad', false, false) // setSubscribed is a string
      const room = lkRoom([lkPart('id1', 'Dave', [pub])])
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [fiberChainEl(room, 2)] })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk-bad'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      assert.doesNotThrow(() => ctx.clock.tickIntervals())
      assert.strictEqual(pub.isSubscribed, false, 'left unsubscribed (no callable setter)')
      // track still mapped from pub.track.mediaStreamTrack
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantMapping').length, 1)
    })

    it('emits participantLeft when a remote disappears from the room roster', async () => {
      // LiveKit gives no reliable leave signal (transceiver reuse fires 'mute',
      // not 'ended'); the poller must diff the roster and announce the departure
      // so the empty-meeting auto-leave can fire.
      const pub = lkPub('lk-leave', true, true)
      const roster = [lkPart('idAlice', 'Alice', [pub])]
      const room = lkRoom(roster)
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [fiberChainEl(room, 2)] })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk-leave'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals() // poll 1: Alice present -> mapped, recorded in roster
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantLeft').length, 0, 'no leave while present')
      roster.length = 0 // Alice leaves the meeting
      ctx.clock.advance(1500); ctx.clock.tickIntervals() // poll 2 (normal cadence): roster diff -> Alice is gone
      const left = jsonFrames(ws).filter((f) => f.type === 'participantLeft')
      assert.strictEqual(left.length, 1, 'exactly one participantLeft')
      assert.strictEqual(left[0].participant.id, 'idAlice')
      assert.strictEqual(left[0].participant.name, 'Alice')
      ctx.clock.advance(1500); ctx.clock.tickIntervals() // poll 3: already removed -> not re-emitted
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'participantLeft').length, 1, 'leave emitted once')
    })

    it('emits participantLeft only for the remote that left, not the one still present', async () => {
      const pubA = lkPub('lk-A', true, true)
      const pubB = lkPub('lk-B', true, true)
      const roster = [lkPart('idA', 'Alice', [pubA]), lkPart('idB', 'Bob', [pubB])]
      const room = lkRoom(roster)
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { elements: [fiberChainEl(room, 2)] })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('lk-A'))
      emitTrack(ctx, makeTrack('lk-B'))
      await flush(); await flush()
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals() // both present
      roster.splice(0, 1) // Alice leaves, Bob stays
      ctx.clock.advance(1500); ctx.clock.tickIntervals()
      const left = jsonFrames(ws).filter((f) => f.type === 'participantLeft')
      assert.strictEqual(left.length, 1)
      assert.strictEqual(left[0].participant.id, 'idA')
    })
  })

  // The pollers used to start 3 s after the page and then poll every 1.5-2 s:
  // a track was mapped up to ~4.5 s after the join, or 1.5 s after it started
  // streaming, and its words meanwhile were attributed to nobody (or to the
  // previous speaker).
  // An SFU recycles its subscriber receivers: when a participant leaves, the
  // receiver (and its MediaStreamTrack) is reused for the next subscription, and
  // Chromium fires 'track' again with the same track (measured: no 'ended', only
  // 'mute' while unused). A track mapped once was never mapped again, so a
  // participant coming back was never joined again (the empty-meeting timer
  // ended the session while they spoke), and a reconnect replayed the mapping of
  // somebody gone.
  describe('reused receivers (behavioral)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    const lkPart = (identity, name, trackId) => ({
      identity, name, trackPublications: { forEach (cb) { cb({ kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: { id: trackId } } }) } }
    })
    // A LiveKit Room whose roster the test changes.
    function room (parts) {
      const r = { state: 'connected', localParticipant: {}, remoteParticipants: parts }
      return { r, elements: [{ __reactFiber$x: { memoizedProps: { room: r }, memoizedState: null, return: null } }] }
    }
    const poll = (ctx) => { ctx.clock.advance(1500); ctx.clock.tickIntervals() }
    const sent = (ws) => jsonFrames(ws).filter((f) => f.type !== 'trackAdded').map((f) => f.type + ':' + f.participant.id)

    it('a participant who left and comes back on the same receiver is mapped again', async () => {
      const lk = room([lkPart('bob', 'Bob', 'rx')])
      const ctx = runScript(s, { elements: lk.elements })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('rx'))
      await flush(); await flush()
      poll(ctx)
      lk.r.remoteParticipants = [] // Bob leaves: the receiver is only muted
      poll(ctx)
      lk.r.remoteParticipants = [lkPart('bob', 'Bob', 'rx')] // back, on the same receiver
      poll(ctx)
      assert.deepStrictEqual(sent(ws), ['participantMapping:bob', 'participantLeft:bob', 'participantMapping:bob'])
    })

    it('the receiver taken over by somebody else is mapped to them', async () => {
      const lk = room([lkPart('bob', 'Bob', 'rx')])
      const ctx = runScript(s, { elements: lk.elements })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('rx'))
      await flush(); await flush()
      poll(ctx)
      lk.r.remoteParticipants = [lkPart('carol', 'Carol', 'rx')] // within one poll
      poll(ctx)
      assert.deepStrictEqual(sent(ws), ['participantMapping:bob', 'participantMapping:carol', 'participantLeft:bob'])
    })

    it("a re-fired 'track' is not captured twice, and its participant is found again at the next fast poll", async () => {
      const lk = room([lkPart('bob', 'Bob', 'rx')])
      const ctx = runScript(s, { elements: lk.elements, audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      const track = makeTrack('rx')
      emitTrack(ctx, track)
      await flush(); await flush()
      poll(ctx)
      emitTrack(ctx, track) // the SFU reused the receiver
      await flush(); await flush()
      ctx.clock.advance(250); ctx.clock.tickIntervals()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'trackAdded').length, 1)
      assert.strictEqual(ctx.audio.workletNodes.length, 1, 'one capture')
      assert.deepStrictEqual(sent(ws), ['participantMapping:bob', 'participantMapping:bob'])
    })

    it('a reconnect does not re-announce the mapping of a participant who left', async () => {
      const lk = room([lkPart('bob', 'Bob', 'rx')])
      const ctx = runScript(s, { elements: lk.elements })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('rx'))
      await flush(); await flush()
      poll(ctx)
      lk.r.remoteParticipants = []
      poll(ctx)
      ws.readyState = 3; ws.onclose()
      ctx.clock.advance(1000); await flush()
      const ws2 = await openLoopback(ctx)
      assert.deepStrictEqual(jsonFrames(ws2).map((f) => f.type), ['trackAdded'])
    })

    it('Jitsi: a receiver reused for another participant is mapped again, even with every track mapped', async () => {
      const jt = (id) => ({ getType: () => 'audio', track: { id } })
      let parts = [{ getId: () => 'p1', getDisplayName: () => 'Alice', getTracks: () => [jt('rx')] }]
      const APP = { conference: { _room: { getParticipants: () => parts } } }
      const ctx = runScript(s, { APP })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('rx'))
      await flush(); await flush()
      poll(ctx)
      parts = [{ getId: () => 'p2', getDisplayName: () => 'Bob', getTracks: () => [jt('rx')] }]
      poll(ctx)
      assert.deepStrictEqual(sent(ws), ['participantMapping:p1', 'participantMapping:p2'])
    })
  })

  describe('SFU polling cadence (behavioral)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    // Let `ms` of time pass, the 250 ms poller interval firing on its schedule.
    function runFor (ctx, ms) {
      for (let t = 0; t < ms; t += 250) { ctx.clock.advance(250); ctx.clock.tickIntervals() }
    }
    // A LiveKit Room reachable through a React fiber (once rendered), counting the
    // DOM walks and the polls of its participant. Pass { elements, onQuerySelectorAll }
    // to runScript.
    function lkSetup (opts = {}) {
      const stats = { walks: 0, polls: 0 }
      const pubs = []
      let rendered = !opts.hidden
      const bob = { identity: 'idBob', name: 'Bob', trackPublications: { forEach (f) { stats.polls++; pubs.forEach(f) } } }
      const room = { state: opts.state || 'connected', localParticipant: {}, remoteParticipants: [bob] }
      const el = { __reactFiber$x: { memoizedProps: { room }, memoizedState: null, return: null } }
      return {
        stats,
        room,
        pubs,
        render: () => { rendered = true },
        page: { elements: () => (rendered ? [el] : []), onQuerySelectorAll: () => { stats.walks++ } }
      }
    }
    const subscribed = (id) => ({ kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: { id } } })

    it('starts at once, as a single interval', () => {
      const ctx = runScript(s)
      assert.deepStrictEqual([...ctx.clock.intervals.values()].map((i) => i.every), [250])
    })

    it('a track is mapped at the first poll after it starts streaming (within 250 ms)', async () => {
      const lk = lkSetup()
      const ctx = runScript(s, lk.page)
      const ws = await openLoopback(ctx)
      runFor(ctx, 500) // the page joins, the Room is found
      lk.pubs.push(subscribed('bob-t'))
      emitTrack(ctx, makeTrack('bob-t'))
      await flush(); await flush()
      runFor(ctx, 250)
      const maps = jsonFrames(ws).filter((f) => f.type === 'participantMapping')
      assert.deepStrictEqual(maps.map((m) => m.participant.name), ['Bob'])
    })

    it('polls fast only while a track waits for its participant, at the normal cadence otherwise', async () => {
      const lk = lkSetup()
      const ctx = runScript(s, lk.page)
      await openLoopback(ctx)
      runFor(ctx, 3000)
      assert.strictEqual(lk.stats.polls, 2, 'nothing to map: every 1.5 s')
      emitTrack(ctx, makeTrack('stray-t')) // a track no participant publishes (yet)
      lk.stats.polls = 0
      runFor(ctx, 3000)
      assert.strictEqual(lk.stats.polls, 12, 'a track waits: every 250 ms')
      lk.pubs.push(subscribed('stray-t'))
      runFor(ctx, 250) // mapped
      lk.stats.polls = 0
      runFor(ctx, 3000)
      assert.strictEqual(lk.stats.polls, 2, 'back to every 1.5 s')
    })

    it('walks the DOM for the Room at most every 1.5 s, and never again once found', async () => {
      const lk = lkSetup({ hidden: true }) // the meeting client has not rendered it yet
      const ctx = runScript(s, lk.page)
      await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t')) // fast polling...
      runFor(ctx, 3000)
      assert.strictEqual(lk.stats.walks, 2, '...but not a walk per poll: 2 in 3 s')
      lk.render()
      runFor(ctx, 1500)
      assert.strictEqual(lk.stats.walks, 3, 'found at the next search')
      runFor(ctx, 30000)
      assert.strictEqual(lk.stats.walks, 3, 'and never walked again')
    })

    it('keeps a found Room, connecting or connected, without walking the DOM again', async () => {
      const lk = lkSetup({ state: 'connecting' })
      const ctx = runScript(s, lk.page)
      await openLoopback(ctx)
      emitTrack(ctx, makeTrack('bob-t'))
      runFor(ctx, 250)
      assert.strictEqual(lk.stats.walks, 1)
      runFor(ctx, 3000) // still connecting
      lk.room.state = 'connected'
      lk.pubs.push(subscribed('bob-t'))
      runFor(ctx, 30000)
      assert.strictEqual(lk.stats.walks, 1, 'one walk in 33 s')
    })

    it('searches again (at most every 1.5 s) when the Room is disconnected: left, or replaced', async () => {
      const lk = lkSetup()
      const ctx = runScript(s, lk.page)
      await openLoopback(ctx)
      runFor(ctx, 250)
      assert.strictEqual(lk.stats.walks, 1)
      lk.room.state = 'disconnected'
      emitTrack(ctx, makeTrack('t'))
      runFor(ctx, 3000)
      assert.strictEqual(lk.stats.walks, 3)
    })

    it('warns that no Room was found after 20 searches (~30 s), not after 20 fast polls', async () => {
      const lk = lkSetup({ hidden: true })
      const ctx = runScript(s, lk.page)
      await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t'))
      runFor(ctx, 15000)
      assert.strictEqual(ctx.warnings.filter((w) => w.includes('never found')).length, 0)
      runFor(ctx, 15000)
      assert.strictEqual(ctx.warnings.filter((w) => w.includes('never found after 20 searches')).length, 1)
    })

    it('all interval ids are stored so beforeunload can clear them', () => {
      const ctx = runScript(s)
      assert.strictEqual(ctx.clock.intervals.size, 1)
      ctx.fireWindow('beforeunload')
      assert.strictEqual(ctx.clock.intervals.size, 0)
    })
  })

  describe('Teams getUserMedia/enumerateDevices shim gating (behavioral)', () => {
    it('does NOT override getUserMedia/enumerateDevices for teams', () => {
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const origGUM = function teamsGUM () {}
      const origEnum = function teamsEnum () {}
      const ctx = runScript(s, { origGUM, origEnum })
      assert.strictEqual(ctx.fakeNavigator.mediaDevices.getUserMedia, origGUM, 'gUM untouched for teams')
      assert.strictEqual(ctx.fakeNavigator.mediaDevices.enumerateDevices, origEnum, 'enumerateDevices untouched for teams')
    })

    it('DOES override getUserMedia for non-teams (sfu)', () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const origGUM = function sfuGUM () {}
      const ctx = runScript(s, { origGUM })
      assert.notStrictEqual(ctx.fakeNavigator.mediaDevices.getUserMedia, origGUM, 'gUM shimmed for sfu')
    })
  })

  describe('Teams pollTeams (behavioral)', () => {
    // callingDebug with a settable participant list; each poll reads observableCall.
    function teamsEnv (participants) {
      return { observableCall: { participants: { forEach (cb) { participants.forEach(cb) } } } }
    }
    function part (mri, name, voiceLevel) { return { mri, displayName: name, voiceLevel } }
    function startTeams (ctx) {
      ctx.clock.advance(3000) // start the poller
    }

    it('position is Date.now() - startTime (ms offset from first poll)', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // first poll sets startTime = now
      // Now Alice speaks 1500ms later.
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0.9)].forEach(cb) } }
      ctx.clock.advance(1500)
      ctx.clock.tickIntervals()
      const sc = jsonFrames(ws).filter((f) => f.type === 'speakerChanged')
      assert.strictEqual(sc.length, 1)
      assert.strictEqual(sc[0].position, 1500)
    })

    it('selects the speaker with the highest voiceLevel among several active', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.3), part('m2', 'Bob', 0.9), part('m3', 'Cara', 0.5)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals()
      const sc = jsonFrames(ws).filter((f) => f.type === 'speakerChanged')
      assert.strictEqual(sc.length, 1)
      assert.strictEqual(sc[0].speaker.id, 'm2', 'loudest wins')
    })

    it('does not flip speaker when a tie equals the current dominant level', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.5)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // Alice becomes speaker
      // Both at 0.5: strict > means Bob (m2) does NOT overtake Alice.
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0.5), part('m2', 'Bob', 0.5)].forEach(cb) } }
      ctx.clock.tickIntervals()
      const sc = jsonFrames(ws).filter((f) => f.type === 'speakerChanged')
      assert.strictEqual(sc.length, 1, 'no second speakerChanged on a tie')
      assert.strictEqual(sc[0].speaker.id, 'm1')
    })

    it('immediately emits speakerChanged when the dominant speaker changes (no grace)', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.9)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // Alice
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0.2), part('m2', 'Bob', 0.9)].forEach(cb) } }
      ctx.clock.tickIntervals() // Bob, same poll -> immediate
      const sc = jsonFrames(ws).filter((f) => f.type === 'speakerChanged')
      assert.strictEqual(sc.length, 2)
      assert.strictEqual(sc[1].speaker.id, 'm2')
    })

    it('debounces silence: speakerChanged:null only after 800ms of no dominant speaker', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.9)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // Alice speaking
      // Go silent.
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0)].forEach(cb) } }
      // silentSince is armed on this first silent poll; the 800ms window starts here.
      ctx.clock.advance(200); ctx.clock.tickIntervals() // arm silentSince
      ctx.clock.advance(500); ctx.clock.tickIntervals() // 500ms into the window -> hold
      let nulls = jsonFrames(ws).filter((f) => f.type === 'speakerChanged' && f.speaker === null)
      assert.strictEqual(nulls.length, 0, 'no null emit before 800ms')
      ctx.clock.advance(400); ctx.clock.tickIntervals() // 900ms into the window -> clear
      nulls = jsonFrames(ws).filter((f) => f.type === 'speakerChanged' && f.speaker === null)
      assert.strictEqual(nulls.length, 1, 'null emitted after 800ms silence')
    })

    it('holds the previous speaker during an intra-speech pause < 800ms then resumes', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.9)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // Alice
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0)].forEach(cb) } }
      ctx.clock.advance(300); ctx.clock.tickIntervals() // brief pause
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0.9)].forEach(cb) } }
      ctx.clock.advance(100); ctx.clock.tickIntervals() // Alice resumes
      const sc = jsonFrames(ws).filter((f) => f.type === 'speakerChanged')
      assert.strictEqual(sc.length, 1, 'only the initial Alice change; pause held, no flip')
      assert.strictEqual(sc[0].speaker.id, 'm1')
    })

    it('resets silentSince when any participant regains voiceLevel > 0', async () => {
      const cd = teamsEnv([part('m1', 'Alice', 0.9)])
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      startTeams(ctx)
      ctx.clock.tickIntervals() // Alice
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0)].forEach(cb) } }
      ctx.clock.advance(700); ctx.clock.tickIntervals() // 700ms silence (silentSince armed)
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0.9)].forEach(cb) } }
      ctx.clock.advance(100); ctx.clock.tickIntervals() // speech resumes -> silentSince reset
      cd.observableCall.participants = { forEach (cb) { [part('m1', 'Alice', 0)].forEach(cb) } }
      ctx.clock.advance(700); ctx.clock.tickIntervals() // only 700ms since the NEW silence
      const nulls = jsonFrames(ws).filter((f) => f.type === 'speakerChanged' && f.speaker === null)
      assert.strictEqual(nulls.length, 0, 'silence timer restarted, no null yet')
    })
  })

  describe('Teams degrade / throttle (behavioral)', () => {
    const inCall = (...names) => ({ participants: { forEach (cb) { names.forEach((n) => cb({ mri: n, displayName: n, voiceLevel: 0 })) } } })
    // A Teams page whose call was seen once (the bot was admitted).
    async function admitted (callingDebug) {
      const ctx = runScript(getInterceptScript(WS, { platformType: 'teams' }), { callingDebug })
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals()
      return { ctx, ws }
    }

    it('warnTeams throttles repeated messages to once per 5000ms', async () => {
      const { ctx } = await admitted({ observableCall: inCall('m1') })
      ctx.clock.advance(5000) // the fake clock starts near 0: get past a first throttle window
      ctx.fakeWindow.callingDebug = undefined // every poll now misses -> warnTeams
      ctx.clock.advance(200); ctx.clock.tickIntervals() // warns (lastWarnAt set)
      const after1 = ctx.warnings.length
      assert.ok(after1 > 0)
      ctx.clock.advance(200); ctx.clock.tickIntervals() // within throttle -> no new warn
      ctx.clock.advance(200); ctx.clock.tickIntervals()
      assert.strictEqual(ctx.warnings.length, after1, 'throttled within 5s')
      ctx.clock.advance(5000); ctx.clock.tickIntervals() // past throttle -> warns again
      assert.ok(ctx.warnings.length > after1, 'warns again after 5s window')
    })

    it('missCount increments per miss and resets when callingDebug recovers', async () => {
      const cd = { observableCall: inCall('m1') }
      const { ctx, ws } = await admitted(cd)
      cd.observableCall = null
      // 3 misses, spaced past the warn throttle to observe the count.
      ctx.clock.advance(200); ctx.clock.tickIntervals()
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      const missWarns = ctx.warnings.filter((w) => /miss \d+\/25/.test(w))
      assert.ok(/miss 3\/25/.test(missWarns[missWarns.length - 1]), missWarns.join(' | '))
      // API recovers -> a poll with a live call resets missCount (no degrade later).
      cd.observableCall = inCall('m1')
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      cd.observableCall = null
      for (let i = 0; i < 24; i++) { ctx.clock.advance(200); ctx.clock.tickIntervals() }
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded').length, 0, '24 misses after the reset')
    })

    it('signals diarizationDegraded exactly once at the 25th consecutive miss after the call was seen', async () => {
      const { ctx, ws } = await admitted({ observableCall: inCall('m1', 'm2') })
      ctx.fakeWindow.callingDebug = undefined // the API vanishes mid-call
      for (let i = 0; i < 24; i++) { ctx.clock.advance(200); ctx.clock.tickIntervals() }
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded').length, 0)
      for (let i = 0; i < 10; i++) { ctx.clock.advance(200); ctx.clock.tickIntervals() }
      const degraded = jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded')
      assert.strictEqual(degraded.length, 1, 'degrade signalled exactly once')
      assert.strictEqual(degraded[0].mode, 'asr')
      assert.deepStrictEqual(jsonFrames(ws).filter((f) => f.type === 'participantLeft').map((f) => f.participant.id), ['m1', 'm2'],
        'everyone known left once the call vanished')
    })

    it('a throwing callingDebug counts as a miss once the call was seen', async () => {
      const { ctx, ws } = await admitted({ observableCall: inCall('m1') })
      Object.defineProperty(ctx.fakeWindow, 'callingDebug', { get () { throw new Error('gone') } })
      for (let i = 0; i < 25; i++) { ctx.clock.advance(200); ctx.clock.tickIntervals() }
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded').length, 1)
    })

    // A bot waiting more than ~5 s on the prejoin screen or in the lobby (no call
    // yet) used to degrade the whole session to ASR diarization.
    it('a long prejoin/lobby (no call yet) is not a miss: no degrade, no warning, no participantLeft', async () => {
      const cd = { observableCall: null }
      const ctx = runScript(getInterceptScript(WS, { platformType: 'teams' }), { callingDebug: cd })
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      for (let i = 0; i < 300; i++) { ctx.clock.tickIntervals(); ctx.clock.advance(200) } // a minute in the lobby
      Object.defineProperty(cd, 'observableCall', { get () { throw new Error('not ready') }, configurable: true })
      for (let i = 0; i < 50; i++) { ctx.clock.tickIntervals(); ctx.clock.advance(200) }
      Object.defineProperty(cd, 'observableCall', { value: inCall('m1'), writable: true, configurable: true }) // admitted
      ctx.clock.tickIntervals()
      assert.deepStrictEqual(jsonFrames(ws).map((f) => f.type), ['participantMapping'])
      assert.deepStrictEqual(ctx.warnings, [])
    })

    it('the Teams poller is registered and its interval id is clearable', () => {
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s)
      assert.strictEqual(ctx.clock.intervals.size, 0)
      ctx.clock.advance(3000)
      assert.strictEqual(ctx.clock.intervals.size, 1, 'one Teams poller after startup delay')
      const id = [...ctx.clock.intervals.keys()][0]
      ctx.clock.clearInterval(id)
      assert.strictEqual(ctx.clock.intervals.size, 0)
    })
  })

  it('the sanitizer strips control chars and caps length (behavioral)', () => {
    // Extract and evaluate the sanitizeText implementation in isolation to prove
    // the generated regex/logic actually scrubs ANSI/newline injection.
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    const start = s.indexOf('function sanitizeText')
    assert.ok(start > -1, 'sanitizeText present')
    const constLine = s.match(/var SANITIZE_MAX_LEN = \d+;/)[0]
    const fnEnd = s.indexOf('function sanitizeParticipant')
    const fnSrc = s.slice(start, fnEnd)
    const sanitizeText = new Function(constLine + '\n' + fnSrc + '\nreturn sanitizeText;')()

    const ESC = String.fromCharCode(27) // ANSI escape introducer
    const NL = String.fromCharCode(10)
    const CR = String.fromCharCode(13)
    const out = sanitizeText('Alice' + ESC + '[31m' + CR + NL + 'Bob')
    assert.ok(out.indexOf(ESC) === -1, 'ESC stripped')
    assert.ok(out.indexOf(NL) === -1 && out.indexOf(CR) === -1, 'newlines stripped')
    const controlRe = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]')
    assert.ok(!controlRe.test(out), 'no control chars remain')
    assert.equal(sanitizeText('x'.repeat(5000)).length, 256, 'length capped to 256')
    assert.equal(sanitizeText(null), null, 'null passes through')
    assert.equal(sanitizeText('  plain  '), 'plain', 'trims surrounding whitespace')
  })
})
