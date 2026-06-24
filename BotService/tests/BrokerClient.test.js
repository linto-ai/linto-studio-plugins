const assert = require('assert')
const EventEmitter = require('events')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { loadBrokerClient, uninstallMocks } = require('./helpers')

const tick = () => new Promise((r) => setImmediate(r))

describe('BotService BrokerClient', () => {
  let ctx
  beforeEach(() => { ctx = loadBrokerClient() })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    uninstallMocks()
  })

  it('has a botservice identity and transcriber-style topics', () => {
    const { instance } = ctx
    assert.match(instance.uniqueId, /^botservice-/)
    assert.equal(instance.pub, `botservice/out/${instance.uniqueId}`)
    assert.deepEqual(instance.subs, [`botservice/in/${instance.uniqueId}/#`])
  })

  it('advertises the four bot providers by default', () => {
    assert.deepEqual(ctx.instance.capabilities, ['jitsi', 'bigbluebutton', 'teams', 'visio'])
  })

  it('publishes status with activeBots and capabilities', () => {
    ctx.instance._publishStatus(true)
    assert.equal(ctx.statuses.length, 1)
    assert.equal(ctx.statuses[0].activeBots, 0)
    assert.deepEqual(ctx.statuses[0].capabilities, ['jitsi', 'bigbluebutton', 'teams', 'visio'])
  })

  it('heartbeat reports memory (rss/heapUsed) and lifecycle metrics', () => {
    ctx.instance._publishStatus(true)
    const s = ctx.statuses[0]
    assert.equal(typeof s.rss, 'number')
    assert.ok(s.rss > 0)
    assert.equal(typeof s.heapUsed, 'number')
    assert.ok(s.heapUsed > 0)
    assert.deepEqual(s.metrics, { botJoinAttempts: 0, botJoinSuccesses: 0, botJoinFailures: 0, participantChurn: 0 })
  })

  it('on broker ready: starts infra, publishes status, arms a heartbeat', async () => {
    ctx.mqttClient.emit('ready')
    await tick()
    assert.ok(ctx.statuses.length >= 1, 'status published on ready')
    assert.notEqual(ctx.instance.heartbeatTimer, null)
  })

  it('routes a startbot command to startBot()', () => {
    let got = null
    ctx.instance.startBot = async (data) => { got = data }
    const payload = { session: { id: 's' }, channel: { id: 'c' }, botType: 'visio', address: 'https://x', websocketUrl: 'ws://t' }
    ctx.mqttClient.emit('message', `botservice/in/${ctx.instance.uniqueId}/startbot`, Buffer.from(JSON.stringify(payload)))
    assert.deepEqual(got, payload)
  })

  it('routes a stopbot command to stopBot()', () => {
    const calls = []
    ctx.instance.stopBot = async (sessionId, channelId) => { calls.push([sessionId, channelId]) }
    ctx.mqttClient.emit('message', `botservice/in/${ctx.instance.uniqueId}/stopbot`, Buffer.from(JSON.stringify({ sessionId: 's', channelId: 'c' })))
    assert.deepEqual(calls, [['s', 'c']])
  })

  it('ignores malformed command payloads without throwing', () => {
    assert.doesNotThrow(() => ctx.mqttClient.emit('message', `botservice/in/${ctx.instance.uniqueId}/startbot`, Buffer.from('not json')))
  })
})

describe('BotService BrokerClient — memory ceiling + backpressure', () => {
  const realMemoryUsage = process.memoryUsage
  let ctx

  // Force a low ceiling and a high rss so the instance is over the ceiling.
  beforeEach(() => {
    process.env.BOTSERVICE_MAX_RSS_MB = '100'
    process.memoryUsage = () => ({ rss: 500 * 1024 * 1024, heapUsed: 200 * 1024 * 1024, heapTotal: 0, external: 0, arrayBuffers: 0 })
    ctx = loadBrokerClient()
  })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    process.memoryUsage = realMemoryUsage
    delete process.env.BOTSERVICE_MAX_RSS_MB
    uninstallMocks()
  })

  it('advertises EMPTY capabilities while over the ceiling, restores when under', () => {
    ctx.instance._publishStatus(true)
    assert.deepEqual(ctx.statuses[0].capabilities, [], 'no capabilities advertised while overloaded')
    assert.equal(ctx.instance.overloaded, true)
    // Drop back under the ceiling.
    process.memoryUsage = () => ({ rss: 10 * 1024 * 1024, heapUsed: 5 * 1024 * 1024, heapTotal: 0, external: 0, arrayBuffers: 0 })
    ctx.instance._publishStatus(true)
    assert.deepEqual(ctx.statuses[1].capabilities, ['jitsi', 'bigbluebutton', 'teams', 'visio'])
    assert.equal(ctx.instance.overloaded, false)
  })

  it('refuses a new startBot while over the ceiling and publishes a bot-error', async () => {
    ctx.instance._publishStatus(true)
    await ctx.instance.startBot({ session: { id: 's' }, channel: { id: 'c' }, botType: 'visio', websocketUrl: 'ws://t', botId: 99 })
    assert.equal(ctx.instance.bots.size, 0, 'no bot was started')
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/99/bot-error')
    assert.ok(err, 'a bot-error was published for the refused bot')
    assert.deepEqual(err.payload, { botId: 99, reason: 'botservice-overloaded' })
  })
})

describe('BotService BrokerClient — structured bot-error', () => {
  let ctx
  beforeEach(() => { ctx = loadBrokerClient() })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    uninstallMocks()
  })

  it('_publishBotError emits botservice/out/<id>/bot-error with {botId, reason}', () => {
    ctx.instance._publishBotError(7, 'Page crashed')
    const pub = ctx.publishes.find(p => p.topic === 'botservice/out/7/bot-error')
    assert.ok(pub)
    assert.deepEqual(pub.payload, { botId: 7, reason: 'Page crashed' })
  })

  it('_publishBotError is a no-op when botId is missing', () => {
    ctx.instance._publishBotError(undefined, 'whatever')
    assert.equal(ctx.publishes.filter(p => p.topic.endsWith('/bot-error')).length, 0)
  })
})

// Transcriber WS reconnect resilience. We mock the `ws` module so a socket
// close/open is driven from the test, and drive `_connectTranscriber` directly
// with a fake bot (no real browser/Bot is needed for the reconnect machinery).
describe('BotService BrokerClient — transcriber WS reconnect resilience', () => {
  const OPEN = 1
  const CLOSED = 3
  const wsPath = require.resolve('ws')
  let realWsCacheEntry
  let created // fake sockets created, in order

  class FakeWs extends EventEmitter {
    constructor (url) { super(); this.url = url; this.readyState = OPEN; this.sent = []; this.closed = false; created.push(this) }
    send (data) { this.sent.push(data) }
    close () { this.closed = true; this.readyState = CLOSED }
    // Simulate a peer-driven socket close (transient drop or otherwise).
    drop () { this.readyState = CLOSED; this.emit('close') }
  }

  function fakeBot () {
    const bot = new EventEmitter()
    bot.session = { id: 's' }
    bot.channel = { id: 'c' }
    bot.manifest = { diarizationMode: 'native' }
    bot.getParticipantsList = () => []
    bot.dispose = async () => {}
    return bot
  }

  function makeRecord (bot, botId = 1) {
    return {
      bot,
      ws: null,
      botId,
      websocketUrl: 'ws://transcriber',
      stream: null,
      audioBuffer: { buffered: [], droppedFrames: 0 },
      stopping: false,
      reconnectAttempts: 0,
      reconnectTimer: null
    }
  }

  let ctx
  let realSetTimeout
  beforeEach(() => {
    created = []
    // Swap the `ws` module for the fake BEFORE the BrokerClient is (re)required.
    realWsCacheEntry = require.cache[wsPath]
    require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWs }
    // Tight, deterministic backoff for the test.
    process.env.BOTSERVICE_WS_RECONNECT_RETRIES = '2'
    process.env.BOTSERVICE_WS_RECONNECT_BASE_MS = '10'
    ctx = loadBrokerClient()
    realSetTimeout = global.setTimeout
  })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    if (realWsCacheEntry) require.cache[wsPath] = realWsCacheEntry; else delete require.cache[wsPath]
    delete process.env.BOTSERVICE_WS_RECONNECT_RETRIES
    delete process.env.BOTSERVICE_WS_RECONNECT_BASE_MS
    global.setTimeout = realSetTimeout
    uninstallMocks()
  })

  const audioFrames = (ws) => ws.sent.filter(x => Buffer.isBuffer(x))

  it('on a transient WS drop it reconnects (does not stopBot) and flushes the retained buffer on re-ack', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)

    let stopped = false
    ctx.instance.stopBot = async () => { stopped = true }

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    const ws1 = created[0]
    ws1.emit('open')
    ws1.emit('message', JSON.stringify({ type: 'ack' }))
    // Audio flows on the live socket.
    bot.emit('audio', Buffer.from([1]))
    assert.equal(audioFrames(ws1).length, 1)

    // Transient drop: more audio arrives during the gap, before the reconnect.
    ws1.drop()
    bot.emit('audio', Buffer.from([2]))
    bot.emit('audio', Buffer.from([3]))
    assert.equal(stopped, false, 'a transient drop does NOT stop the bot')
    assert.ok(record.reconnectTimer, 'a reconnect is scheduled')

    // Let the backoff timer fire.
    await new Promise((r) => realSetTimeout(r, 30))
    assert.equal(created.length, 2, 'a new socket was opened on reconnect')
    const ws2 = created[1]
    ws2.emit('open')
    ws2.emit('message', JSON.stringify({ type: 'ack' }))
    const audio = audioFrames(ws2)
    assert.equal(audio.length, 2, 'frames buffered during the gap flushed on re-ack')
    assert.deepEqual([...audio[0]], [2])
    assert.deepEqual([...audio[1]], [3])
    assert.equal(stopped, false)
  })

  it('a clean reconnect resets the backoff counter', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    created[0].drop()
    assert.equal(record.reconnectAttempts, 1)
    await new Promise((r) => realSetTimeout(r, 30))
    created[1].emit('open') // clean open resets the counter
    assert.equal(record.reconnectAttempts, 0, 'backoff reset after a successful open')
  })

  it('gives up and stopBot after the reconnect retries are exhausted', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)

    let stopCalls = 0
    ctx.instance.stopBot = async () => { stopCalls++; ctx.instance.bots.delete('s_c') }

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    // RETRIES = 2. Drop, then drop each reconnected socket without a clean open.
    created[0].drop() // attempt 1 scheduled
    await new Promise((r) => realSetTimeout(r, 30))
    assert.equal(created.length, 2)
    created[1].drop() // attempt 2 scheduled
    await new Promise((r) => realSetTimeout(r, 50))
    assert.equal(created.length, 3)
    created[2].drop() // attempts exhausted -> give up
    assert.equal(stopCalls, 1, 'stopBot called once after retries exhausted')
  })

  it('an intentional stop tears down immediately and never reconnects', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    const ws1 = created[0]
    ws1.emit('open')

    // Explicit stop: real stopBot path (closes ws, marks stopping, cancels timer).
    await ctx.instance.stopBot('s', 'c')
    assert.equal(record.stopping, true)
    assert.equal(ws1.closed, true, 'socket closed by the intentional stop')
    assert.equal(ctx.instance.bots.has('s_c'), false)

    // The close that the real stopBot triggers must NOT schedule a reconnect.
    ws1.emit('close')
    await new Promise((r) => realSetTimeout(r, 30))
    assert.equal(created.length, 1, 'no reconnect socket opened after intentional stop')
    assert.equal(record.reconnectTimer, null)
  })

  // A diarization-degraded event reconnects the transcriber so a fresh init
  // advertises the (now ASR) diarization mode.
  it('reconnects the transcriber when the bot reports diarization degraded', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    const ws1 = created[0]
    ws1.emit('open')
    // The bot flips its own manifest mode (as _onDiarizationDegraded does) then
    // emits the event the BrokerClient now listens for.
    bot.manifest.diarizationMode = 'asr'
    bot.emit('diarization-degraded', { mode: 'asr', reason: 'callingDebug absent' })

    assert.equal(ws1.closed, true, 'the native-mode socket is closed')
    assert.equal(created.length, 2, 'a fresh socket is opened to re-run init in ASR mode')
    const ws2 = created[1]
    ws2.emit('open')
    const init = ws2.sent.filter(x => typeof x === 'string').map(JSON.parse).find(f => f.type === 'init')
    assert.ok(init, 'init re-sent on the new socket')
    assert.equal(init.diarizationMode, 'asr', 'reconnected init advertises ASR diarization')
  })

  // A transcriber-error from the stream watchdog is at least observable.
  it('listens for transcriber-error (does not throw on the unhandled error event)', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    // An EventEmitter with no 'transcriber-error' listener would NOT throw (only
    // 'error' is special), but the listener must exist for observability.
    assert.doesNotThrow(() => bot.emit('transcriber-error', new Error('ack timeout')))
    assert.ok(bot.listenerCount('transcriber-error') >= 1)
  })

  // A join-timeout (never admitted) publishes a structured bot-error.
  it('a join-timeout publishes a join-timeout bot-error and stops the bot', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot, 42)
    ctx.instance.bots.set('s_c', record)
    let stopped = false
    ctx.instance.stopBot = async () => { stopped = true }
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)

    bot.emit('join-timeout')
    await tick()
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/42/bot-error')
    assert.ok(err, 'a bot-error was published for the join timeout')
    assert.equal(err.payload.reason, 'join-timeout')
    assert.equal(stopped, true, 'the bot is stopped after a join timeout')
  })

  // Exhausting reconnect retries publishes a transcriber-unreachable error.
  it('publishes transcriber-unreachable when reconnect retries are exhausted', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot, 7)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => { ctx.instance.bots.delete('s_c') }

    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    created[0].drop() // attempt 1
    await new Promise((r) => realSetTimeout(r, 30))
    created[1].drop() // attempt 2
    await new Promise((r) => realSetTimeout(r, 50))
    created[2].drop() // exhausted -> give up
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/7/bot-error')
    assert.ok(err, 'a bot-error was published when retries were exhausted')
    assert.equal(err.payload.reason, 'transcriber-unreachable')
  })
})

// =========================================================================
// Additional coverage. A second `ws`-mocking block exercising _openSocket,
// _scheduleReconnect and stopBot edge cases with the same FakeWs technique,
// plus blocks for browser-lost, the ready/_wire error paths, _evaluatePressure,
// _publishStatus dedup/boundary, startBot lifecycle, destroy(), and multi-bot
// status. Source is never modified; tests assert the CURRENT behavior.
// =========================================================================

describe('BotService BrokerClient — _openSocket / _scheduleReconnect / stopBot edges', () => {
  const OPEN = 1
  const CLOSED = 3
  const wsPath = require.resolve('ws')
  let realWsCacheEntry
  let created

  class FakeWs extends EventEmitter {
    constructor (url) { super(); this.url = url; this.readyState = OPEN; this.sent = []; this.closed = false; this.closeThrows = false; created.push(this) }
    send (data) { this.sent.push(data) }
    close () { if (this.closeThrows) throw new Error('close boom'); this.closed = true; this.readyState = CLOSED }
    drop () { this.readyState = CLOSED; this.emit('close') }
  }

  function fakeBot () {
    const bot = new EventEmitter()
    bot.session = { id: 's' }
    bot.channel = { id: 'c' }
    bot.manifest = { diarizationMode: 'native' }
    bot.getParticipantsList = () => []
    bot.dispose = async () => {}
    return bot
  }

  function makeRecord (bot, botId = 1) {
    return {
      bot,
      ws: null,
      botId,
      websocketUrl: 'ws://transcriber',
      stream: null,
      audioBuffer: { buffered: [], droppedFrames: 0 },
      stopping: false,
      reconnectAttempts: 0,
      reconnectTimer: null
    }
  }

  let ctx
  let realSetTimeout
  beforeEach(() => {
    created = []
    realWsCacheEntry = require.cache[wsPath]
    require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWs }
    process.env.BOTSERVICE_WS_RECONNECT_RETRIES = '5'
    process.env.BOTSERVICE_WS_RECONNECT_BASE_MS = '1000'
    ctx = loadBrokerClient()
    realSetTimeout = global.setTimeout
  })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    if (realWsCacheEntry) require.cache[wsPath] = realWsCacheEntry; else delete require.cache[wsPath]
    delete process.env.BOTSERVICE_WS_RECONNECT_RETRIES
    delete process.env.BOTSERVICE_WS_RECONNECT_BASE_MS
    global.setTimeout = realSetTimeout
    uninstallMocks()
  })

  it('detaches the previous stream when re-opening the socket on the same record', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    const firstStream = record.stream
    let detached = false
    firstStream.detach = () => { detached = true }
    // Re-open: previous stream's detach() must be called.
    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    assert.equal(detached, true, 'previous stream.detach() invoked on re-open')
    assert.notEqual(record.stream, firstStream, 'a fresh stream replaced the old one')
  })

  it('a stale socket close (after a newer socket opened) does NOT schedule a reconnect', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}

    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    const ws1 = created[0]
    // A newer socket replaces ws1 on the record.
    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    const ws2 = created[1]
    assert.equal(record.ws, ws2)
    // Now ws1 (stale) closes — its close handler must early-return (record.ws !== ws1).
    ws1.drop()
    assert.equal(record.reconnectTimer, null, 'no reconnect scheduled for the stale socket')
    assert.equal(record.reconnectAttempts, 0)
  })

  it('logs the WS error event without throwing', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    const ws = created[0]
    assert.doesNotThrow(() => ws.emit('error', new Error('socket kaput')))
    assert.ok(ctx.logs.some(l => l.level === 'error' && /socket kaput/.test(l.msg)), 'WS error was logged')
  })

  it('_scheduleReconnect uses RECONNECT_BASE_MS * 2^(attempts-1) backoff', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    const delays = []
    global.setTimeout = (fn, ms) => { delays.push(ms); return { _fake: true } }

    ctx.instance._scheduleReconnect('s_c', record) // attempts -> 1
    ctx.instance._scheduleReconnect('s_c', record) // attempts -> 2
    ctx.instance._scheduleReconnect('s_c', record) // attempts -> 3
    assert.deepEqual(delays, [1000, 2000, 4000], 'exponential backoff: base*2^(n-1)')
    assert.equal(record.reconnectAttempts, 3)
  })

  it('a pending reconnect timer does NOT open a socket once stopBot raced ahead', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)

    let captured
    global.setTimeout = (fn, ms) => { captured = fn; return { _fake: true } }
    ctx.instance._scheduleReconnect('s_c', record)
    // Intentional stop before the timer fires.
    record.stopping = true
    ctx.instance.bots.delete('s_c')
    // Fire the captured timer body: it must early-return, opening no socket.
    captured()
    assert.equal(created.length, 0, '_openSocket not called after stopBot raced ahead')
  })

  it('stopBot is idempotent: a second call for the same key is a no-op', async () => {
    const bot = fakeBot()
    let disposeCalls = 0
    bot.dispose = async () => { disposeCalls++ }
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._openSocket('s_c', record, record.websocketUrl)

    await ctx.instance.stopBot('s', 'c')
    const statusesAfterFirst = ctx.statuses.length
    await ctx.instance.stopBot('s', 'c') // record already gone
    assert.equal(disposeCalls, 1, 'dispose only ran once')
    assert.equal(ctx.statuses.length, statusesAfterFirst, 'second stopBot published nothing')
  })

  it('stopBot swallows a bot.dispose() error and still completes', async () => {
    const bot = fakeBot()
    bot.dispose = async () => { throw new Error('dispose blew up') }
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    await assert.doesNotReject(() => ctx.instance.stopBot('s', 'c'))
    assert.equal(ctx.instance.bots.has('s_c'), false, 'bot removed despite dispose error')
    assert.ok(ctx.logs.some(l => l.level === 'error' && /dispose blew up/.test(l.msg)), 'dispose error logged')
  })

  it('stopBot swallows a ws.close() error and still disposes the bot', async () => {
    const bot = fakeBot()
    let disposed = false
    bot.dispose = async () => { disposed = true }
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._openSocket('s_c', record, record.websocketUrl)
    created[0].closeThrows = true
    await assert.doesNotReject(() => ctx.instance.stopBot('s', 'c'))
    assert.equal(disposed, true, 'bot disposed even though ws.close() threw')
  })

  it('stopBot clears a pending reconnectTimer (set to null)', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    record.reconnectTimer = realSetTimeout(() => { throw new Error('should have been cleared') }, 1000)
    await ctx.instance.stopBot('s', 'c')
    assert.equal(record.reconnectTimer, null, 'reconnectTimer cleared by stopBot')
    assert.equal(record.stopping, true)
  })

  it('metrics counters are unchanged across a reconnect', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}
    ctx.instance.metrics.botJoinAttempts = 4
    ctx.instance.metrics.botJoinSuccesses = 3
    const before = { ...ctx.instance.metrics }

    let fired
    global.setTimeout = (fn) => { fired = fn; return { _fake: true } }
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    created[0].drop()
    fired() // run the backoff body -> opens the reconnect socket
    assert.ok(created.length >= 2, 'a reconnect socket opened')
    assert.deepEqual(ctx.instance.metrics, before, 'metrics untouched by reconnect')
  })

  it('diarization-degraded does NOT reconnect when the record is stopping', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    created[0].emit('open')
    const countBefore = created.length
    record.stopping = true
    bot.emit('diarization-degraded', { reason: 'x' })
    assert.equal(created.length, countBefore, 'no reconnect socket opened while stopping')
  })

  it('diarization-degraded does NOT reconnect when the record left the bots Map', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    created[0].emit('open')
    const countBefore = created.length
    ctx.instance.bots.delete('s_c') // record no longer current
    bot.emit('diarization-degraded', { reason: 'x' })
    assert.equal(created.length, countBefore, 'no reconnect after record removed')
  })

  it('bot error event publishes a bot-error and stops the bot', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot, 55)
    ctx.instance.bots.set('s_c', record)
    let stopped = false
    ctx.instance.stopBot = async () => { stopped = true }
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)

    bot.emit('error', new Error('page crashed'))
    await tick()
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/55/bot-error')
    assert.ok(err, 'bot-error published on bot error')
    assert.equal(err.payload.reason, 'page crashed')
    assert.equal(stopped, true, 'stopBot called on bot error')
  })

  it('participant churn increments by 2 for one join + one leave', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    const before = ctx.instance.metrics.participantChurn
    bot.emit('participant-joined', { identity: 'a', name: 'A' })
    bot.emit('participant-left', { identity: 'a', name: 'A' })
    assert.equal(ctx.instance.metrics.participantChurn, before + 2, 'churn += 2')
  })

  it('meeting-empty requests scheduler cleanup and stops the bot', async () => {
    const bot = fakeBot()
    const record = makeRecord(bot, 88)
    ctx.instance.bots.set('s_c', record)
    let stopped = false
    ctx.instance.stopBot = async () => { stopped = true }
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)

    bot.emit('meeting-empty')
    await tick()
    const cleanup = ctx.publishes.find(p => p.topic === 'scheduler/in/schedule/stopbot')
    assert.ok(cleanup, 'scheduler cleanup requested')
    assert.deepEqual(cleanup.payload, { botId: 88 })
    assert.equal(stopped, true, 'stopBot called on meeting-empty')
  })

  it('treats botId=0 as valid and publishes a bot-error (not a falsy skip)', () => {
    const bot = fakeBot()
    const record = makeRecord(bot, 0)
    ctx.instance.bots.set('s_c', record)
    ctx.instance.stopBot = async () => {}
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    bot.emit('error', new Error('boom'))
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/0/bot-error')
    assert.ok(err, 'botId=0 still publishes a bot-error')
    assert.equal(err.payload.botId, 0)
  })
})

describe('BotService BrokerClient — browser lost', () => {
  let ctx
  beforeEach(() => { ctx = loadBrokerClient() })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    uninstallMocks()
  })

  it('a browserPool "disconnected" event stops all active bots and warns', async () => {
    const stopped = []
    ctx.instance.stopBot = async (sessionId, channelId) => { stopped.push(`${sessionId}_${channelId}`) }
    ctx.instance.bots.set('s1_c1', {})
    ctx.instance.bots.set('s2_c2', {})

    ctx.instance.browserPool.emit('disconnected')
    await tick()
    assert.deepEqual(stopped.sort(), ['s1_c1', 's2_c2'], 'every active bot stopped on browser loss')
    assert.ok(ctx.logs.some(l => l.level === 'warn' && /browser lost/.test(l.msg)), 'browser-lost warning logged')
  })
})

describe('BotService BrokerClient — ready/_wire infrastructure failures', () => {
  const realExit = process.exit
  let ctx
  let exitCode
  beforeEach(() => {
    ctx = loadBrokerClient()
    exitCode = undefined
    process.exit = (code) => { exitCode = code }
  })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    process.exit = realExit
    uninstallMocks()
  })

  it('exits(1) when browserPool.init() throws', async () => {
    ctx.instance.browserPool.init = async () => { throw new Error('no chromium') }
    ctx.mqttClient.emit('ready')
    await tick()
    assert.equal(exitCode, 1, 'process.exit(1) on browser init failure')
    assert.ok(ctx.logs.some(l => l.level === 'error' && /no chromium/.test(l.msg)))
  })

  it('exits(1) when audioServer.start() throws', async () => {
    ctx.instance.audioServer.start = async () => { throw new Error('port busy') }
    ctx.mqttClient.emit('ready')
    await tick()
    assert.equal(exitCode, 1, 'process.exit(1) on audio server failure')
    assert.ok(ctx.logs.some(l => l.level === 'error' && /port busy/.test(l.msg)))
  })

  it('arms the heartbeat at HEARTBEAT_MS (15000ms) on a successful ready', async () => {
    const intervals = []
    const realSetInterval = global.setInterval
    global.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(() => {}, 1e9) }
    try {
      ctx.mqttClient.emit('ready')
      await tick()
      assert.ok(intervals.includes(15000), 'heartbeat interval is 15000ms')
      assert.notEqual(ctx.instance.heartbeatTimer, null, 'heartbeat timer persisted')
    } finally {
      global.setInterval = realSetInterval
    }
  })

  it('the armed heartbeat keeps publishing status', async () => {
    let fired = null
    const realSetInterval = global.setInterval
    global.setInterval = (fn) => { fired = fn; return { _fake: true } }
    try {
      const before = ctx.statuses.length
      ctx.mqttClient.emit('ready')
      await tick()
      assert.ok(ctx.statuses.length > before, 'status published on ready')
      const afterReady = ctx.statuses.length
      fired() // simulate one heartbeat tick
      assert.ok(ctx.statuses.length > afterReady, 'heartbeat tick publishes another status')
    } finally {
      global.setInterval = realSetInterval
    }
  })
})

describe('BotService BrokerClient — _evaluatePressure / _publishStatus boundaries', () => {
  const realMemoryUsage = process.memoryUsage
  afterEach(() => {
    process.memoryUsage = realMemoryUsage
    delete process.env.BOTSERVICE_MAX_RSS_MB
    uninstallMocks()
  })

  it('_evaluatePressure is a no-op (no flag change, no log) when MAX_RSS_MB=0', () => {
    process.env.BOTSERVICE_MAX_RSS_MB = '0'
    const ctx = loadBrokerClient()
    try {
      const logsBefore = ctx.logs.length
      ctx.instance._evaluatePressure({ rss: 999 * 1024 * 1024 })
      assert.equal(ctx.instance.overloaded, false, 'overloaded never set when ceiling disabled')
      assert.equal(ctx.logs.length, logsBefore, 'no logging when ceiling disabled')
    } finally {
      if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    }
  })

  it('flips overloaded exactly at the threshold (rssMb === MAX_RSS_MB, >= comparison)', () => {
    process.env.BOTSERVICE_MAX_RSS_MB = '100'
    process.memoryUsage = () => ({ rss: 100 * 1024 * 1024, heapUsed: 1, heapTotal: 0, external: 0, arrayBuffers: 0 })
    const ctx = loadBrokerClient()
    try {
      ctx.instance._publishStatus(true)
      assert.equal(ctx.instance.overloaded, true, 'rss exactly at the ceiling is overloaded (>=)')
      assert.deepEqual(ctx.statuses[0].capabilities, [], 'empty capabilities at the threshold')
    } finally {
      if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    }
  })

  it('_publishStatus deduplicates: a second unchanged non-forced call publishes nothing', () => {
    const ctx = loadBrokerClient()
    try {
      ctx.instance._publishStatus(false)
      assert.equal(ctx.statuses.length, 1, 'first non-forced call publishes')
      ctx.instance._publishStatus(false)
      assert.equal(ctx.statuses.length, 1, 'second unchanged call is deduplicated')
    } finally {
      if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    }
  })
})

// startBot lifecycle. We stub the `Bot` module in the require cache so no real
// browser launches; the fake Bot's init()/dispose() are driven from the test.
describe('BotService BrokerClient — startBot lifecycle', () => {
  const botPath = require.resolve('../bot')
  let realBotCacheEntry
  let botInstances
  let botBehaviour

  function makeFakeBotModule () {
    const FakeBot = function ({ session, channel }) {
      EventEmitter.call(this)
      this.session = session
      this.channel = channel
      this.disposeCalls = 0
      this.init = async () => (botBehaviour.init ? botBehaviour.init(this) : true)
      this.dispose = async () => { this.disposeCalls++ }
      this.getParticipantsList = () => []
      this.manifest = { diarizationMode: 'asr' }
      botInstances.push(this)
    }
    FakeBot.prototype = Object.create(EventEmitter.prototype)
    FakeBot.KNOWN_BOT_TYPES = ['jitsi', 'bigbluebutton', 'teams', 'visio']
    return FakeBot
  }

  let ctx
  beforeEach(() => {
    botInstances = []
    botBehaviour = {}
    realBotCacheEntry = require.cache[botPath]
    require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: makeFakeBotModule() }
    ctx = loadBrokerClient()
    // Avoid opening real transcriber sockets: replace the connect step.
    ctx.instance._connectTranscriber = () => {}
  })
  afterEach(() => {
    if (ctx.instance.heartbeatTimer) clearInterval(ctx.instance.heartbeatTimer)
    if (realBotCacheEntry) require.cache[botPath] = realBotCacheEntry; else delete require.cache[botPath]
    uninstallMocks()
  })

  const startArgs = (botId = 1, sid = 's', cid = 'c') => ({
    session: { id: sid }, channel: { id: cid }, address: 'https://x', botType: 'visio', websocketUrl: 'ws://t', botId
  })

  it('a successful join increments attempts and successes and registers the bot', async () => {
    await ctx.instance.startBot(startArgs(1))
    assert.equal(ctx.instance.metrics.botJoinAttempts, 1)
    assert.equal(ctx.instance.metrics.botJoinSuccesses, 1)
    assert.equal(ctx.instance.metrics.botJoinFailures, 0)
    assert.equal(ctx.instance.bots.size, 1)
  })

  it('a failed join increments failures and publishes a join-failed bot-error', async () => {
    botBehaviour.init = () => false
    await ctx.instance.startBot(startArgs(13))
    assert.equal(ctx.instance.metrics.botJoinAttempts, 1)
    assert.equal(ctx.instance.metrics.botJoinSuccesses, 0)
    assert.equal(ctx.instance.metrics.botJoinFailures, 1)
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/13/bot-error')
    assert.ok(err, 'join-failed bot-error published')
    assert.equal(err.payload.reason, 'join-failed')
    assert.equal(ctx.instance.bots.size, 0, 'failed bot not left in the map')
  })

  it('starting the same session/channel twice disposes the first bot instance', async () => {
    await ctx.instance.startBot(startArgs(1))
    const first = botInstances[0]
    await ctx.instance.startBot(startArgs(2))
    assert.equal(first.disposeCalls, 1, 'first bot disposed when replaced')
    assert.equal(ctx.instance.bots.size, 1, 'still a single bot for the key')
  })

  it('a stopbot that races during init disposes the just-joined orphan bot', async () => {
    // While init() runs, the record is removed from the map (simulating a stopbot
    // that arrived mid-join). The orphan must be disposed directly.
    botBehaviour.init = (botInst) => {
      ctx.instance.bots.delete(`${botInst.session.id}_${botInst.channel.id}`)
      return true
    }
    await ctx.instance.startBot(startArgs(1))
    assert.equal(botInstances[0].disposeCalls, 1, 'orphan bot disposed')
    assert.equal(ctx.instance.metrics.botJoinSuccesses, 0, 'orphan not counted as a success')
    assert.ok(ctx.logs.some(l => /disposing orphan/.test(l.msg)), 'orphan disposal logged')
  })

  it('tracks multiple concurrent bots and removes exactly one on stop', async () => {
    await ctx.instance.startBot(startArgs(1, 's1', 'c1'))
    await ctx.instance.startBot(startArgs(2, 's2', 'c2'))
    await ctx.instance.startBot(startArgs(3, 's3', 'c3'))
    assert.equal(ctx.instance.bots.size, 3, 'three active bots')
    ctx.instance._publishStatus(true)
    assert.equal(ctx.statuses[ctx.statuses.length - 1].activeBots, 3, 'status reports 3 active bots')

    await ctx.instance.stopBot('s2', 'c2')
    assert.equal(ctx.instance.bots.size, 2, 'one bot removed')
    assert.equal(ctx.instance.bots.has('s2_c2'), false)
    assert.equal(ctx.instance.bots.has('s1_c1'), true)
    assert.equal(ctx.instance.bots.has('s3_c3'), true)
  })

  it('destroy() clears the heartbeat, stops every bot and tears down infra', async () => {
    await ctx.instance.startBot(startArgs(1, 's1', 'c1'))
    await ctx.instance.startBot(startArgs(2, 's2', 'c2'))
    const bots = [...botInstances]
    let poolDestroyed = false
    let audioStopped = false
    ctx.instance.browserPool.destroy = async () => { poolDestroyed = true }
    ctx.instance.audioServer.stop = async () => { audioStopped = true }
    ctx.instance.heartbeatTimer = setInterval(() => {}, 1e9)

    await ctx.instance.destroy()
    assert.equal(ctx.instance.bots.size, 0, 'all bots stopped')
    assert.ok(bots.every(b => b.disposeCalls === 1), 'every bot disposed once')
    assert.equal(poolDestroyed, true, 'browser pool destroyed')
    assert.equal(audioStopped, true, 'audio server stopped')
  })
})
