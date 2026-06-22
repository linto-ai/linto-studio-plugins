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
