const assert = require('assert')
const path = require('path')
const { describe, it, beforeEach, afterEach } = require('mocha')
const Bot = require('../bot')

const frame = (value, n = 320) => Buffer.from(new Int16Array(n).fill(value).buffer)
const samplesOf = (buf) => Array.from(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2))

// Build a fake Playwright page that records the diagnostics handlers, init
// scripts, routes and rule invocations so init()/execRule() can be asserted
// without a real browser. Locator actions resolve unless told to reject.
function makeFakePage (opts = {}) {
  const handlers = {}
  const calls = { addInitScript: [], route: [], goto: [], locatorActions: [], evaluate: [], press: [], waitForTimeout: [] }
  const rejectFor = opts.rejectFor || (() => false)
  const mkLocator = (selector) => ({
    fill: async (value) => { calls.locatorActions.push({ action: 'fill', selector, value }); if (rejectFor('fill', selector)) throw new Error('fill failed') },
    click: async () => { calls.locatorActions.push({ action: 'click', selector }); if (rejectFor('click', selector)) throw new Error('click failed') },
    waitFor: async () => { calls.locatorActions.push({ action: 'waitForSelector', selector }); if (rejectFor('waitForSelector', selector)) throw new Error('waitFor failed') },
    selectOption: async (value) => { calls.locatorActions.push({ action: 'select', selector, value }); if (rejectFor('select', selector)) throw new Error('select failed') },
    hover: async () => { calls.locatorActions.push({ action: 'hover', selector }); if (rejectFor('hover', selector)) throw new Error('hover failed') },
    focus: async () => { calls.locatorActions.push({ action: 'focus', selector }); if (rejectFor('focus', selector)) throw new Error('focus failed') },
    clear: async () => { calls.locatorActions.push({ action: 'clearInput', selector }); if (rejectFor('clearInput', selector)) throw new Error('clear failed') },
    // opts.count(selector): how many elements match (0 by default); may throw.
    count: async () => (opts.count ? opts.count(selector) : 0),
    // The fake page shows every element it counts: the visible filter and the
    // first-element pick keep the selector.
    filter: () => mkLocator(selector),
    first: () => mkLocator(selector)
  })
  const mainFrame = { url: () => page.mainFrameUrl }
  const page = {
    calls,
    handlers,
    mainFrameUrl: opts.mainFrameUrl || 'about:blank',
    mainFrame: () => mainFrame,
    on (event, cb) { handlers[event] = cb },
    async addInitScript (script) { calls.addInitScript.push(script) },
    async route (pattern, handler) { calls.route.push({ pattern, handler }) },
    async goto (url, optsArg) { calls.goto.push({ url, opts: optsArg }); if (opts.gotoThrows) throw new Error('goto boom') },
    locator: mkLocator,
    keyboard: { press: async (key) => { calls.press.push(key); if (rejectFor('press', key)) throw new Error('press failed') } },
    async evaluate (script) { calls.evaluate.push(script); if (rejectFor('evaluate', script)) throw new Error('evaluate failed') },
    async waitForTimeout (ms) { calls.waitForTimeout.push(ms) }
  }
  return page
}

// Bot with a controllable fake page and recording browserPool/audioServer, so
// init() and dispose() side-effects are observable.
function makeInitBot (botType, pageOpts = {}, overrides = {}) {
  const page = makeFakePage(pageOpts)
  const record = { registerBot: [], unregisterBot: [], destroyContext: [], createContextCalls: 0 }
  const bot = new Bot({
    session: { id: 's' },
    channel: { id: 'c' },
    address: overrides.address || 'https://example.com/room',
    botType,
    browserPool: {
      createContext: async (id) => { record.createContextCalls++; return overrides.noContext ? null : { page } },
      destroyContext: async (id) => { record.destroyContext.push(id) }
    },
    audioServer: {
      getPort: () => 9999,
      registerBot (wsPath, handlers) { record.registerBot.push({ wsPath, handlers }) },
      unregisterBot (wsPath) { record.unregisterBot.push(wsPath) }
    }
  })
  return { bot, page, record }
}

const MANIFESTS = ['jitsi', 'bigbluebutton', 'teams', 'visio']

function makeFakeMixer () {
  return {
    added: [], removed: [], removedTracks: [], attributed: new Map(), stopped: false,
    addAudio (key, pcm) { this.added.push({ key, len: pcm.length }) },
    setTrackParticipant (key, participant) { this.attributed.set(key, participant) },
    removeTrack (key) { this.removedTracks.push(key) },
    removeParticipant (id) { this.removed.push(id) },
    trackIds () { return [...new Set([...this.added.map(a => a.key), ...this.attributed.keys()])] },
    on () {}, stop () { this.stopped = true }
  }
}

function makeBot (botType, overrides = {}) {
  const bot = new Bot({
    session: { id: 's' },
    channel: { id: 'c' },
    address: 'https://example.com/room',
    botType,
    browserPool: { createContext: async () => ({ page: {} }), destroyContext: async () => {} },
    audioServer: { getPort: () => 1, registerBot () {}, unregisterBot () {} },
    ...overrides
  })
  return bot
}

describe('Bot manifests', () => {
  MANIFESTS.forEach((name) => {
    it(`${name}.json is valid and Playwright-only (no captions-back in v1)`, () => {
      const m = require(`../bot/manifests/${name}.json`)
      assert.ok(['sfu', 'mcu', 'teams'].includes(m.platformType))
      assert.ok(['native', 'asr'].includes(m.diarizationMode))
      assert.ok(Array.isArray(m.loginRules) && m.loginRules.length > 0)
      assert.equal(m.subtitleRules, undefined, 'captions-back-into-meeting is dropped for v1')
      assert.ok(Array.isArray(m.leaveRules))
      for (const rule of m.loginRules) {
        assert.notEqual(rule.action, 'type', 'use Playwright "fill", not Puppeteer "type"')
        if (rule.selector) assert.ok(!rule.selector.includes('::-p-text'), 'no Puppeteer ::-p-text selector')
      }
    })
  })

  it('jitsi/visio are SFU+native; bbb is MCU+asr; teams is teams+native', () => {
    assert.equal(require('../bot/manifests/jitsi.json').platformType, 'sfu')
    assert.equal(require('../bot/manifests/visio.json').platformType, 'sfu')
    assert.equal(require('../bot/manifests/bigbluebutton.json').platformType, 'mcu')
    assert.equal(require('../bot/manifests/bigbluebutton.json').diarizationMode, 'asr')
    assert.equal(require('../bot/manifests/teams.json').platformType, 'teams')
  })
})

describe('Bot', () => {
  it('refuses an unknown botType (no manifest, init returns false)', async () => {
    const bot = makeBot('evil/../../etc/passwd')
    assert.equal(bot.manifest, null)
    assert.equal(await bot.init(), false)
  })

  describe('SFU audio routing + native diarization', () => {
    let bot, mixer
    beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

    it('mixes each track under its own key and attributes it to its mapped participant', () => {
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.deepEqual(mixer.added, [{ key: 'c0:0', len: 640 }])
      assert.deepEqual(mixer.attributed.get('c0:0'), { id: 'u1', name: 'Alice' })
    })

    it('two tracks of one participant (mic + screen share) stay two tracks of the mix', () => {
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot._onParticipantMapping(1, { id: 'u1', name: 'Alice' })
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(1, Buffer.alloc(640))
      assert.deepEqual(mixer.added.map(a => a.key), ['c0:0', 'c0:1'])
      assert.equal(mixer.attributed.get('c0:1').id, 'u1')
    })

    it('mixes unmapped audio at once (no delayed early-audio flush); the mapping only attributes it', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(mixer.added.length, 2, 'mixed in real time, before the mapping')
      assert.equal(mixer.attributed.size, 0)

      let joined = null
      bot.on('participant-joined', (p) => { joined = p })
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })

      assert.equal(mixer.added.length, 2, 'nothing replayed')
      assert.deepEqual(mixer.attributed.get('c0:0'), { id: 'u1', name: 'Alice' })
      assert.deepEqual(joined, { identity: 'u1', name: 'Alice' })
    })

    it('emits participant-left and arms the empty-meeting timer when the last one leaves', (done) => {
      bot.emptyMeetingTimeoutMs = 10
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      let left = null
      bot.on('participant-left', (p) => { left = p })
      bot.on('meeting-empty', () => {
        assert.deepEqual(left, { identity: 'u1', name: 'Alice' })
        assert.deepEqual(mixer.removed, ['u1'])
        done()
      })
      bot._onParticipantLeft({ id: 'u1', name: 'Alice' })
    })

    it('removes an unmapped track from the mixer when it ends', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot._onTrackRemoved(0)
      assert.deepEqual(mixer.removedTracks, ['c0:0'])
    })

    it('a mapping for a removed track does not attribute it again', () => {
      bot._onTrackRemoved(0)
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      assert.equal(mixer.attributed.has('c0:0'), false)
    })

    it('applies the mappings received before the mixer started', () => {
      const early = makeBot('visio')
      early._onParticipantMapping(2, { id: 'u1', name: 'Alice' })
      early._startMixer()
      assert.deepEqual(early.audioMixer.getStats().tracks.map(t => [t.id, t.participantId]), [['c0:2', 'u1']])
      early.audioMixer.stop()
    })

    it('dispose stops the mixer', async () => {
      await bot.dispose()
      assert.equal(mixer.stopped, true)
      assert.equal(bot.audioMixer, null)
    })

    it('cancels the empty-meeting timer when a new participant joins', () => {
      bot.emptyMeetingTimeoutMs = 10000
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot._onParticipantLeft({ id: 'u1', name: 'Alice' })
      assert.notEqual(bot.emptyMeetingTimer, null)
      bot._onParticipantMapping(1, { id: 'u2', name: 'Bob' })
      assert.equal(bot.emptyMeetingTimer, null)
    })
  })

  describe('MCU/Teams audio', () => {
    it('passes a single server-mixed track through unchanged, in 20 ms frames', () => {
      const bot = makeBot('bigbluebutton')
      assert.equal(bot.isSfu, false)
      bot._startMixer()
      const got = []
      bot.on('audio', (buf) => got.push(buf))
      const input = Array.from({ length: 46 * 20 }, (_, i) => (i * 37) % 2000 - 1000)
      for (let i = 0; i < input.length; i += 46) bot.handleAudioData(0, Buffer.from(Int16Array.from(input.slice(i, i + 46)).buffer))
      const output = got.flatMap(samplesOf)
      assert.ok(got.every(b => b.length === 640))
      assert.deepEqual(output, input.slice(0, output.length))
      assert.equal(output.length, 640)
    })

    // A live Teams call: the track Teams replaced on admission kept rendering zeros
    // next to its successor, and both were forwarded one after the other (2x real
    // time, a slowed-down voice chopped by runs of zeros).
    it('sums the tracks of a Teams page into one stream at the real-time rate', () => {
      const bot = makeBot('teams')
      bot._startMixer()
      bot.hasSeenParticipant = true
      const got = []
      bot.on('audio', (buf) => got.push(buf))
      const voice = Array.from({ length: 46 * 70 }, (_, i) => Math.round(6000 * Math.sin(i / 5)))
      for (let i = 0; i < voice.length; i += 46) {
        bot.handleAudioData(0, frame(0, 46)) // the replaced track, rendering zeros
        bot.handleAudioData(1, Buffer.from(Int16Array.from(voice.slice(i, i + 46)).buffer))
      }
      const output = got.flatMap(samplesOf)
      assert.equal(output.length, Math.floor(voice.length / 320) * 320, 'one track worth of samples, not two')
      assert.deepEqual(output, voice.slice(0, output.length), 'the voice, unchopped')
    })

    it('holds Teams audio until admitted (no streaming from the lobby)', () => {
      const bot = makeBot('teams')
      bot._startMixer()
      let got = null
      bot.on('audio', (buf) => { got = buf })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(got, null, 'no audio while still in the Teams lobby (not admitted)')
      assert.equal(bot.audioMixer.hasTrack('c0:0'), false, 'not even buffered')
      bot.hasSeenParticipant = true // admitted: a participant was detected
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.ok(got && got.length === 640, 'audio flows once admitted')
    })

    it('never derives speakers from the mixer on Teams (they come from the page)', () => {
      const bot = makeBot('teams')
      bot._startMixer()
      const events = []
      bot.on('speakerChanged', (e) => events.push(e))
      bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'm1', name: 'Carol' } })
      bot.handleAudioData(0, frame(9000))
      assert.deepEqual(bot.audioMixer.getStats().tracks.map(t => t.participantId), [null], 'the Teams mapping attributes no track')
      bot.audioMixer.emit('speakerChanged', { type: 'speakerChanged', position: 0, speaker: { id: 'x' } })
      assert.deepEqual(events, [], 'nor is a mixer speaker change forwarded')
    })

    it('forwards Teams page-polled speakerChanged', () => {
      const bot = makeBot('teams')
      let ev = null
      bot.on('speakerChanged', (e) => { ev = e })
      bot.handleJsonMessage({ type: 'speakerChanged', position: 100, speaker: { id: 'm1', name: 'Carol' } })
      assert.equal(ev.speaker.name, 'Carol')
    })

    it('falls back to ASR diarization on a diarizationDegraded signal', () => {
      const bot = makeBot('teams')
      assert.equal(bot.manifest.diarizationMode, 'native')
      let degraded = null
      bot.on('diarization-degraded', (e) => { degraded = e })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'absent' })
      assert.equal(bot.manifest.diarizationMode, 'asr', 'manifest flipped to asr so reconnect-init advertises it')
      assert.equal(bot.diarizationDegraded, true)
      assert.deepEqual(degraded, { mode: 'asr', reason: 'absent' })
    })

    it('the diarizationDegraded handler is idempotent', () => {
      const bot = makeBot('teams')
      let count = 0
      bot.on('diarization-degraded', () => { count++ })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'absent' })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'threw' })
      assert.equal(count, 1, 'only the first degrade is acted on')
    })

    it('a degrade on one bot does NOT leak to another bot of the same type (manifest is per-instance)', () => {
      // _loadManifest deep-clones the require()-cached JSON, so flipping one bot's
      // diarizationMode to 'asr' must not contaminate other bots in the process.
      const a = makeBot('teams')
      const b = makeBot('teams')
      a.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'absent' })
      assert.equal(a.manifest.diarizationMode, 'asr', 'the degraded bot flips')
      assert.equal(b.manifest.diarizationMode, 'native', 'the other bot is unaffected')
      assert.notStrictEqual(a.manifest, b.manifest, 'each bot owns its manifest copy')
    })
  })

  it('auto-leaves via the join watchdog (join-timeout) when no participant is ever seen', (done) => {
    // A never-admitted leave is a FAILURE, emitted as a distinct 'join-timeout'
    // event (not the clean 'meeting-empty') so it is not counted as success.
    const bot = makeBot('visio')
    bot.joinTimeoutMs = 10
    bot.on('join-timeout', () => done())
    bot._armJoinWatchdog()
  })

  it('cancels the join watchdog once a participant is mapped', () => {
    const bot = makeBot('visio')
    bot.joinTimeoutMs = 10000
    bot._armJoinWatchdog()
    assert.notEqual(bot.joinWatchdog, null)
    bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
    assert.equal(bot.joinWatchdog, null)
  })

  it('dispose() is idempotent', async () => {
    const bot = makeBot('visio')
    await bot.dispose()
    assert.equal(bot.disposed, true)
    await bot.dispose() // must not throw / double-run
  })

  it('substitutes {{botName}} in fill rule values', () => {
    const bot = makeBot('visio')
    bot.botName = 'Acme Bot'
    assert.equal(bot._template('{{botName}}'), 'Acme Bot')
    assert.equal(bot._template('static'), 'static')
  })

  // Audio-silence watchdog — once admitted the bot expects a steady PCM flow;
  // a prolonged gap means the capture pipe died, so emit a fatal 'error'.
  describe('audio-silence watchdog', () => {
    it('emits error when no audio arrives within the silence timeout after admission', () => {
      const bot = makeBot('visio')
      let err = null
      bot.on('error', (e) => { err = e })
      // Force a tiny timeout and arm the watchdog as admission would.
      const realNow = Date.now()
      bot.lastAudioAt = realNow - 60000 // long ago
      bot._checkAudioSilence(realNow) // direct check (deterministic, no timers)
      // The watchdog only fires when AUDIO_SILENCE_TIMEOUT_MS > 0 (default 30s).
      assert.ok(err instanceof Error, 'a fatal error is emitted on prolonged silence')
      assert.equal(err.message, 'audio-capture-dead')
    })

    it('does NOT emit error while audio is flowing', () => {
      const bot = makeBot('visio')
      let err = null
      bot.on('error', (e) => { err = e })
      bot.handleAudioData(0, Buffer.alloc(640)) // updates lastAudioAt to now
      bot._checkAudioSilence(Date.now())
      assert.equal(err, null, 'no error while audio is recent')
    })

    it('logs the first audio frame once (latched) and updates lastAudioAt', () => {
      const bot = makeBot('visio')
      bot._startMixer()
      assert.equal(bot.hasSeenAudio, false)
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(bot.hasSeenAudio, true)
      assert.ok(bot.lastAudioAt > 0)
    })

    it('cancels the silence watchdog on dispose', async () => {
      const bot = makeBot('visio')
      bot._armAudioSilenceWatchdog()
      // The watchdog only arms when the timeout is enabled (default on).
      await bot.dispose()
      assert.equal(bot.audioSilenceWatchdog, null)
    })
  })
})

// ---------------------------------------------------------------------------
// Additional coverage: constructor env vars, manifest loading, init wiring,
// page diagnostics, mixer startup, early-audio internals, JSON dispatch,
// participant lifecycle, watchdog guards/idempotency, rule engine and dispose.
// ---------------------------------------------------------------------------

describe('Bot constructor env vars', () => {
  // bot/index.js reads BOT_DISPLAY_NAME / *_TIMEOUT_SECONDS in the constructor,
  // so a plain new Bot() picks up whatever env is set at construction time.
  const saved = {}
  const KEYS = ['BOT_DISPLAY_NAME', 'EMPTY_MEETING_TIMEOUT_SECONDS', 'JOIN_TIMEOUT_SECONDS', 'AUDIO_SILENCE_TIMEOUT_SECONDS']
  beforeEach(() => { KEYS.forEach(k => { saved[k] = process.env[k] }) })
  afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }) })

  it('defaults are applied when env vars are absent', () => {
    KEYS.forEach(k => delete process.env[k])
    const bot = makeBot('visio')
    assert.equal(bot.botName, 'LinTO Bot')
    assert.equal(bot.emptyMeetingTimeoutMs, 60 * 1000)
    assert.equal(bot.joinTimeoutMs, 120 * 1000)
  })

  it('honours non-default BOT_DISPLAY_NAME / timeout values', () => {
    process.env.BOT_DISPLAY_NAME = 'Custom Bot'
    process.env.EMPTY_MEETING_TIMEOUT_SECONDS = '90'
    process.env.JOIN_TIMEOUT_SECONDS = '15'
    const bot = makeBot('visio')
    assert.equal(bot.botName, 'Custom Bot')
    assert.equal(bot.emptyMeetingTimeoutMs, 90 * 1000)
    assert.equal(bot.joinTimeoutMs, 15 * 1000)
  })

  it('a zero timeout falls back to the default (setTimeout(0) would fire immediately)', () => {
    process.env.EMPTY_MEETING_TIMEOUT_SECONDS = '0'
    process.env.JOIN_TIMEOUT_SECONDS = '0'
    const bot = makeBot('visio')
    assert.equal(bot.emptyMeetingTimeoutMs, 60 * 1000)
    assert.equal(bot.joinTimeoutMs, 120 * 1000)
  })

  it('a negative timeout falls back to the default', () => {
    process.env.EMPTY_MEETING_TIMEOUT_SECONDS = '-5'
    const bot = makeBot('visio')
    assert.equal(bot.emptyMeetingTimeoutMs, 60 * 1000)
  })

  it('a non-numeric timeout falls back to the default (no NaN → no immediate fire)', () => {
    process.env.EMPTY_MEETING_TIMEOUT_SECONDS = 'abc'
    process.env.JOIN_TIMEOUT_SECONDS = 'xyz'
    const bot = makeBot('visio')
    assert.equal(bot.emptyMeetingTimeoutMs, 60 * 1000)
    assert.equal(bot.joinTimeoutMs, 120 * 1000)
  })

  it('an empty BOT_DISPLAY_NAME falls back to the default ("" is falsy)', () => {
    process.env.BOT_DISPLAY_NAME = ''
    const bot = makeBot('visio')
    assert.equal(bot.botName, 'LinTO Bot')
  })
})

describe('Bot._loadManifest', () => {
  it('returns null for an unknown botType (allowlist guard)', () => {
    const bot = makeBot('teams')
    assert.equal(bot._loadManifest('not-a-type'), null)
  })

  it('returns null when require() throws for a known type whose file is missing', () => {
    const bot = makeBot('teams')
    // Force the known-type branch then make require() fail by aliasing a known
    // type to a manifest path that does not resolve. We monkeypatch path.join on
    // the module's path require — instead, exercise the catch via a known type
    // present in KNOWN_BOT_TYPES but with the json removed from the require cache
    // and made un-resolvable. Simplest deterministic route: stub require via the
    // manifest path. Here we assert the catch returns null by temporarily
    // breaking the resolved module path.
    const manifestPath = path.join(path.dirname(require.resolve('../bot')), 'manifests', 'jitsi.json')
    const original = require.cache[manifestPath]
    // Poison the cache entry so require throws on next load.
    require.cache[manifestPath] = { id: manifestPath, filename: manifestPath, loaded: true, get exports () { throw new Error('boom manifest') } }
    try {
      assert.equal(bot._loadManifest('jitsi'), null, 'a throwing require is caught and yields null')
    } finally {
      if (original) require.cache[manifestPath] = original
      else delete require.cache[manifestPath]
    }
  })

  it('loads a valid known manifest', () => {
    const bot = makeBot('teams')
    const m = bot._loadManifest('visio')
    assert.equal(m.platformType, 'sfu')
  })
})

describe('Bot.init', () => {
  it('returns false (no work) when the manifest failed to load', async () => {
    const { bot, record } = makeInitBot('teams')
    bot.manifest = null
    assert.equal(await bot.init(), false)
    assert.equal(record.createContextCalls, 0, 'no context created without a manifest')
  })

  it('returns false when the browser pool yields no context', async () => {
    const { bot } = makeInitBot('visio', {}, { noContext: true })
    assert.equal(await bot.init(), false)
    assert.equal(bot.page, null)
  })

  it('wires page diagnostics (console + crash handlers attached)', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    assert.equal(typeof page.handlers.console, 'function', 'console handler attached')
    assert.equal(typeof page.handlers.crash, 'function', 'crash handler attached')
  })

  it('registers the bot on the audio server with the wsPath and binary/json/close handlers', async () => {
    const { bot, record } = makeInitBot('visio')
    await bot.init()
    assert.equal(record.registerBot.length, 1)
    assert.equal(record.registerBot[0].wsPath, bot.wsPath)
    const h = record.registerBot[0].handlers
    assert.equal(typeof h.onBinary, 'function')
    assert.equal(typeof h.onJson, 'function')
    assert.equal(typeof h.onClose, 'function')
  })

  it('injects the WebRTC interceptor script via addInitScript with the loopback ws URL', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    assert.equal(page.calls.addInitScript.length, 1)
    const script = page.calls.addInitScript[0]
    assert.ok(typeof script === 'string' && script.includes('ws://127.0.0.1:9999' + bot.wsPath), 'interceptor script carries the loopback URL')
  })

  it('navigates to the address with a 50s timeout', async () => {
    const { bot, page } = makeInitBot('visio', {}, { address: 'https://room.test/join' })
    await bot.init()
    assert.equal(page.calls.goto.length, 1)
    assert.equal(page.calls.goto[0].url, 'https://room.test/join')
    assert.equal(page.calls.goto[0].opts.timeout, 50000)
  })

  it('starts the AudioMixer for every platform', async () => {
    for (const [type, address] of [['visio'], ['teams'], ['bigbluebutton', 'https://bbb.example.com/room']]) {
      const { bot } = makeInitBot(type, {}, { address })
      await bot.init()
      assert.ok(bot.audioMixer, `${type} init builds a mixer`)
      await bot.dispose()
    }
  })

  it('installs a domain allowlist route only when manifest.blockExternalDomains is set', async () => {
    const allowed = makeInitBot('bigbluebutton', {}, { address: 'https://bbb.example.com/room' })
    await allowed.bot.init()
    assert.equal(allowed.page.calls.route.length, 1, 'bbb (blockExternalDomains) installs a route')

    const notBlocked = makeInitBot('visio')
    await notBlocked.bot.init()
    assert.equal(notBlocked.page.calls.route.length, 0, 'visio (no blockExternalDomains) installs no route')
    await notBlocked.bot.dispose()
  })

  // Runs the domain allowlist route of an initialized bot on one request:
  // 'continue' or 'abort'. frame: the requesting frame ('main', 'sub', or
  // 'none' for a service worker, whose request.frame() throws).
  function allowlistOf (page) {
    const routeHandler = page.calls.route[0].handler
    return (url, { navigation = false, frame = 'main' } = {}) => {
      let action = null
      const request = {
        url: () => url,
        isNavigationRequest: () => navigation,
        frame: () => {
          if (frame === 'none') throw new Error('Service Worker requests do not have an associated frame')
          return frame === 'main' ? page.mainFrame() : {}
        }
      }
      routeHandler({ request: () => request, continue: () => { action = 'continue' }, abort: () => { action = 'abort' } })
      return action
    }
  }

  it('the domain allowlist continues the host and its subdomains, aborts others', async () => {
    const { bot, page } = makeInitBot('bigbluebutton', {}, { address: 'https://bbb.example.com/room' })
    await bot.init()
    const run = allowlistOf(page)
    assert.equal(run('https://bbb.example.com/x'), 'continue', 'exact host allowed')
    assert.equal(run('https://cdn.bbb.example.com/x'), 'continue', 'subdomain allowed')
    assert.equal(run('https://evil.com/x'), 'abort', 'foreign host aborted')
    assert.equal(run('https://allowed.evil.com/x'), 'abort', 'lookalike suffix not matched')
    assert.equal(run('not a url'), 'abort', 'unparseable url aborted (empty host)')
    await bot.dispose()
  })

  // A Greenlight portal sends the page to its BBB server, a Scalelite load
  // balancer redirects it to one of its nodes: with the allowlist pinned to the
  // address host, the BBB client loaded but none of its scripts did (a blank page).
  it('the domain allowlist follows the top-level document to another host, and blocks the rest', async () => {
    const { bot, page } = makeInitBot('bigbluebutton', { mainFrameUrl: 'https://rooms.example.org/rooms/abc/join' },
      { address: 'https://rooms.example.org/rooms/abc/join' })
    await bot.init()
    const run = allowlistOf(page)
    assert.equal(run('https://bbb3.example.net/bigbluebutton/api/join?x', { navigation: true }), 'continue',
      'the portal sends the top-level document to the BBB server')
    assert.equal(run('https://bbb3.example.net/html5client/bundle.js'), 'abort', 'not before it is the document')
    page.mainFrameUrl = 'https://bbb3.example.net/html5client/'
    assert.equal(run('https://bbb3.example.net/html5client/bundle.js'), 'continue', "the document's own requests")
    assert.equal(run('https://static.bbb3.example.net/font.woff'), 'continue', 'and its subdomains')
    assert.equal(run('https://rooms.example.org/api/v1/x'), 'continue', 'the address host still')
    assert.equal(run('https://tracker.example.com/t.js'), 'abort', 'any other host is blocked')
    assert.equal(run('https://evil.example.com/', { navigation: true, frame: 'sub' }), 'abort', 'a frame navigates nowhere else')
    assert.equal(run('https://evil.example.com/', { navigation: true, frame: 'none' }), 'abort', 'a frameless (service worker) request is checked on its host')
    assert.equal(run('https://bbb3.example.net/sw.js', { frame: 'none' }), 'continue')
    await bot.dispose()
  })

  it('a malformed address throws during allowlist setup and disposes', async () => {
    const { bot, record } = makeInitBot('bigbluebutton', {}, { address: 'not-a-valid-url' })
    // bigbluebutton has blockExternalDomains, so new URL(address) is reached.
    assert.equal(await bot.init(), false)
    assert.equal(bot.disposed, true, 'dispose() runs on the init failure path')
    assert.deepEqual(record.unregisterBot, [bot.wsPath])
  })

  it('runs login rules and arms the join watchdog on success', async () => {
    const { bot, page } = makeInitBot('visio')
    assert.equal(await bot.init(), true)
    // visio loginRules: fill + click
    assert.ok(page.calls.locatorActions.some(a => a.action === 'fill'))
    assert.ok(page.calls.locatorActions.some(a => a.action === 'click'))
    assert.notEqual(bot.joinWatchdog, null, 'join watchdog armed after login')
    await bot.dispose()
  })

  it('a non-optional login rule failure is caught and disposes (init returns false)', async () => {
    // Reject the visio submit click; it is not marked optional in the manifest.
    const { bot, record } = makeInitBot('visio', { rejectFor: (action) => action === 'click' })
    assert.equal(await bot.init(), false)
    assert.equal(bot.disposed, true)
    assert.deepEqual(record.unregisterBot, [bot.wsPath])
  })

  it('calls dispose() on any caught error during init (goto throws)', async () => {
    const { bot, record } = makeInitBot('visio', { gotoThrows: true })
    assert.equal(await bot.init(), false)
    assert.equal(bot.disposed, true)
    assert.deepEqual(record.destroyContext, [bot.contextId])
  })
})

describe('Bot._wirePageDiagnostics', () => {
  function loggerSpy (bot) {
    const logs = { warn: [], error: [] }
    bot.logger = bot.logger // keep real logger usage but spy via module logger is internal;
    return logs
  }

  it('surfaces page warnings tagged [WebRTC-Intercept] and ignores other warnings', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    let emittedErr = null
    bot.on('error', (e) => { emittedErr = e })
    // These should not throw and should be handled silently (warning branch).
    page.handlers.console({ type: () => 'warning', text: () => '[WebRTC-Intercept] degraded' })
    page.handlers.console({ type: () => 'warning', text: () => 'unrelated warning' })
    assert.equal(emittedErr, null, 'warnings never emit an error')
    await bot.dispose()
  })

  it('filters out IGNORED_CONSOLE error patterns but lets real errors through (no throw)', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    // Both branches must execute without throwing.
    page.handlers.console({ type: () => 'error', text: () => 'Content Security Policy violated' }) // ignored
    page.handlers.console({ type: () => 'error', text: () => 'net::ERR_FAILED' }) // ignored
    page.handlers.console({ type: () => 'error', text: () => 'ReferenceError: x is not defined' }) // surfaced
    page.handlers.console({ type: () => 'log', text: () => 'plain log' }) // non-error/non-warning -> early return
    await bot.dispose()
  })

  it('a page crash emits a fatal error whose message mentions a page crash', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    let err = null
    bot.on('error', (e) => { err = e })
    page.handlers.crash()
    assert.ok(err instanceof Error)
    assert.ok(err.message.includes('Page crashed'))
    await bot.dispose()
  })
})

describe('Bot._startMixer', () => {
  it('SFU: re-emits the mixer audio and speaker changes on the bot', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    let audioBuf = null
    let speaker = null
    bot.on('audio', (b) => { audioBuf = b })
    bot.on('speakerChanged', (e) => { speaker = e })
    bot.audioMixer.emit('audio', Buffer.alloc(3))
    bot.audioMixer.emit('speakerChanged', { id: 'x' })
    assert.ok(audioBuf && audioBuf.length === 3, 'mixer audio re-emitted')
    assert.deepEqual(speaker, { id: 'x' }, 'mixer speakerChanged re-emitted')
    bot.audioMixer.stop()
  })

  it('MCU/Teams: re-emits the mixer audio only', () => {
    for (const type of ['teams', 'bigbluebutton']) {
      const bot = makeBot(type)
      bot._startMixer()
      let audioBuf = null
      let speaker = null
      bot.on('audio', (b) => { audioBuf = b })
      bot.on('speakerChanged', (e) => { speaker = e })
      bot.audioMixer.emit('audio', Buffer.alloc(3))
      bot.audioMixer.emit('speakerChanged', { id: 'x' })
      assert.ok(audioBuf && audioBuf.length === 3, `${type}: mixer audio re-emitted`)
      assert.equal(speaker, null, `${type}: no speaker from the mixer`)
      bot.audioMixer.stop()
    }
  })
})

describe('Bot.handleJsonMessage dispatch', () => {
  let bot, mixer
  beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

  it('trackAdded is a no-op (no participant created)', () => {
    bot.handleJsonMessage({ type: 'trackAdded', trackIndex: 0 })
    assert.equal(bot.participants.size, 0)
    assert.equal(bot.trackParticipants.size, 0)
  })

  it('participantMapping registers the track and participant', () => {
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'u1', name: 'A' } })
    assert.equal(bot.participants.size, 1)
    assert.deepEqual(bot.trackParticipants.get('c0:0'), { id: 'u1', name: 'A' })
  })

  it('trackRemoved routes to track removal', () => {
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'u1', name: 'A' } })
    bot.handleJsonMessage({ type: 'trackRemoved', trackIndex: 0 })
    assert.equal(bot.trackParticipants.has('c0:0'), false)
  })

  it('participantLeft removes the participant', () => {
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'u1', name: 'A' } })
    bot.handleJsonMessage({ type: 'participantLeft', participant: { id: 'u1', name: 'A' } })
    assert.equal(bot.participants.has('u1'), false)
  })

  it('speakerChanged is re-emitted as-is', () => {
    let ev = null
    bot.on('speakerChanged', (e) => { ev = e })
    bot.handleJsonMessage({ type: 'speakerChanged', speaker: { id: 'm' } })
    assert.deepEqual(ev.speaker, { id: 'm' })
  })

  it('diarizationDegraded routes to the degrade handler', () => {
    let deg = null
    bot.on('diarization-degraded', (e) => { deg = e })
    bot.handleJsonMessage({ type: 'diarizationDegraded', reason: 'gone' })
    assert.ok(deg)
    assert.equal(bot.diarizationDegraded, true)
  })

  it('an unknown message type is tolerated (logged warning, no throw)', () => {
    assert.doesNotThrow(() => bot.handleJsonMessage({ type: 'bogus' }))
    assert.equal(bot.participants.size, 0)
  })
})

describe('Bot._onParticipantMapping edge cases', () => {
  let bot, mixer
  beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

  it('a re-mapping of the same trackIndex updates the name without re-joining', () => {
    let joins = 0
    bot.on('participant-joined', () => { joins++ })
    bot._onParticipantMapping(0, { id: 'u1', name: 'Old' })
    bot._onParticipantMapping(0, { id: 'u1', name: 'New' })
    assert.equal(joins, 1, 'participant-joined fires only once for the same id')
    assert.equal(bot.trackParticipants.get('c0:0').name, 'New', 'track mapping reflects the updated participant')
  })

  it('participant-joined fires once per distinct participant id', () => {
    let joins = 0
    bot.on('participant-joined', () => { joins++ })
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantMapping(1, { id: 'u2', name: 'B' })
    assert.equal(joins, 2)
  })

  it('arms the audio-silence watchdog on the very first mapping (admission)', () => {
    assert.equal(bot.hasSeenParticipant, false)
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    assert.equal(bot.hasSeenParticipant, true)
    assert.notEqual(bot.audioSilenceWatchdog, null, 'silence watchdog armed at admission')
    bot._cancelAudioSilenceWatchdog()
  })
})

describe('Bot._onTrackRemoved', () => {
  let bot, mixer
  beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

  it('deletes the mapping and the mixer track together', () => {
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantMapping(1, { id: 'u1', name: 'A' }) // second track, same participant
    bot._onTrackRemoved(0)
    assert.equal(bot.trackParticipants.has('c0:0'), false)
    assert.deepEqual(mixer.removedTracks, ['c0:0'])
  })

  it('removes the SFU participant once all of their tracks are gone', () => {
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onTrackRemoved(0)
    assert.equal(bot.participants.has('u1'), false, 'participant removed when last track goes')
    assert.deepEqual(mixer.removed, ['u1'])
  })

  it('keeps the SFU participant alive while another of their tracks remains', () => {
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantMapping(1, { id: 'u1', name: 'A' }) // same participant, 2nd track
    bot._onTrackRemoved(0)
    assert.equal(bot.participants.has('u1'), true, 'participant survives while a track remains')
    assert.deepEqual(mixer.removed, [])
  })
})

// A Visio-like join: tracks arrive in render order (8 ms quanta), each mapped to
// its participant by the page poller a little after it starts streaming.
// An SFU reuses a departed participant's receiver for the next subscription:
// the page maps the same track again (see webrtc-intercept, reused receivers).
describe('Bot reused receiver', () => {
  it('a participant back on their former track is joined again, which cancels the empty-meeting timer', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const seen = []
    bot.on('participant-joined', (p) => seen.push('join ' + p.identity))
    bot.on('participant-left', (p) => seen.push('left ' + p.identity))
    const map = (trackIndex, id) => bot.handleJsonMessage({ type: 'participantMapping', trackIndex, participant: { id, name: id } }, 1)
    const left = (id) => bot.handleJsonMessage({ type: 'participantLeft', participant: { id, name: id } }, 1)
    map(0, 'alice')
    map(1, 'bob')
    bot.handleAudioData(1, frame(3000), 1)
    left('bob')
    assert.equal(bot.trackParticipants.has('c1:1'), false, "the track is no longer Bob's")
    assert.deepEqual(bot.audioMixer.getStats().tracks.find(t => t.id === 'c1:1').participantId, null)
    left('alice')
    assert.notEqual(bot.emptyMeetingTimer, null, 'the meeting looks empty')
    for (let i = 0; i < 10; i++) bot.handleAudioData(1, frame(3000), 1) // Bob is back, on the same track
    map(1, 'bob') // the page maps it again
    assert.deepEqual(seen, ['join alice', 'join bob', 'left bob', 'left alice', 'join bob'])
    assert.equal(bot.emptyMeetingTimer, null, 'no longer empty')
    assert.deepEqual(bot.trackParticipants.get('c1:1'), { id: 'bob', name: 'bob' })
    assert.equal(bot.audioMixer.getStats().tracks.find(t => t.id === 'c1:1').participantId, 'bob')
    bot._cancelAudioHealthLog()
  })

  it('the track taken over by somebody else is theirs, and its former participant is not removed twice', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const seen = []
    bot.on('participant-joined', (p) => seen.push('join ' + p.identity))
    bot.on('participant-left', (p) => seen.push('left ' + p.identity))
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 1, participant: { id: 'bob', name: 'Bob' } }, 1)
    // The page: Carol's mapping, then Bob's leave (same poll).
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 1, participant: { id: 'carol', name: 'Carol' } }, 1)
    bot.handleJsonMessage({ type: 'participantLeft', participant: { id: 'bob', name: 'Bob' } }, 1)
    bot.handleJsonMessage({ type: 'trackRemoved', trackIndex: 1 }, 1)
    assert.deepEqual(seen, ['join bob', 'join carol', 'left bob', 'left carol'])
    bot._cancelAudioHealthLog()
    bot._cancelEmptyMeetingTimer()
  })
})

describe('Bot trackUnmapped', () => {
  it("stops attributing the track at once: the new owner's words are unattributed, then theirs with 'mapped'", () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const ev = []
    bot.on('speakerChanged', (e) => ev.push([e.speaker && e.speaker.id, e.reason, e.track]))
    const map = (id) => bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id, name: id } }, 1)
    map('alice')
    for (let i = 0; i < 5; i++) bot.handleAudioData(0, frame(3000), 1) // Alice
    bot.handleJsonMessage({ type: 'trackUnmapped', trackIndex: 0 }, 1) // her receiver is reused
    assert.equal(bot.trackParticipants.has('c1:0'), false)
    assert.equal(bot.participants.has('alice'), true, 'Alice stays in the meeting')
    for (let i = 0; i < 25; i++) bot.handleAudioData(0, frame(3000), 1) // Bob, not mapped yet
    map('bob')
    assert.deepEqual(ev, [['alice', undefined, undefined], [null, 'unattributed', 'c1:0.1'], ['bob', 'mapped', 'c1:0.1']])
    bot._cancelAudioHealthLog()
  })

  it('gives a track whose owner was never found a new tag when its receiver is reused', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const ev = []
    bot.on('speakerChanged', (e) => ev.push([e.speaker && e.speaker.id, e.reason, e.track]))
    for (let i = 0; i < 25; i++) bot.handleAudioData(0, frame(3000), 1) // A, never mapped
    bot.handleJsonMessage({ type: 'trackUnmapped', trackIndex: 0 }, 1)
    for (let i = 0; i < 25; i++) bot.handleAudioData(0, frame(3000), 1) // B
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'bob', name: 'Bob' } }, 1)
    assert.deepEqual(ev, [[null, 'unattributed', 'c1:0.0'], [null, 'unattributed', 'c1:0.1'], ['bob', 'mapped', 'c1:0.1']])
    bot._cancelAudioHealthLog()
  })

  it('is a no-op for an unknown track, and on MCU/Teams', () => {
    const bot = makeBot('teams')
    bot._startMixer()
    assert.doesNotThrow(() => bot.handleJsonMessage({ type: 'trackUnmapped', trackIndex: 7 }, 1))
    assert.equal(bot.audioMixer.hasTrack('c1:7'), false, 'no mixer track created')
    bot._cancelAudioHealthLog()
  })
})

describe('Bot SFU join sequence (first words)', () => {
  it('a newcomer speaking before being mapped is "unknown", then theirs as soon as the mapping arrives', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const events = []
    bot.on('participant-joined', (p) => events.push(['join', p.name]))
    bot.on('speakerChanged', (e) => events.push([e.position, e.speaker && e.speaker.name]))
    const map = (trackIndex, id, name) => bot.handleJsonMessage({ type: 'participantMapping', trackIndex, participant: { id, name } })

    map(0, 'u1', 'Alice')
    for (let q = 0; q < 60; q++) bot.handleAudioData(0, frame(5000, 128)) // Alice speaks, 480 ms
    // Bob's track starts streaming; he speaks while Alice is quiet, not mapped yet.
    for (let q = 0; q < 32; q++) { bot.handleAudioData(0, frame(0, 128)); bot.handleAudioData(1, frame(5000, 128)) }
    map(1, 'u2', 'Bob') // the poller maps his track
    for (let q = 0; q < 60; q++) { bot.handleAudioData(0, frame(0, 128)); bot.handleAudioData(1, frame(5000, 128)) }

    assert.deepEqual(events, [
      ['join', 'Alice'],
      [0, 'Alice'],
      [480, null], // Bob's first frame: no longer Alice (reason 'unattributed')
      ['join', 'Bob'],
      [720, 'Bob'] // the moment the mapping arrives, Bob's join first
    ])
  })
})

describe('Bot SFU join sequence, as the Transcriber receives it', () => {
  const TranscriberStream = require('../bot/TranscriberStream')
  const EventEmitter = require('events')

  it("sends the unknown-speaker null with reason 'unattributed', then the newcomer at once with reason 'mapped'", () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const ws = new EventEmitter()
    ws.readyState = TranscriberStream.OPEN
    ws.sent = []
    ws.send = (data) => ws.sent.push(data)
    const stream = new TranscriberStream(ws, bot)
    ws.emit('open')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    const map = (trackIndex, id, name) => bot.handleJsonMessage({ type: 'participantMapping', trackIndex, participant: { id, name } })

    map(0, 'u1', 'Alice')
    for (let q = 0; q < 60; q++) bot.handleAudioData(0, frame(5000, 128))
    for (let q = 0; q < 32; q++) { bot.handleAudioData(0, frame(0, 128)); bot.handleAudioData(1, frame(5000, 128)) }
    map(1, 'u2', 'Bob')

    const control = ws.sent.filter(x => typeof x === 'string').map(JSON.parse).filter(f => f.type !== 'init')
    assert.deepEqual(control, [
      { type: 'participant', action: 'join', participant: { id: 'u1', name: 'Alice' } },
      { type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } },
      { type: 'speakerChanged', position: 480, speaker: null, reason: 'unattributed', track: 'c0:1.0' },
      { type: 'participant', action: 'join', participant: { id: 'u2', name: 'Bob' } },
      { type: 'speakerChanged', position: 720, speaker: { id: 'u2', name: 'Bob' }, reason: 'mapped', track: 'c0:1.0' }
    ])
    stream.dispose()
  })
})

describe('Bot audio health log', () => {
  const { logger } = require('live-srt-lib')
  let infos, realInfo
  beforeEach(() => { infos = []; realInfo = logger.info; logger.info = (m) => { infos.push(String(m)) } })
  afterEach(() => { logger.info = realInfo })
  const healthLines = () => infos.filter(m => m.includes('audio health'))

  it('is armed with the mixer, every 60 s, and cleared on dispose', async () => {
    const bot = makeBot('teams')
    const delays = []
    const realSetInterval = global.setInterval
    global.setInterval = (fn, ms) => { delays.push(ms); return realSetInterval(fn, ms) }
    try { bot._startMixer() } finally { global.setInterval = realSetInterval }
    assert.deepEqual(delays, [60000])
    assert.notEqual(bot.audioHealthTimer, null)
    await bot.dispose()
    assert.equal(bot.audioHealthTimer, null)
  })

  it('reports each track input rate, the output against the wall clock, and PCM of removed tracks', () => {
    const bot = makeBot('teams')
    bot._startMixer()
    bot.hasSeenParticipant = true
    const t0 = bot._audioHealth.at
    // One second of two tracks, delivered as the page does (8 ms quanta in render order).
    for (let i = 0; i < 125; i++) { bot.handleAudioData(0, frame(0, 128)); bot.handleAudioData(1, frame(100, 128)) }
    bot._logAudioHealth(t0 + 1000)
    assert.equal(healthLines()[0], `Bot[${bot.contextId}]: audio health over 1s: output 16000 samples/s (x1.00 real time), ` +
      '2/2 tracks flowing [c0:0 16000/s, c0:1 16000/s], 0 samples dropped, 0 stalls, 0 frames of removed tracks ignored')
    assert.match(bot.contextId, /^s_c_\d+$/)
    // The next window only counts what happened since.
    bot.handleJsonMessage({ type: 'trackRemoved', trackIndex: 0 })
    for (let i = 0; i < 50; i++) { bot.handleAudioData(0, frame(0, 128)); bot.handleAudioData(1, frame(100, 128)) }
    bot._logAudioHealth(t0 + 2000)
    assert.equal(healthLines()[1], `Bot[${bot.contextId}]: audio health over 1s: output 6400 samples/s (x0.40 real time), ` +
      '1/1 tracks flowing [c0:1 6400/s], 0 samples dropped, 0 stalls, 50 frames of removed tracks ignored')
    bot._cancelAudioHealthLog()
  })

  it('shows a track that stopped delivering next to one that flows', () => {
    const bot = makeBot('visio')
    bot._startMixer()
    const t0 = bot._audioHealth.at
    bot.handleAudioData(0, frame(1, 128))
    bot.handleAudioData(1, frame(1, 128))
    for (let i = 0; i < 124; i++) bot.handleAudioData(0, frame(1, 128)) // track 1 went silent
    bot._logAudioHealth(t0 + 1000)
    assert.ok(healthLines()[0].includes('1/2 tracks flowing [c0:0 16000/s, c0:1 idle 128/s], 0 samples dropped, 1 stalls'), healthLines()[0])
    bot._cancelAudioHealthLog()
  })
})

// The participant pollers only look in the page's top-level document: a meeting
// client living in a sub-frame would leave the bot hearing tracks and finding
// nobody (until the join watchdog), with nothing in the logs saying why.
describe('Bot tracks heard but no participant found', () => {
  const { logger } = require('live-srt-lib')
  let warns, realWarn
  beforeEach(() => { warns = []; realWarn = logger.warn; logger.warn = (m) => { warns.push(String(m)) } })
  afterEach(() => { logger.warn = realWarn })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const noParticipant = () => warns.filter(w => w.includes('no participant found'))

  it('warns once when tracks stream and no participant is found in time', async () => {
    const bot = makeBot('teams')
    bot.noParticipantWarnMs = 20
    bot.handleAudioData(0, frame(0), 1)
    bot.handleAudioData(1, frame(0), 1)
    await wait(40)
    bot.handleAudioData(0, frame(0), 1)
    await wait(40)
    assert.equal(noParticipant().length, 1)
    assert.ok(noParticipant()[0].includes('2 track(s) heard for 0.02s') && noParticipant()[0].includes('top-level document'), noParticipant()[0])
    await bot.dispose()
  })

  it('does not warn once a participant is found', async () => {
    const bot = makeBot('visio')
    bot._startMixer()
    bot.noParticipantWarnMs = 20
    bot.handleAudioData(0, frame(0), 1)
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'u1', name: 'A' } }, 1)
    await wait(40)
    assert.equal(noParticipant().length, 0)
    await bot.dispose()
  })

  it('does not warn after dispose', async () => {
    const bot = makeBot('visio')
    bot.noParticipantWarnMs = 20
    bot.handleAudioData(0, frame(0), 1)
    await bot.dispose()
    await wait(40)
    assert.equal(noParticipant().length, 0)
  })
})

describe('Bot while disposing', () => {
  it('ignores loopback messages once disposing (no empty-meeting timer outliving the bot)', async () => {
    const { bot, page } = makeInitBot('visio')
    await bot.init()
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    let release
    page.locator = () => ({ click: () => new Promise((resolve) => { release = resolve }) }) // a slow leave rule
    const disposing = bot.dispose()
    let left = 0
    bot.on('participant-left', () => { left++ })
    bot.handleJsonMessage({ type: 'participantLeft', participant: { id: 'u1', name: 'A' } })
    bot.handleAudioData(0, Buffer.alloc(640))
    assert.equal(left, 0)
    assert.equal(bot.emptyMeetingTimer, null)
    release()
    await disposing
  })
})

describe('Bot removed tracks', () => {
  const { logger } = require('live-srt-lib')
  let warns, realWarn
  beforeEach(() => { warns = []; realWarn = logger.warn; logger.warn = (m) => { warns.push(String(m)) } })
  afterEach(() => { logger.warn = realWarn })

  it('ignores PCM of a removed SFU track, counts it and warns once', () => {
    const bot = makeBot('visio'); const mixer = makeFakeMixer(); bot.audioMixer = mixer
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot.handleAudioData(0, Buffer.alloc(640))
    bot._onTrackRemoved(0)
    bot.handleAudioData(0, Buffer.alloc(640))
    bot.handleAudioData(0, Buffer.alloc(640))
    assert.equal(mixer.added.length, 1, 'only the live frame was mixed')
    assert.equal(bot.removedTracks.get('c0:0'), 2)
    assert.equal(warns.filter(w => w.includes('removed track c0:0')).length, 1)
  })

  it('ignores PCM of a removed Teams track (the lobby track Teams replaces on admission)', () => {
    const bot = makeBot('teams')
    bot._startMixer()
    bot.hasSeenParticipant = true
    const got = []
    bot.on('audio', (buf) => got.push(buf))
    bot.handleAudioData(0, Buffer.alloc(640))
    bot.handleJsonMessage({ type: 'trackRemoved', trackIndex: 0 })
    bot.handleAudioData(0, Buffer.alloc(640)) // the ended track keeps rendering zeros
    bot.handleAudioData(1, Buffer.alloc(640)) // its replacement
    assert.equal(got.length, 2)
  })

  it('does not count ignored PCM as live audio for the silence watchdog', () => {
    const bot = makeBot('visio'); bot.audioMixer = makeFakeMixer()
    bot._onTrackRemoved(0)
    bot.lastAudioAt = 0
    bot.handleAudioData(0, Buffer.alloc(640))
    assert.equal(bot.lastAudioAt, 0)
  })

  it('only the removed track of that connection is ignored, and the state goes with the connection', () => {
    const bot = makeBot('visio'); const mixer = makeFakeMixer(); bot.audioMixer = mixer
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' }, 1)
    bot._onParticipantMapping(0, { id: 'u2', name: 'B' }, 2)
    bot._onTrackRemoved(0, 1)
    bot.handleAudioData(0, Buffer.alloc(640), 2)
    assert.deepEqual(mixer.added.map(a => a.key), ['c2:0'])
    bot.notifyAudioPipeClosed(1)
    assert.equal(bot.removedTracks.has('c1:0'), false)
  })
})

describe('Bot loopback connections', () => {
  let bot, mixer
  beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

  it('keeps apart same-index tracks of different connections (each document numbers its tracks from 0)', () => {
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' }, 1)
    bot.handleAudioData(0, Buffer.alloc(640), 2) // another document's track 0: not u1's
    bot.handleAudioData(0, Buffer.alloc(640), 1)
    assert.deepEqual(mixer.added.map(a => a.key), ['c2:0', 'c1:0'])
    assert.deepEqual([...mixer.attributed.keys()], ['c1:0'])
  })

  it('a track removal only affects the connection it came from', () => {
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' }, 1)
    bot._onParticipantMapping(0, { id: 'u2', name: 'B' }, 2)
    bot._onTrackRemoved(0, 2)
    assert.equal(bot.trackParticipants.has('c1:0'), true)
    assert.equal(bot.trackParticipants.has('c2:0'), false)
    assert.equal(bot.participants.has('u1'), true)
    assert.equal(bot.participants.has('u2'), false)
  })

  it('forgets the tracks of a closed connection but keeps the participants', () => {
    let left = 0
    bot.on('participant-left', () => { left++ })
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' }, 1)
    bot.handleAudioData(1, Buffer.alloc(640), 1) // unmapped
    bot._onParticipantMapping(0, { id: 'u2', name: 'B' }, 2)
    bot.notifyAudioPipeClosed(1)
    assert.equal(bot.trackParticipants.has('c1:0'), false)
    assert.deepEqual(mixer.removedTracks.sort(), ['c1:0', 'c1:1'], 'its tracks leave the mix')
    assert.equal(bot.trackParticipants.has('c2:0'), true, 'other connections untouched')
    assert.deepEqual([...bot.participants.keys()], ['u1', 'u2'])
    assert.equal(left, 0, 'a dropped connection is not a participant leave')
  })

  it('init wires the connection id of every loopback message into the track keys', async () => {
    const { bot: initBot, record } = makeInitBot('visio')
    await initBot.init()
    const h = record.registerBot[0].handlers
    h.onJson({ type: 'participantMapping', trackIndex: 3, participant: { id: 'u1', name: 'A' } }, 7)
    assert.equal(initBot.trackParticipants.has('c7:3'), true)
    h.onBinary(3, Buffer.alloc(640), 7)
    assert.deepEqual(initBot.audioMixer.getStats().tracks.map(t => [t.id, t.participantId]), [['c7:3', 'u1']])
    h.onClose(7)
    assert.equal(initBot.trackParticipants.has('c7:3'), false)
    assert.equal(initBot.audioMixer.hasTrack('c7:3'), false)
    await initBot.dispose()
  })
})

describe('Bot._onParticipantLeft', () => {
  it('removes the participant by id', () => {
    const bot = makeBot('visio'); bot.audioMixer = makeFakeMixer()
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantLeft({ id: 'u1', name: 'A' })
    assert.equal(bot.participants.has('u1'), false)
  })

  it('tolerates a null participant (no throw)', () => {
    const bot = makeBot('visio')
    assert.doesNotThrow(() => bot._onParticipantLeft(null))
  })

  it('tolerates a participant object without an id', () => {
    const bot = makeBot('visio')
    assert.doesNotThrow(() => bot._onParticipantLeft({ name: 'anon' }))
  })
})

describe('Bot._removeParticipant', () => {
  it('is a no-op for an unknown participant (idempotent)', () => {
    const bot = makeBot('visio'); const mixer = makeFakeMixer(); bot.audioMixer = mixer
    let left = 0
    bot.on('participant-left', () => { left++ })
    bot._removeParticipant('ghost', 'Ghost')
    assert.equal(left, 0, 'no event for an absent participant')
    assert.deepEqual(mixer.removed, [])
  })

  it('calls mixer.removeParticipant() for a known participant', () => {
    const bot = makeBot('visio'); const mixer = makeFakeMixer(); bot.audioMixer = mixer
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._removeParticipant('u1', 'A')
    assert.deepEqual(mixer.removed, ['u1'])
    assert.equal(bot.participants.has('u1'), false)
  })
})

describe('Bot._onDiarizationDegraded', () => {
  it('flips manifest.diarizationMode to asr only on the first degrade', () => {
    const bot = makeBot('teams')
    // _loadManifest deep-clones the manifest, so each bot starts at 'native'
    // regardless of test order (no shared require()-cached object to reset).
    assert.equal(bot.manifest.diarizationMode, 'native')
    bot._onDiarizationDegraded({ reason: 'x' })
    assert.equal(bot.manifest.diarizationMode, 'asr')
    // second degrade is ignored (latched) — mode stays asr, no re-flip logic runs.
    bot._onDiarizationDegraded({ reason: 'y' })
    assert.equal(bot.manifest.diarizationMode, 'asr')
  })

  it('defaults the reason to "unknown" when the field is missing', () => {
    const bot = makeBot('teams')
    let ev = null
    bot.on('diarization-degraded', (e) => { ev = e })
    bot._onDiarizationDegraded({})
    assert.equal(ev.reason, 'unknown')
  })

  it('ignores a second degrade even with a different reason', () => {
    const bot = makeBot('teams')
    let count = 0
    bot.on('diarization-degraded', () => { count++ })
    bot._onDiarizationDegraded({ reason: 'first' })
    bot._onDiarizationDegraded({ reason: 'second' })
    assert.equal(count, 1)
  })

  it('on a non-native manifest still latches and emits but does not re-flip the mode', () => {
    const bot = makeBot('bigbluebutton') // diarizationMode: 'asr'
    let ev = null
    bot.on('diarization-degraded', (e) => { ev = e })
    bot._onDiarizationDegraded({ reason: 'z' })
    assert.equal(bot.manifest.diarizationMode, 'asr')
    assert.equal(bot.diarizationDegraded, true)
    assert.deepEqual(ev, { mode: 'asr', reason: 'z' })
  })
})

describe('Bot._checkEmptyMeeting guards', () => {
  it('does nothing before any participant was ever seen', () => {
    const bot = makeBot('visio')
    bot._checkEmptyMeeting()
    assert.equal(bot.emptyMeetingTimer, null)
  })

  it('does nothing while participants are still present', () => {
    const bot = makeBot('visio'); bot.audioMixer = makeFakeMixer()
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._checkEmptyMeeting() // size > 0
    assert.equal(bot.emptyMeetingTimer, null)
  })

  it('does not re-arm when a timer is already running (idempotent)', () => {
    const bot = makeBot('visio'); bot.audioMixer = makeFakeMixer()
    bot.emptyMeetingTimeoutMs = 10000
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantLeft({ id: 'u1', name: 'A' }) // arms the timer
    const t = bot.emptyMeetingTimer
    assert.notEqual(t, null)
    bot._checkEmptyMeeting() // already empty + timer set
    assert.strictEqual(bot.emptyMeetingTimer, t, 'no second timer')
    bot._cancelEmptyMeetingTimer()
  })
})

describe('Bot._armJoinWatchdog guards', () => {
  it('does not re-arm when already armed (idempotent)', () => {
    const bot = makeBot('visio')
    bot.joinTimeoutMs = 10000
    bot._armJoinWatchdog()
    const w = bot.joinWatchdog
    bot._armJoinWatchdog()
    assert.strictEqual(bot.joinWatchdog, w)
    bot._cancelJoinWatchdog()
  })

  it('does not arm once admitted', () => {
    const bot = makeBot('visio')
    bot.admitted = true
    bot._armJoinWatchdog()
    assert.equal(bot.joinWatchdog, null)
  })
})

// BBB has no participant poller (one mixed MCU stream, no roster the page script
// reads): no participant was ever found, so the join watchdog made every BBB bot
// leave with join-timeout, the "no participant found" warning fired on every one,
// and nothing ever told that the meeting was over.
describe('Bot admission and meeting end without a participant poller (BBB)', () => {
  const { logger } = require('live-srt-lib')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let warns, realWarn
  beforeEach(() => { warns = []; realWarn = logger.warn; logger.warn = (m) => { warns.push(String(m)) } })
  afterEach(() => { logger.warn = realWarn })

  // A BBB bot past its login rules, with its loopback handlers.
  async function joinedBbb (pageOpts = {}) {
    const { bot, record } = makeInitBot('bigbluebutton', pageOpts, { address: 'https://bbb.example.com/room' })
    bot.joinTimeoutMs = 60
    bot.noParticipantWarnMs = 30
    assert.equal(await bot.init(), true)
    const { onBinary, onJson, onClose } = record.registerBot[0].handlers
    return { bot, pcm: onBinary, json: onJson, closed: onClose }
  }

  it('declares it in its manifest; the platforms with a participant poller do not', () => {
    assert.equal(require('../bot/manifests/bigbluebutton.json').admission, 'audio')
    for (const name of ['jitsi', 'teams', 'visio']) assert.equal(require(`../bot/manifests/${name}.json`).admission, undefined)
  })

  it('is admitted by the meeting audio after the login rules: no join timeout, no no-participant warning', async () => {
    const { bot, pcm } = await joinedBbb()
    let timedOut = false
    bot.on('join-timeout', () => { timedOut = true })
    for (let i = 0; i < 10; i++) pcm(0, frame(1000), 1)
    assert.equal(bot.admitted, true)
    assert.equal(bot.joinWatchdog, null)
    assert.notEqual(bot.audioSilenceWatchdog, null, 'a steady PCM flow is expected from now on')
    await sleep(100)
    assert.equal(timedOut, false)
    assert.deepEqual(warns.filter((w) => /no participant found|join watchdog/.test(w)), [])
    await bot.dispose()
  })

  it('audio before the login rules completed is no admission, and no participant is looked for', () => {
    const bot = makeBot('bigbluebutton')
    bot._startMixer()
    bot.handleAudioData(0, frame(1000), 1)
    assert.equal(bot.admitted, false)
    assert.equal(bot.noParticipantTimer, null)
    bot._cancelAudioHealthLog()
  })

  it('without meeting audio, the join watchdog still ends it, saying what was missing', async () => {
    const { bot } = await joinedBbb()
    await new Promise((resolve) => bot.on('join-timeout', resolve))
    assert.ok(warns.some((w) => w.includes('no meeting audio within')), warns.join(' | '))
    await bot.dispose()
  })

  it('leaves (meeting-empty) once the client closed the connection of its last track, unless the audio comes back', async () => {
    const { bot, pcm, json } = await joinedBbb()
    bot.emptyMeetingTimeoutMs = 40
    const events = []
    bot.on('meeting-empty', () => events.push('meeting-empty'))
    pcm(0, frame(1000), 1)
    json({ type: 'trackRemoved', trackIndex: 0, connectionClosed: true }, 1)
    assert.notEqual(bot.emptyMeetingTimer, null)
    pcm(1, frame(1000), 1) // the client reconnected its audio: a new track
    assert.equal(bot.emptyMeetingTimer, null)
    await sleep(60)
    assert.deepEqual(events, [])
    json({ type: 'trackRemoved', trackIndex: 1, connectionClosed: true }, 1)
    await sleep(60)
    assert.deepEqual(events, ['meeting-empty'])
    await bot.dispose()
  })

  it('leaves (meeting-empty) once the meeting page was left (pageLeft, then its connection closed)', async () => {
    const { bot, pcm, json, closed } = await joinedBbb()
    bot.emptyMeetingTimeoutMs = 40
    const left = new Promise((resolve) => bot.on('meeting-empty', resolve))
    pcm(0, frame(1000), 1)
    json({ type: 'pageLeft' }, 1)
    closed(1)
    await left
    await bot.dispose()
  })

  it('while that leave is pending, the silence watchdog reports no dead pipe', async () => {
    const { bot, pcm, json } = await joinedBbb()
    const errors = []
    bot.on('error', (e) => errors.push(e.message))
    pcm(0, frame(1000), 1)
    json({ type: 'trackRemoved', trackIndex: 0, connectionClosed: true }, 1)
    bot._checkAudioSilence(Date.now() + 10 * 60 * 1000)
    assert.deepEqual(errors, [])
    await bot.dispose()
  })

  // Any loss of the meeting audio used to end the session, a failure on the
  // bot's side (listen-only not reconnected) included, with the silence
  // watchdog neutralised: the user could not tell, nor relaunch.
  for (const [label, lose] of [
    ['its last track stopped without its connection closed (renegotiation)', (b) => b.json({ type: 'trackRemoved', trackIndex: 0, connectionClosed: false }, 1)],
    ['its loopback connection dropped, the page not left', (b) => b.closed(1)]
  ]) {
    it(`meeting audio lost with no sign that the meeting ended (${label}): no session end, an audio-lost error`, async () => {
      const b = await joinedBbb()
      const { bot, pcm } = b
      bot.emptyMeetingTimeoutMs = 40
      const events = []
      bot.on('meeting-empty', () => events.push('meeting-empty'))
      bot.on('error', (e) => events.push('error ' + e.message))
      pcm(0, frame(1000), 1)
      lose(b)
      await sleep(60)
      assert.equal(bot.emptyMeetingTimer, null)
      assert.deepEqual(events, [])
      assert.ok(warns.some((w) => w.includes('meeting audio gone with no sign that the meeting ended')), warns.join(' | '))
      bot._checkAudioSilence(Date.now() + 10 * 60 * 1000)
      assert.deepEqual(events, ['error audio-lost'])
      await bot.dispose()
    })
  }

  it('a bot whose meeting audio still flows but whose capture stalled still reports audio-capture-dead', async () => {
    const { bot, pcm } = await joinedBbb()
    const errors = []
    bot.on('error', (e) => errors.push(e.message))
    pcm(0, frame(1000), 1)
    bot._checkAudioSilence(Date.now() + 10 * 60 * 1000)
    assert.deepEqual(errors, ['audio-capture-dead'])
    await bot.dispose()
  })

  it("leaves as soon as the manifest's meeting-ended element is shown; a failing check is skipped", async () => {
    let shown = 0
    const { bot, pcm } = await joinedBbb({
      count: (selector) => {
        if (shown < 0) throw new Error('navigating')
        return selector === '[data-test="meetingEndedModal"]' ? shown : 0
      }
    })
    bot.meetingEndCheckMs = 10
    const ended = []
    bot.on('meeting-empty', () => ended.push('meeting-empty'))
    pcm(0, frame(1000), 1) // admitted: the check starts
    shown = -1
    await sleep(40)
    shown = 0
    await sleep(40)
    assert.deepEqual(ended, [])
    shown = 1
    await sleep(40)
    assert.deepEqual(ended, ['meeting-empty'], 'once')
    assert.equal(bot.meetingEndTimer, null)
    await bot.dispose()
  })

  it('Teams and SFU bots are still admitted by a participant only', async () => {
    for (const type of ['visio', 'teams']) {
      const { bot, record } = makeInitBot(type)
      bot.joinTimeoutMs = 10000
      assert.equal(await bot.init(), true)
      record.registerBot[0].handlers.onBinary(0, frame(1000), 1)
      assert.equal(bot.admitted, false, type)
      assert.notEqual(bot.joinWatchdog, null, type)
      assert.notEqual(bot.noParticipantTimer, null, `${type}: a participant is looked for`)
      await bot.dispose()
    }
  })
})

describe('Bot audio-silence watchdog arm/check/cancel', () => {
  it('_armAudioSilenceWatchdog is idempotent', () => {
    const bot = makeBot('visio')
    bot._armAudioSilenceWatchdog()
    const w = bot.audioSilenceWatchdog
    assert.notEqual(w, null, 'armed when timeout enabled (default 30s)')
    bot._armAudioSilenceWatchdog()
    assert.strictEqual(bot.audioSilenceWatchdog, w)
    bot._cancelAudioSilenceWatchdog()
  })

  it('does not arm when disposed', async () => {
    const bot = makeBot('visio')
    await bot.dispose()
    bot._armAudioSilenceWatchdog()
    assert.equal(bot.audioSilenceWatchdog, null)
  })

  it('initializes lastAudioAt on arm so a slow first frame does not trip it', () => {
    const bot = makeBot('visio')
    bot.lastAudioAt = 0
    const before = Date.now()
    bot._armAudioSilenceWatchdog()
    assert.ok(bot.lastAudioAt >= before, 'admission resets the audio clock')
    bot._cancelAudioSilenceWatchdog()
  })

  it('_checkAudioSilence ignores the call when disposed', () => {
    const bot = makeBot('visio')
    let err = null
    bot.on('error', (e) => { err = e })
    bot.disposed = true
    bot.lastAudioAt = Date.now() - 60000
    bot._checkAudioSilence(Date.now())
    assert.equal(err, null, 'disposed bot never emits the silence error')
  })

  it('_checkAudioSilence cancels the watchdog when it fires', () => {
    const bot = makeBot('visio')
    bot.on('error', () => {})
    bot._armAudioSilenceWatchdog()
    assert.notEqual(bot.audioSilenceWatchdog, null)
    bot.lastAudioAt = Date.now() - 60000
    bot._checkAudioSilence(Date.now())
    assert.equal(bot.audioSilenceWatchdog, null, 'watchdog cleared after firing')
  })

  it('_cancelAudioSilenceWatchdog returns early when no watchdog is set', () => {
    const bot = makeBot('visio')
    assert.equal(bot.audioSilenceWatchdog, null)
    assert.doesNotThrow(() => bot._cancelAudioSilenceWatchdog())
  })
})

describe('Bot.notifyAudioPipeClosed', () => {
  it('returns early (no work) when disposed', () => {
    const bot = makeBot('visio')
    bot.disposed = true
    assert.doesNotThrow(() => bot.notifyAudioPipeClosed())
  })

  it('does not throw and emits nothing fatal when not disposed', () => {
    const bot = makeBot('visio')
    let err = null
    bot.on('error', (e) => { err = e })
    bot.notifyAudioPipeClosed()
    assert.equal(err, null, 'a closed loopback is logged at debug, not fatal')
  })
})

describe('Bot.getParticipantsList', () => {
  it('returns {id, name} entries as a fresh array (shallow copy)', () => {
    const bot = makeBot('visio'); bot.audioMixer = makeFakeMixer()
    bot._onParticipantMapping(0, { id: 'u1', name: 'A' })
    bot._onParticipantMapping(1, { id: 'u2', name: 'B' })
    const list = bot.getParticipantsList()
    assert.deepEqual(list, [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }])
    // Mutating the returned list must not affect internal state.
    list.push({ id: 'u3', name: 'C' })
    assert.equal(bot.participants.size, 2, 'internal map untouched by mutating the copy')
  })
})

describe('Bot.execRules / execRule', () => {
  function botWithPage (pageOpts = {}) {
    const bot = makeBot('visio')
    bot.page = makeFakePage(pageOpts)
    return bot
  }

  it('iterating over null/undefined rules is a no-op', async () => {
    const bot = botWithPage()
    await bot.execRules(null)
    await bot.execRules(undefined)
    assert.equal(bot.page.calls.locatorActions.length, 0)
  })

  it('an optional rule failure is swallowed (no throw)', async () => {
    const bot = botWithPage({ rejectFor: (a) => a === 'click' })
    await assert.doesNotReject(() => bot.execRules([{ action: 'click', selector: '#x', optional: true }]))
  })

  it('suppressErrors swallows even a non-optional failure', async () => {
    const bot = botWithPage({ rejectFor: (a) => a === 'click' })
    await assert.doesNotReject(() => bot.execRules([{ action: 'click', selector: '#x' }], true))
  })

  it('a non-optional failure re-throws when not suppressed', async () => {
    const bot = botWithPage({ rejectFor: (a) => a === 'click' })
    await assert.rejects(() => bot.execRules([{ action: 'click', selector: '#x' }]))
  })

  it('dispatches every supported action verb to the right page call', async () => {
    const bot = botWithPage()
    bot.botName = 'Z'
    await bot.execRules([
      { action: 'fill', selector: '#a', value: '{{botName}}' },
      { action: 'click', selector: '#b' },
      { action: 'waitForSelector', selector: '#c' },
      { action: 'waitForTimeout', timeout: 5 },
      { action: 'evaluate', script: 'void 0' },
      { action: 'press', key: 'Enter' },
      { action: 'goto', url: 'https://x.test' },
      { action: 'select', selector: '#d', value: 'opt' },
      { action: 'hover', selector: '#e' },
      { action: 'focus', selector: '#f' },
      { action: 'clearInput', selector: '#g' }
    ])
    const acts = bot.page.calls.locatorActions
    assert.deepEqual(acts.find(a => a.action === 'fill'), { action: 'fill', selector: '#a', value: 'Z' }, 'fill value templated')
    assert.ok(acts.some(a => a.action === 'click' && a.selector === '#b'))
    assert.ok(acts.some(a => a.action === 'waitForSelector' && a.selector === '#c'))
    assert.deepEqual(bot.page.calls.waitForTimeout, [5])
    assert.deepEqual(bot.page.calls.evaluate, ['void 0'])
    assert.deepEqual(bot.page.calls.press, ['Enter'])
    assert.ok(bot.page.calls.goto.some(g => g.url === 'https://x.test'))
    assert.ok(acts.some(a => a.action === 'select' && a.value === 'opt'))
    assert.ok(acts.some(a => a.action === 'hover'))
    assert.ok(acts.some(a => a.action === 'focus'))
    assert.ok(acts.some(a => a.action === 'clearInput'))
  })

  it('a rule with `if` runs only while its selector is shown, and is skipped otherwise, even when not optional', async () => {
    const bot = botWithPage({
      count: (selector) => (selector === '#shown' ? 1 : 0),
      rejectFor: (action, selector) => selector === '#never-reached'
    })
    await bot.execRules([
      { if: '#shown', action: 'click', selector: '#a' },
      { if: '#absent', action: 'click', selector: '#never-reached' },
      { action: 'click', selector: '#b' }
    ])
    assert.deepEqual(bot.page.calls.locatorActions.map(a => a.selector), ['#a', '#b'])
  })

  it('an `if` check that fails (page navigating) skips the rule', async () => {
    const bot = botWithPage({ count: () => { throw new Error('Execution context was destroyed') } })
    await assert.doesNotReject(() => bot.execRules([{ if: '#x', action: 'click', selector: '#x' }]))
    assert.deepEqual(bot.page.calls.locatorActions, [])
  })

  it('waitForSelector waits for the first visible element, so a selector list resolves on whichever page shows up', async () => {
    const bot = botWithPage()
    const chain = []
    const realLocator = bot.page.locator
    bot.page.locator = (selector) => {
      const locator = realLocator(selector)
      return {
        filter: (opts) => {
          chain.push(['filter', opts])
          return { first: () => { chain.push(['first']); return locator } }
        }
      }
    }
    await bot.execRule({ action: 'waitForSelector', selector: '#a, #b', timeout: 10 })
    assert.deepEqual(chain, [['filter', { visible: true }], ['first']])
    assert.deepEqual(bot.page.calls.locatorActions, [{ action: 'waitForSelector', selector: '#a, #b' }])
  })

  it('an unknown action is tolerated (logged, no throw, no page call)', async () => {
    const bot = botWithPage()
    await assert.doesNotReject(() => bot.execRule({ action: 'teleport', selector: '#x' }))
    assert.equal(bot.page.calls.locatorActions.length, 0)
  })

  it('honours rule.timeout for goto (and a default otherwise)', async () => {
    const bot = botWithPage()
    await bot.execRule({ action: 'goto', url: 'https://x.test', timeout: 1234 })
    assert.equal(bot.page.calls.goto[0].opts.timeout, 1234)
    await bot.execRule({ action: 'goto', url: 'https://y.test' })
    assert.equal(bot.page.calls.goto[1].opts.timeout, 30000, 'default timeout when none given')
  })
})

describe('Bot._template', () => {
  it('passes non-string values through unchanged', () => {
    const bot = makeBot('visio')
    assert.equal(bot._template(42), 42)
    assert.equal(bot._template(undefined), undefined)
    const obj = { a: 1 }
    assert.strictEqual(bot._template(obj), obj)
  })
})

describe('Bot.dispose', () => {
  it('latches disposed and prevents concurrent re-entry', async () => {
    const { bot, record } = makeInitBot('visio')
    await bot.init()
    await Promise.all([bot.dispose(), bot.dispose()])
    assert.equal(bot.disposed, true)
    assert.equal(record.unregisterBot.length, 1, 'cleanup runs exactly once despite concurrent dispose')
  })

  it('cancels every timer and stops the mixer', async () => {
    const bot = makeBot('visio')
    bot._armJoinWatchdog()
    bot.emptyMeetingTimeoutMs = 10000
    bot.emptyMeetingTimer = setTimeout(() => {}, 10000)
    bot._armAudioSilenceWatchdog()
    bot._startMixer()
    bot.handleAudioData(0, Buffer.alloc(2))
    await bot.dispose()
    assert.equal(bot.joinWatchdog, null)
    assert.equal(bot.emptyMeetingTimer, null)
    assert.equal(bot.audioSilenceWatchdog, null)
    assert.equal(bot.audioMixer, null)
  })

  it('nulls the page, unregisters the bot and destroys the context', async () => {
    const { bot, record } = makeInitBot('visio')
    await bot.init()
    await bot.dispose()
    assert.equal(bot.page, null)
    assert.deepEqual(record.unregisterBot, [bot.wsPath])
    assert.deepEqual(record.destroyContext, [bot.contextId])
  })

  it('removes all event listeners', async () => {
    const { bot } = makeInitBot('visio')
    await bot.init()
    bot.on('audio', () => {})
    assert.ok(bot.listenerCount('audio') > 0)
    await bot.dispose()
    assert.equal(bot.listenerCount('audio'), 0, 'removeAllListeners ran')
  })

  it('runs leaveRules with suppressErrors and still completes cleanup when a leave rule throws', async () => {
    // Reject the leave click; dispose must still unregister + destroy the context.
    const { bot, record } = makeInitBot('visio', { rejectFor: (a) => a === 'click' })
    await bot.init()
    // After init the click reject would have failed the submit; rebuild cleanly:
    const fresh = makeInitBot('visio')
    await fresh.bot.init()
    // Force the leave rule to throw by swapping in a rejecting page click.
    fresh.page.locator = (selector) => ({ click: async () => { throw new Error('leave boom') }, waitFor: async () => {} })
    await fresh.bot.dispose()
    assert.equal(fresh.bot.page, null)
    assert.deepEqual(fresh.record.unregisterBot, [fresh.bot.wsPath])
    assert.deepEqual(fresh.record.destroyContext, [fresh.bot.contextId])
    // (record from the rejecting init is unused beyond proving init disposed once)
    assert.ok(record.unregisterBot.length >= 1)
  })

  it('disposes cleanly when init never completed (page is null)', async () => {
    const { bot, record } = makeInitBot('visio')
    // never call init: page stays null, manifest present.
    assert.equal(bot.page, null)
    await bot.dispose()
    assert.equal(bot.disposed, true)
    assert.deepEqual(record.unregisterBot, [bot.wsPath], 'unregister still runs with a null page')
    assert.deepEqual(record.destroyContext, [bot.contextId])
  })
})
