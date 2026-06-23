const assert = require('assert')
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
