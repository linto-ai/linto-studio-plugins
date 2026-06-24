const assert = require('assert')
const path = require('path')
const { describe, it, beforeEach, afterEach } = require('mocha')
const Bot = require('../bot')

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
    clear: async () => { calls.locatorActions.push({ action: 'clearInput', selector }); if (rejectFor('clearInput', selector)) throw new Error('clear failed') }
  })
  return {
    calls,
    handlers,
    on (event, cb) { handlers[event] = cb },
    async addInitScript (script) { calls.addInitScript.push(script) },
    async route (pattern, handler) { calls.route.push({ pattern, handler }) },
    async goto (url, optsArg) { calls.goto.push({ url, opts: optsArg }); if (opts.gotoThrows) throw new Error('goto boom') },
    locator: mkLocator,
    keyboard: { press: async (key) => { calls.press.push(key); if (rejectFor('press', key)) throw new Error('press failed') } },
    async evaluate (script) { calls.evaluate.push(script); if (rejectFor('evaluate', script)) throw new Error('evaluate failed') },
    async waitForTimeout (ms) { calls.waitForTimeout.push(ms) }
  }
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
    added: [], removed: [], stopped: false,
    addAudio (id, pcm, ts, name) { this.added.push({ id, name, len: pcm.length }) },
    removeParticipant (id) { this.removed.push(id) },
    on () {}, start () {}, stop () { this.stopped = true }
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

    it('routes mapped-track audio to the mixer under the participant id', () => {
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(mixer.added.length, 1)
      assert.equal(mixer.added[0].id, 'u1')
      assert.equal(mixer.added[0].name, 'Alice')
    })

    it('buffers early (unmapped) audio and flushes it once the mapping arrives', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(mixer.added.length, 0, 'nothing mixed before mapping')
      assert.equal(bot.earlyAudio.get(0).length, 2)

      let joined = null
      bot.on('participant-joined', (p) => { joined = p })
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })

      assert.equal(mixer.added.length, 2, 'buffered frames flushed to the mixer')
      assert.deepEqual(joined, { identity: 'u1', name: 'Alice' })
      assert.equal(bot.earlyAudio.has(0), false)
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

    it('cleans the early-audio buffer when its track is removed before any mapping', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(bot.earlyAudio.get(0).length, 2)
      assert.equal(bot.earlyAudioFirstSeen.has(0), true, 'age marker recorded')
      bot._onTrackRemoved(0)
      assert.equal(bot.earlyAudio.has(0), false, 'early-audio dropped on track removal')
      assert.equal(bot.earlyAudioFirstSeen.has(0), false, 'age marker dropped too (maps stay in sync)')
    })

    it('the reaper drops stale early-audio whose track was never mapped', () => {
      bot.handleAudioData(0, Buffer.alloc(640)) // stale: first seen "long ago"
      bot.handleAudioData(1, Buffer.alloc(640)) // fresh: first seen "now"
      // Backdate track 0 past the max age, leave track 1 fresh.
      bot.earlyAudioFirstSeen.set(0, Date.now() - 60000)
      assert.notEqual(bot.earlyAudioReaper, null, 'reaper armed while early-audio is buffered')
      bot._reapEarlyAudio() // runs the reaper body deterministically (no wall-clock wait)
      assert.equal(bot.earlyAudio.has(0), false, 'stale track 0 reaped')
      assert.equal(bot.earlyAudio.has(1), true, 'fresh track 1 kept')
    })

    it('the reaper stops itself once nothing is buffered', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.earlyAudioFirstSeen.set(0, Date.now() - 60000)
      assert.notEqual(bot.earlyAudioReaper, null)
      bot._reapEarlyAudio()
      assert.equal(bot.earlyAudio.size, 0)
      assert.equal(bot.earlyAudioReaper, null, 'reaper interval cleared when empty (no leak)')
    })

    it('dispose clears early-audio state and the reaper timer', async () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.notEqual(bot.earlyAudioReaper, null)
      await bot.dispose()
      assert.equal(bot.earlyAudioReaper, null, 'reaper cleared on dispose')
      assert.equal(bot.earlyAudio.size, 0)
      assert.equal(bot.earlyAudioFirstSeen.size, 0)
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

  describe('MCU/Teams pass-through audio', () => {
    it('forwards server-mixed audio as-is (no mixer)', () => {
      const bot = makeBot('bigbluebutton')
      assert.equal(bot.isSfu, false)
      let got = null
      bot.on('audio', (buf) => { got = buf })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.ok(got && got.length === 640)
    })

    it('holds Teams audio until admitted (no streaming from the lobby)', () => {
      const bot = makeBot('teams')
      let got = null
      bot.on('audio', (buf) => { got = buf })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(got, null, 'no audio while still in the Teams lobby (not admitted)')
      bot.hasSeenParticipant = true // admitted: a participant was detected
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.ok(got && got.length === 640, 'audio flows once admitted')
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

  it('starts the AudioMixer for SFU platforms', async () => {
    const { bot } = makeInitBot('visio')
    await bot.init()
    assert.ok(bot.audioMixer, 'SFU init builds a mixer')
    await bot.dispose()
  })

  it('does NOT start a mixer for MCU/Teams (pass-through audio)', async () => {
    const { bot } = makeInitBot('bigbluebutton', {}, { address: 'https://bbb.example.com/room' })
    await bot.init()
    assert.equal(bot.audioMixer, null, 'no mixer for MCU pass-through')
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

  it('the domain allowlist continues the host and its subdomains, aborts others', async () => {
    const { bot, page } = makeInitBot('bigbluebutton', {}, { address: 'https://bbb.example.com/room' })
    await bot.init()
    const routeHandler = page.calls.route[0].handler
    const run = (url) => {
      let action = null
      routeHandler({ request: () => ({ url: () => url }), continue: () => { action = 'continue' }, abort: () => { action = 'abort' } })
      return action
    }
    assert.equal(run('https://bbb.example.com/x'), 'continue', 'exact host allowed')
    assert.equal(run('https://cdn.bbb.example.com/x'), 'continue', 'subdomain allowed')
    assert.equal(run('https://evil.com/x'), 'abort', 'foreign host aborted')
    assert.equal(run('https://allowed.evil.com/x'), 'abort', 'lookalike suffix not matched')
    assert.equal(run('not a url'), 'abort', 'unparseable url aborted (empty host)')
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
  it('attaches audio + speakerChanged handlers that re-emit on the bot', () => {
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
})

describe('Bot._bufferEarlyAudio internals', () => {
  let bot, mixer
  beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

  it('creates the buffer and records an age marker on the first frame', () => {
    const before = Date.now()
    bot._bufferEarlyAudio(0, Buffer.alloc(640))
    assert.equal(bot.earlyAudio.get(0).length, 1)
    assert.ok(bot.earlyAudioFirstSeen.get(0) >= before, 'age marker set on first frame')
  })

  it('caps the buffer at MAX_EARLY_FRAMES and silently drops the overflow', () => {
    for (let i = 0; i < 200; i++) bot._bufferEarlyAudio(0, Buffer.alloc(2))
    assert.equal(bot.earlyAudio.get(0).length, 150, 'capped at MAX_EARLY_FRAMES (150)')
  })

  it('arms the reaper on the first buffered frame', () => {
    assert.equal(bot.earlyAudioReaper, null)
    bot._bufferEarlyAudio(0, Buffer.alloc(2))
    assert.notEqual(bot.earlyAudioReaper, null)
  })

  it('buffers multiple tracks independently', () => {
    bot._bufferEarlyAudio(0, Buffer.alloc(2))
    bot._bufferEarlyAudio(1, Buffer.alloc(2))
    bot._bufferEarlyAudio(1, Buffer.alloc(2))
    assert.equal(bot.earlyAudio.get(0).length, 1)
    assert.equal(bot.earlyAudio.get(1).length, 2)
  })

  it('handles audio arriving before the mapping (buffered, then flushed in order)', () => {
    bot.handleAudioData(5, Buffer.alloc(10))
    bot.handleAudioData(5, Buffer.alloc(20))
    assert.equal(mixer.added.length, 0)
    bot._onParticipantMapping(5, { id: 'u9', name: 'Zed' })
    assert.equal(mixer.added.length, 2, 'both early frames flushed')
    assert.deepEqual(mixer.added.map(a => a.len), [10, 20], 'flushed in arrival order')
  })
})

describe('Bot early-audio reaper arm/cancel guards', () => {
  it('_armEarlyAudioReaper is idempotent (a second call keeps the same interval)', () => {
    const bot = makeBot('visio')
    bot._armEarlyAudioReaper()
    const first = bot.earlyAudioReaper
    bot._armEarlyAudioReaper()
    assert.strictEqual(bot.earlyAudioReaper, first, 'no second interval created')
    bot._cancelEarlyAudioReaper()
  })

  it('_armEarlyAudioReaper does not arm when disposed', async () => {
    const bot = makeBot('visio')
    await bot.dispose() // sets disposed = true
    bot._armEarlyAudioReaper()
    assert.equal(bot.earlyAudioReaper, null, 'disposed bot never arms the reaper')
  })

  it('_cancelEarlyAudioReaper returns early when there is no interval', () => {
    const bot = makeBot('visio')
    assert.equal(bot.earlyAudioReaper, null)
    bot._cancelEarlyAudioReaper() // must not throw
    assert.equal(bot.earlyAudioReaper, null)
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
    assert.deepEqual(bot.trackParticipants.get(0), { id: 'u1', name: 'A' })
  })

  it('trackRemoved routes to track removal', () => {
    bot.handleJsonMessage({ type: 'participantMapping', trackIndex: 0, participant: { id: 'u1', name: 'A' } })
    bot.handleJsonMessage({ type: 'trackRemoved', trackIndex: 0 })
    assert.equal(bot.trackParticipants.has(0), false)
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
    assert.equal(bot.trackParticipants.get(0).name, 'New', 'track mapping reflects the updated participant')
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

  it('deletes the mapping and the early-audio for the track together', () => {
    bot.handleAudioData(0, Buffer.alloc(2))
    bot._onParticipantMapping(1, { id: 'u1', name: 'A' }) // separate mapped track
    bot._onTrackRemoved(0)
    assert.equal(bot.trackParticipants.has(0), false)
    assert.equal(bot.earlyAudio.has(0), false)
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

  it('does not arm if a participant was already seen', () => {
    const bot = makeBot('visio')
    bot.hasSeenParticipant = true
    bot._armJoinWatchdog()
    assert.equal(bot.joinWatchdog, null)
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

  it('cancels every timer and clears early-audio state', async () => {
    const bot = makeBot('visio')
    bot._armJoinWatchdog()
    bot.emptyMeetingTimeoutMs = 10000
    bot.emptyMeetingTimer = setTimeout(() => {}, 10000)
    bot._armAudioSilenceWatchdog()
    bot.handleAudioData(0, Buffer.alloc(2)) // arms the early-audio reaper (visio/SFU + no mixer-less path)
    await bot.dispose()
    assert.equal(bot.joinWatchdog, null)
    assert.equal(bot.emptyMeetingTimer, null)
    assert.equal(bot.audioSilenceWatchdog, null)
    assert.equal(bot.earlyAudioReaper, null)
    assert.equal(bot.earlyAudio.size, 0)
    assert.equal(bot.earlyAudioFirstSeen.size, 0)
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
