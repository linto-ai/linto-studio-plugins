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

  it('heartbeat reports memory (rss/heapUsed) and lifecycle metrics (T4/T9)', () => {
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

describe('BotService BrokerClient — memory ceiling + backpressure (T13)', () => {
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
    // _publishStatus sets overloaded; or it is set on the first startBot pressure check.
    ctx.instance._publishStatus(true)
    await ctx.instance.startBot({ session: { id: 's' }, channel: { id: 'c' }, botType: 'visio', websocketUrl: 'ws://t', botId: 99 })
    assert.equal(ctx.instance.bots.size, 0, 'no bot was started')
    const err = ctx.publishes.find(p => p.topic === 'botservice/out/99/bot-error')
    assert.ok(err, 'a bot-error was published for the refused bot')
    assert.deepEqual(err.payload, { botId: 99, reason: 'botservice-overloaded' })
  })
})

describe('BotService BrokerClient — structured bot-error (T10)', () => {
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

// T8: Transcriber WS reconnect resilience. We mock the `ws` module so a socket
// close/open is driven from the test, and drive `_connectTranscriber` directly
// with a fake bot (no real browser/Bot is needed for the reconnect machinery).
describe('BotService BrokerClient — transcriber WS reconnect resilience (T8)', () => {
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

  // E1: a diarization-degraded event reconnects the transcriber so a fresh init
  // advertises the (now ASR) diarization mode.
  it('E1: reconnects the transcriber when the bot reports diarization degraded', async () => {
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

  // E2: a transcriber-error from the stream watchdog is at least observable.
  it('E2: listens for transcriber-error (does not throw on the unhandled error event)', () => {
    const bot = fakeBot()
    const record = makeRecord(bot)
    ctx.instance.bots.set('s_c', record)
    ctx.instance._connectTranscriber('s_c', record, record.websocketUrl)
    // An EventEmitter with no 'transcriber-error' listener would NOT throw (only
    // 'error' is special), but the listener must exist for observability.
    assert.doesNotThrow(() => bot.emit('transcriber-error', new Error('ack timeout')))
    assert.ok(bot.listenerCount('transcriber-error') >= 1)
  })

  // Section 3: a join-timeout (never admitted) publishes a structured bot-error.
  it('Section 3: a join-timeout publishes a join-timeout bot-error and stops the bot', async () => {
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

  // Section 3: exhausting reconnect retries publishes a transcriber-unreachable error.
  it('Section 3: publishes transcriber-unreachable when reconnect retries are exhausted', async () => {
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
