const assert = require('assert')
const http = require('http')
const { describe, it, before, after, afterEach } = require('mocha')
const LocalAudioServer = require('../bot/LocalAudioServer')
const { getInterceptScript } = require('../bot/webrtc-intercept')

// The capture script in the real Chromium of the BotService image (Playwright,
// PLAYWRIGHT_BROWSERS_PATH), launched with the BrowserPool arguments. A page loops
// oscillator tracks back to itself through two RTCPeerConnections; the inbound
// tracks are what the script captures and streams to a real LocalAudioServer.

// BrowserPool.test.js swaps `playwright` for a stub in the require cache when it
// is loaded, then loads BrowserPool against it. Nothing here may load playwright
// before that (mocha's file order is not guaranteed), so it is only required once
// the suite runs: the real module for this suite, then whatever was cached is put
// back so the other suites keep their stub.
function realChromium () {
  const path = require.resolve('playwright')
  const cached = require.cache[path]
  delete require.cache[path]
  try {
    return require('playwright').chromium
  } finally {
    if (cached) require.cache[path] = cached
  }
}

// window.startLoopback(freqs): one oscillator track per frequency, sent by pc1 and
// received by pc2. window.endTrack(i) stops the i-th receiving transceiver, which
// ends the corresponding inbound track.
const LOOPBACK_SCRIPT = `
window.startLoopback = async function (freqs) {
  const ac = new AudioContext();
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate); };
  pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
  for (const f of freqs) {
    const osc = ac.createOscillator(), gain = ac.createGain(), dest = ac.createMediaStreamDestination();
    osc.frequency.value = f;
    gain.gain.value = 0.25;
    osc.connect(gain); gain.connect(dest); osc.start();
    pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  }
  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription);
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription);
  window.loopback = { pc1, pc2 };
};
window.endTrack = function (i) { window.loopback.pc2.getTransceivers()[i].stop(); };
`
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${LOOPBACK_SCRIPT}</script>${body || ''}</body></html>`

const nowMs = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

// Least-squares slope of a stream's cumulative sample count against the arrival
// time of its frames ({ at, samples }): samples per second, insensitive to the
// jitter of single arrivals.
function samplesPerSecond (frames) {
  const t0 = frames[0].at
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, total = 0
  for (const f of frames) {
    total += f.samples.length
    const x = (f.at - t0) / 1000
    n++; sx += x; sy += total; sxx += x * x; sxy += x * total
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx)
}

// Dominant frequency of a 16 kHz signal from its rising zero crossings.
function frequency (samples) {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++
  return crossings / (samples.length / 16000)
}

// Amplitude of the `freq` component of a 16 kHz frame (single-frequency DFT).
function toneAmplitude (samples, freq) {
  const w = 2 * Math.PI * freq / 16000
  let re = 0, im = 0
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos(w * i)
    im -= samples[i] * Math.sin(w * i)
  }
  return 2 * Math.sqrt(re * re + im * im) / samples.length
}

const concat = (frames) => {
  const out = new Int16Array(frames.reduce((n, f) => n + f.samples.length, 0))
  let offset = 0
  for (const f of frames) { out.set(f.samples, offset); offset += f.samples.length }
  return out
}

describe('webrtc-intercept in Chromium', function () {
  this.timeout(60000)

  let browser, server, audioServer, baseUrl
  const pages = new Map() // url path -> html
  before(async () => {
    const { LAUNCH_ARGS } = require('../bot/BrowserPool')
    browser = await realChromium().launch({ headless: true, args: LAUNCH_ARGS })
    server = http.createServer((req, res) => {
      const html = pages.get(req.url)
      res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html' })
      res.end(html || '')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
    audioServer = new LocalAudioServer()
    await audioServer.start()
  })
  after(async () => {
    if (audioServer) await audioServer.stop()
    if (server) await new Promise((resolve) => server.close(resolve))
    if (browser) await browser.close()
  })

  // Every PCM frame and control message the page sends, in arrival order.
  let seq = 0
  function collect (path) {
    const got = { frames: [], json: [] }
    audioServer.registerBot(path, {
      onBinary: (trackIndex, pcm, connId) => {
        const samples = new Int16Array(pcm.length / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2)
        got.frames.push({ seq: seq++, at: nowMs(), connId, trackIndex, samples })
      },
      onJson: (json, connId) => { got.json.push({ seq: seq++, at: nowMs(), connId, json }) }
    })
    return got
  }

  // A fresh context + page with the capture script injected, navigated to `html`.
  let contexts = []
  afterEach(async () => {
    for (const c of contexts) await c.close()
    contexts = []
  })
  async function openPage (name, html, platformType = 'mcu') {
    const path = `/bot-${name}`
    const got = collect(path)
    pages.set(`/${name}`, html)
    const context = await browser.newContext({ bypassCSP: true })
    contexts.push(context)
    const p = await context.newPage()
    await p.addInitScript(getInterceptScript(`ws://127.0.0.1:${audioServer.getPort()}${path}`, { platformType }))
    await p.goto(`${baseUrl}/${name}`)
    return { page: p, got, path }
  }

  const framesOf = (got, trackIndex, fromMs = 0) => got.frames.filter((f) => f.trackIndex === trackIndex && f.at >= fromMs)

  it('streams a remote track at 16000 samples/s (within 0.2%), at its own pitch', async () => {
    const { page: p, got } = await openPage('rate', page())
    await p.evaluate(() => window.startLoopback([440]))
    await waitFor(() => framesOf(got, 0).length > 0, 10000, 'the first PCM frame')
    const start = nowMs() + 1000 // past the WebRTC start-up
    await sleep(5000)
    const frames = framesOf(got, 0, start)
    const rate = samplesPerSecond(frames)
    assert.ok(Math.abs(rate / 16000 - 1) < 0.002, `track 0 at ${rate.toFixed(1)} samples/s`)
    const pitch = frequency(concat(frames))
    assert.ok(Math.abs(pitch / 440 - 1) < 0.01, `440 Hz captured as ${pitch.toFixed(1)} Hz`)
  })

  it('captures simultaneous tracks under their own index, and an ended track stops right away', async () => {
    const { page: p, got } = await openPage('two', page())
    await p.evaluate(() => window.startLoopback([440, 1000]))
    await waitFor(() => framesOf(got, 0).length > 0 && framesOf(got, 1).length > 0, 10000, 'PCM of both tracks')
    await sleep(1000)
    const pitches = [0, 1].map((i) => frequency(concat(framesOf(got, i).slice(-100))))
    assert.ok(Math.abs(pitches[0] / 440 - 1) < 0.01, `track 0 at ${pitches[0]} Hz`)
    assert.ok(Math.abs(pitches[1] / 1000 - 1) < 0.01, `track 1 at ${pitches[1]} Hz`)

    await p.evaluate(() => window.endTrack(1))
    await waitFor(() => got.json.some((m) => m.json.type === 'trackRemoved'), 5000, 'trackRemoved')
    const removed = got.json.find((m) => m.json.type === 'trackRemoved')
    assert.strictEqual(removed.json.trackIndex, 1)
    const before = framesOf(got, 0).length
    await sleep(1000)
    assert.strictEqual(got.frames.filter((f) => f.trackIndex === 1 && f.seq > removed.seq).length, 0,
      'no frame of the ended track after its trackRemoved')
    assert.ok(framesOf(got, 0).length > before + 100, 'the other track keeps streaming')
  })

  it('sub-frames run no poller, and only those that capture a track open a socket', async () => {
    const teamsCall = (name) => `<script>window.callingDebug = { observableCall: { participants: [{ mri: "${name}", displayName: "${name}", voiceLevel: 0 }] } };</script>`
    pages.set('/frame-media', page(teamsCall('Sub') + '<script>window.startLoopback([440]);</script>'))
    pages.set('/frame-plain', page(teamsCall('Plain')))
    const { got, path } = await openPage('frames', page(teamsCall('Top') +
      '<iframe src="/frame-media"></iframe><iframe src="/frame-plain"></iframe>'), 'teams')
    await waitFor(() => got.frames.length > 0, 10000, 'the audio of the sub-frame track')
    await waitFor(() => got.json.some((m) => m.json.type === 'participantMapping'), 10000, 'the top frame poller')
    await sleep(1500) // several more 200 ms poll rounds
    const mediaConn = got.frames[0].connId
    const conns = new Set([...got.frames, ...got.json].map((m) => m.connId))
    assert.strictEqual(conns.size, 2, 'the top frame and the frame with a track')
    assert.strictEqual(audioServer.connections.get(path).size, 2, 'no socket for the frame without media')
    const mapped = got.json.filter((m) => m.json.type === 'participantMapping')
    assert.ok(mapped.every((m) => m.json.participant.name === 'Top' && m.connId !== mediaConn), 'only the top frame polls')
    assert.deepStrictEqual([...new Set(got.json.filter((m) => m.connId === mediaConn).map((m) => m.json.type))], ['trackAdded'],
      'the sub-frame announces its track and nothing else')
  })

  // A Visio-like join: the meeting client's LiveKit Room, reached through React's
  // fiber as the SFU poller expects, is connected before any track; a participant
  // then publishes a track (here the loopback one) and speaks from the start.
  it('Visio-like join: a participant speaking from their first frame is named within ~0.5 s', async () => {
    const Bot = require('../bot')
    pages.set('/visio', page(`<script>
      window.room = { state: 'connected', localParticipant: {}, remoteParticipants: new Map() };
      document.body.__reactFiber$test = { memoizedProps: { room: window.room }, memoizedState: null, return: null };
      window.joinAlice = async function () {
        await window.startLoopback([440]);
        const track = window.loopback.pc2.getReceivers()[0].track;
        window.room.remoteParticipants.set('idAlice', { identity: 'idAlice', name: 'Alice',
          trackPublications: new Map([['a', { kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: track } }]]) });
      };
    </script>`))
    const context = await browser.newContext({ bypassCSP: true })
    contexts.push(context)
    const p = await context.newPage()
    const bot = new Bot({
      session: { id: 's' },
      channel: { id: 'visio' },
      address: `${baseUrl}/visio`,
      botType: 'visio',
      browserPool: { createContext: async () => ({ page: p }), destroyContext: async () => {} },
      audioServer
    })
    bot.manifest.loginRules = []
    bot.manifest.leaveRules = []
    const events = []
    let firstAudio = null
    bot.on('audio', () => { if (firstAudio === null) firstAudio = nowMs() })
    bot.on('participant-joined', (e) => events.push({ at: nowMs(), what: 'join ' + e.name }))
    bot.on('speakerChanged', (e) => events.push({ at: nowMs(), what: 'speaker ' + (e.speaker && e.speaker.name) }))
    try {
      assert.strictEqual(await bot.init(), true)
      await sleep(500) // the poller finds the Room
      await p.evaluate(() => window.joinAlice())
      const joined = nowMs()
      await waitFor(() => events.some((e) => e.what === 'speaker Alice'), 10000, 'Alice as the speaker')
      const named = events.find((e) => e.what === 'speaker Alice').at
      assert.deepStrictEqual(events.map((e) => e.what), ['join Alice', 'speaker Alice'])
      assert.ok(firstAudio !== null && firstAudio <= named, 'her audio is mixed before she is mapped')
      assert.ok(named - firstAudio < 600, `named ${(named - firstAudio).toFixed(0)} ms after her first mixed frame`)
      assert.ok(named - joined < 1500, `named ${(named - joined).toFixed(0)} ms after her track was published`)
    } finally {
      await bot.dispose()
    }
  })

  // An SFU recycles a departed participant's receiving transceiver for the next
  // subscription: Chromium then fires 'track' again with the same track (no
  // 'ended' meanwhile, only 'mute'), here with a LiveKit-like Room whose roster
  // follows. The participant coming back must be joined again.
  it('a participant back on a recycled receiver is joined again (real transceiver reuse)', async () => {
    const Bot = require('../bot')
    pages.set('/reuse', page(`<script>
      window.room = { state: 'connected', localParticipant: {}, remoteParticipants: new Map() };
      document.body.__reactFiber$test = { memoizedProps: { room: window.room }, memoizedState: null, return: null };
      const ac = new AudioContext();
      const tone = (f) => { const o = ac.createOscillator(), g = ac.createGain(), d = ac.createMediaStreamDestination(); o.frequency.value = f; g.gain.value = 0.25; o.connect(g); g.connect(d); o.start(); return d.stream.getAudioTracks()[0]; };
      const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate); };
      pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
      const nego = async () => {
        await pc1.setLocalDescription(await pc1.createOffer());
        await pc2.setRemoteDescription(pc1.localDescription);
        await pc2.setLocalDescription(await pc2.createAnswer());
        await pc1.setRemoteDescription(pc2.localDescription);
      };
      let tx;
      const publish = () => window.room.remoteParticipants.set('idBob', { identity: 'idBob', name: 'Bob',
        trackPublications: new Map([['a', { kind: 'audio', isSubscribed: true, track: { mediaStreamTrack: pc2.getReceivers()[0].track } }]]) });
      window.joinBob = async () => { tx = pc1.addTransceiver(tone(440), { direction: 'sendonly' }); await nego(); publish(); };
      window.leaveBob = async () => { await tx.sender.replaceTrack(null); tx.direction = 'inactive'; await nego(); window.room.remoteParticipants.delete('idBob'); };
      window.backBob = async () => { await tx.sender.replaceTrack(tone(1000)); tx.direction = 'sendonly'; await nego(); publish(); };
    </script>`))
    const context = await browser.newContext({ bypassCSP: true })
    contexts.push(context)
    const p = await context.newPage()
    const bot = new Bot({
      session: { id: 's' },
      channel: { id: 'reuse' },
      address: `${baseUrl}/reuse`,
      botType: 'visio',
      browserPool: { createContext: async () => ({ page: p }), destroyContext: async () => {} },
      audioServer
    })
    bot.manifest.loginRules = []
    bot.manifest.leaveRules = []
    const seen = []
    bot.on('participant-joined', (e) => seen.push('join ' + e.name))
    bot.on('participant-left', (e) => seen.push('left ' + e.name))
    try {
      assert.strictEqual(await bot.init(), true)
      await p.evaluate(() => window.joinBob())
      await waitFor(() => seen.includes('join Bob'), 5000, 'Bob joined')
      await p.evaluate(() => window.leaveBob())
      await waitFor(() => seen.includes('left Bob'), 5000, 'Bob left')
      assert.notStrictEqual(bot.emptyMeetingTimer, null, 'the meeting looks empty')
      await p.evaluate(() => window.backBob())
      await waitFor(() => seen.length === 3, 5000, 'Bob joined again')
      assert.deepStrictEqual(seen, ['join Bob', 'left Bob', 'join Bob'])
      assert.strictEqual(bot.emptyMeetingTimer, null, 'no longer empty')
      assert.strictEqual(bot.audioMixer.getStats().tracks.length, 1, 'one track all along')
    } finally {
      await bot.dispose()
    }
  })

  // The incident path: a Teams page with two tracks at once, forwarded by the Bot.
  it('through the Bot: two simultaneous tracks become one stream at 1.0x real time, both in every frame', async () => {
    const Bot = require('../bot')
    // The Teams poller finds one participant: the bot is admitted, audio flows.
    pages.set('/teams', page('<script>window.callingDebug = { observableCall: { participants: [{ mri: "m1", displayName: "Alice", voiceLevel: 0 }] } };</script>'))
    const context = await browser.newContext({ bypassCSP: true })
    contexts.push(context)
    const p = await context.newPage()
    const bot = new Bot({
      session: { id: 's' },
      channel: { id: 'teams' },
      address: `${baseUrl}/teams`,
      botType: 'teams',
      browserPool: { createContext: async () => ({ page: p }), destroyContext: async () => {} },
      audioServer
    })
    bot.manifest.loginRules = []
    bot.manifest.leaveRules = []
    const frames = []
    bot.on('audio', (buf) => frames.push({ at: nowMs(), samples: new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2) }))
    try {
      assert.strictEqual(await bot.init(), true)
      await p.evaluate(() => window.startLoopback([440, 1000]))
      await waitFor(() => bot.hasSeenParticipant, 10000, 'admission (the Teams poller)')
      await waitFor(() => frames.length > 0, 10000, 'mixed audio')
      const start = nowMs() + 1000 // past the start of the second track
      await sleep(4000)
      const measured = frames.filter((f) => f.at >= start)
      const rate = samplesPerSecond(measured)
      assert.ok(Math.abs(rate / 16000 - 1) < 0.01, `bot output at ${(rate / 16000).toFixed(3)}x real time`)
      // Concatenated tracks would alternate frames of one tone and of the other.
      const expected = 0.25 * 32767
      const lacking = measured.filter((f) => toneAmplitude(f.samples, 440) < expected / 2 || toneAmplitude(f.samples, 1000) < expected / 2)
      assert.strictEqual(lacking.length, 0, `${lacking.length}/${measured.length} frames without both tones`)
    } finally {
      await bot.dispose()
    }
  })
})
