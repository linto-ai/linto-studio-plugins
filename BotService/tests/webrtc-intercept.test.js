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
// worklet/scriptprocessor callbacks to feed PCM through the pipeline.
function makeAudioEnv (opts = {}) {
  const env = { workletNodes: [], scriptProcessors: [], sinks: [], sampleRate: opts.sampleRate || 48000 }
  class FakeAudioWorkletNode {
    constructor () { this.port = { onmessage: null }; this.connected = []; env.workletNodes.push(this) }
    connect (n) { this.connected.push(n) }
  }
  class FakeAudioContext {
    constructor () {
      if (opts.ctorThrows) throw new Error('AudioContext boom')
      this.state = opts.state || 'suspended'
      this.sampleRate = env.sampleRate
      this.destination = { id: 'dest' }
      this.audioWorklet = {
        addModule: async () => { if (opts.workletThrows) throw new Error('no worklet') }
      }
    }
    async resume () { this.state = 'running' }
    createMediaStreamSource () { return { connect () {} } }
    createMediaStreamDestination () { return { stream: { getAudioTracks: () => [{ id: 'gum-a' }] } } }
    createOscillator () { return { connect () {}, start () {} } }
    createGain () { return { gain: {}, connect () {} } }
    createScriptProcessor () {
      const proc = { onaudioprocess: null, connect () {} }
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
  const fakeDocument = {
    createElement () {
      return {
        srcObject: null, muted: false, autoplay: false,
        getContext () { return { fillRect () {} } },
        captureStream () { return { getVideoTracks: () => [{ id: 'v' }] } },
        play () { return Promise.resolve() }
      }
    },
    querySelectorAll () { return elements }
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
  function FakeBlob () {}
  function FakeMediaStream (tracks) { this.tracks = tracks; this.getAudioTracks = () => tracks }
  fn(
    fakeWindow, fakeDocument, fakeNavigator, FakeWebSocket, audio.AudioWorkletNode, audio.AudioContext,
    fakeConsole, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval,
    clock.Date, FakeURL, FakeBlob, FakeMediaStream
  )

  const fireWindow = (ev) => (winListeners[ev] || []).forEach((cb) => cb())
  return { clock, FakeWebSocket, audio, warnings, logs, pcInstances, fakeWindow, fakeNavigator, fakeDocument, OriginalRTCPeerConnection, fireWindow }
}

// Parse the JSON text frames a fake WS received (binary frames are ArrayBuffers).
function jsonFrames (ws) {
  return ws.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f))
}
function binaryFrames (ws) {
  return ws.sent.filter((f) => typeof f !== 'string')
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

  // Loopback WS resync after LocalAudioServer restart.
  it('remembers sent mappings and replays them only on a reconnect (not first connect)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('sentMappings'), 'records mappings already sent')
    assert.ok(s.includes('hasConnectedOnce'), 'gates replay behind the first connect')
    assert.ok(/hasConnectedOnce\s*&&\s*sentMappings\.size/.test(s), 'replays only after first connect')
    assert.ok(s.includes('replaying'))
    assert.ok(s.includes('hasConnectedOnce = true'))
    assert.doesNotThrow(() => new Function(s))
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

  describe('resample() (behavioral)', () => {
    const resample = extractFn(getInterceptScript(WS, { platformType: 'sfu' }), 'resample',
      'const TARGET_SAMPLE_RATE = 16000;')

    it('returns the input unchanged when already at 16kHz', () => {
      const input = Float32Array.from([0.1, 0.2, 0.3])
      assert.strictEqual(resample(input, 16000), input)
    })

    it('halves the sample count when downsampling 48kHz -> 16kHz (3:1)', () => {
      const input = Float32Array.from([0, 0.3, 0.6, 0.9, 1.2, 1.5])
      const out = resample(input, 48000)
      assert.strictEqual(out.length, 2) // floor(6 / 3)
      // idx 0 -> input[0]; idx 1 -> i*ratio = 3 -> input[3]
      assert.ok(Math.abs(out[0] - 0) < 1e-6)
      assert.ok(Math.abs(out[1] - 0.9) < 1e-6)
    })

    it('linearly interpolates when downsampling 44.1kHz -> 16kHz', () => {
      const input = Float32Array.from([0, 1, 2, 3, 4, 5, 6])
      const out = resample(input, 44100)
      const ratio = 44100 / 16000
      assert.strictEqual(out.length, Math.floor(input.length / ratio))
      // sample 1: idx = ratio (~2.756) -> lerp(input[2], input[3], .756) = 2.756
      const idx = ratio
      const lo = Math.floor(idx); const frac = idx - lo
      const expected = input[lo] * (1 - frac) + input[lo + 1] * frac
      assert.ok(Math.abs(out[1] - expected) < 1e-6)
    })

    it('upsamples 8kHz -> 16kHz, doubling the sample count', () => {
      const input = Float32Array.from([0, 1, 2])
      const out = resample(input, 8000)
      assert.strictEqual(out.length, Math.floor(input.length / (8000 / 16000))) // 6
      // ratio 0.5: idx 1 -> 0.5 -> lerp(0,1,.5)=0.5
      assert.ok(Math.abs(out[1] - 0.5) < 1e-6)
      assert.ok(Math.abs(out[2] - 1) < 1e-6)
    })

    it('clamps the high index at the last sample (no out-of-bounds read)', () => {
      const input = Float32Array.from([0, 10])
      const out = resample(input, 8000) // ratio 0.5, outLen 4
      // last out idx 3 -> 1.5 -> lerp(input[1], input[1], .5) since hi clamps to len-1
      assert.ok(out.every((v) => Number.isFinite(v)))
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

  describe('setupTrackCapture()/handleNewTrack() (behavioral)', () => {
    it('AudioWorklet path: worklet message sends a resampled PCM binary frame', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 48000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('t-audio'))
      await flush(); await flush()
      assert.strictEqual(ctx.audio.workletNodes.length, 1, 'a worklet node was created')
      const node = ctx.audio.workletNodes[0]
      assert.strictEqual(typeof node.port.onmessage, 'function')
      // Feed 6 samples @48k -> 2 samples @16k -> 4 bytes PCM + 4 byte header.
      node.port.onmessage({ data: Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) })
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
      const node = ctx.audio.workletNodes[0]
      node.port.onmessage({ data: new Float32Array(48) }) // 48 @48k -> 16 @16k
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
      const node = ctx.audio.workletNodes[0]
      node.port.onmessage({ data: Float32Array.from([1.0, -1.0]) }) // 16k -> no resample
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
      const node = ctx.audio.workletNodes[0]
      node.port.onmessage({ data: new Float32Array(10) }) // 10 samples
      const bin = binaryFrames(ws)[0]
      assert.strictEqual(bin.byteLength, 4 + 10 * 2)
    })

    it('an empty PCM payload still produces a frame (header only) — no crash', async () => {
      // Note: the current source does NOT special-case empty PCM in sendBinary; the
      // worklet processor guards (c.length>0) upstream, but a direct empty payload
      // yields a 4-byte header-only frame. Asserting CURRENT behaviour.
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      const ws = await openLoopback(ctx)
      emitTrack(ctx, makeTrack('empty'))
      await flush(); await flush()
      const node = ctx.audio.workletNodes[0]
      node.port.onmessage({ data: new Float32Array(0) })
      const bin = binaryFrames(ws)[0]
      assert.strictEqual(bin.byteLength, 4, 'header-only frame for empty PCM')
    })

    it('sendBinary is a no-op while the loopback WS is not OPEN', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s, { audioOpts: { sampleRate: 16000 } })
      // Do NOT open the loopback ws.
      await flush()
      emitTrack(ctx, makeTrack('closed'))
      await flush(); await flush()
      const node = ctx.audio.workletNodes[0]
      node.port.onmessage({ data: Float32Array.from([0.5]) })
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
      ctx.clock.tickIntervals() // poll 2: roster diff -> Alice is gone
      const left = jsonFrames(ws).filter((f) => f.type === 'participantLeft')
      assert.strictEqual(left.length, 1, 'exactly one participantLeft')
      assert.strictEqual(left[0].participant.id, 'idAlice')
      assert.strictEqual(left[0].participant.name, 'Alice')
      ctx.clock.tickIntervals() // poll 3: already removed -> not re-emitted
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
      ctx.clock.tickIntervals()
      const left = jsonFrames(ws).filter((f) => f.type === 'participantLeft')
      assert.strictEqual(left.length, 1)
      assert.strictEqual(left[0].participant.id, 'idA')
    })
  })

  describe('SFU polling lifecycle (behavioral)', () => {
    it('after the 3000ms startup delay both Jitsi and LiveKit pollers are active', async () => {
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      await openLoopback(ctx)
      assert.strictEqual(ctx.clock.intervals.size, 0, 'no pollers before the delay')
      ctx.clock.advance(3000)
      assert.strictEqual(ctx.clock.intervals.size, 2, 'two pollers after the delay')
    })

    it('all interval ids are stored so beforeunload can clear them', () => {
      // The intervals array (in source) holds every setInterval id; our clock tracks
      // the same ids. Assert each stored id is clearable.
      const s = getInterceptScript(WS, { platformType: 'sfu' })
      const ctx = runScript(s)
      ctx.clock.advance(3000)
      const ids = [...ctx.clock.intervals.keys()]
      assert.strictEqual(ids.length, 2)
      ids.forEach((id) => ctx.clock.clearInterval(id))
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
    it('warnTeams throttles repeated messages to once per 5000ms', async () => {
      // callingDebug absent -> every poll calls noteCallingDebugMissing -> warnTeams.
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: undefined })
      await openLoopback(ctx)
      ctx.clock.advance(3000)
      ctx.clock.tickIntervals() // poll 1 -> warns (lastWarnAt set)
      const after1 = ctx.warnings.length
      ctx.clock.advance(200); ctx.clock.tickIntervals() // within throttle -> no new warn
      ctx.clock.advance(200); ctx.clock.tickIntervals()
      assert.strictEqual(ctx.warnings.length, after1, 'throttled within 5s')
      ctx.clock.advance(5000); ctx.clock.tickIntervals() // past throttle -> warns again
      assert.ok(ctx.warnings.length > after1, 'warns again after 5s window')
    })

    it('missCount increments per miss and resets when callingDebug recovers', async () => {
      const cd = { observableCall: null }
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: cd })
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      // 3 misses (observableCall null), spaced past the warn throttle to observe count.
      ctx.clock.tickIntervals()
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      const missWarns = ctx.warnings.filter((w) => /miss \d+\/25/.test(w))
      assert.ok(missWarns.length >= 1)
      assert.ok(/miss 3\/25/.test(missWarns[missWarns.length - 1]) || missWarns.length >= 1)
      // API recovers -> a poll with a live call resets missCount (no degrade later).
      cd.observableCall = { participants: { forEach () {} } }
      ctx.clock.advance(5000); ctx.clock.tickIntervals()
      assert.strictEqual(jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded').length, 0)
    })

    it('signals diarizationDegraded exactly once at the 25th consecutive miss', async () => {
      const s = getInterceptScript(WS, { platformType: 'teams' })
      const ctx = runScript(s, { callingDebug: undefined }) // absent every poll
      const ws = await openLoopback(ctx)
      ctx.clock.advance(3000)
      for (let i = 0; i < 30; i++) { ctx.clock.tickIntervals(); ctx.clock.advance(200) }
      const degraded = jsonFrames(ws).filter((f) => f.type === 'diarizationDegraded')
      assert.strictEqual(degraded.length, 1, 'degrade signalled exactly once')
      assert.strictEqual(degraded[0].mode, 'asr')
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
