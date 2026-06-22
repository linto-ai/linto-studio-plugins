const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const WebSocket = require('ws')
const LocalAudioServer = require('../bot/LocalAudioServer')

describe('LocalAudioServer', () => {
  let server
  beforeEach(async () => { server = new LocalAudioServer(); await server.start() })
  afterEach(async () => { await server.stop() })

  const connect = (path) => new WebSocket(`ws://127.0.0.1:${server.getPort()}${path}`)

  it('binds an ephemeral loopback port', () => {
    assert.ok(server.getPort() > 0)
  })

  it('parses a binary frame: [u16BE trackIndex][u16BE reserved][PCM]', (done) => {
    server.registerBot('/bot-bin', {
      onBinary: (trackIndex, pcm) => {
        assert.equal(trackIndex, 42)
        assert.equal(pcm.length, 4)
        const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
        assert.equal(s[0], 1000)
        assert.equal(s[1], 2000)
        done()
      }
    })
    const ws = connect('/bot-bin')
    ws.on('open', () => {
      const header = Buffer.alloc(4)
      header.writeUInt16BE(42, 0)
      ws.send(Buffer.concat([header, Buffer.from(new Int16Array([1000, 2000]).buffer)]))
    })
  })

  it('parses a JSON control message', (done) => {
    server.registerBot('/bot-json', {
      onJson: (json) => { assert.equal(json.type, 'trackAdded'); assert.equal(json.trackIndex, 0); done() }
    })
    const ws = connect('/bot-json')
    ws.on('open', () => ws.send(JSON.stringify({ type: 'trackAdded', trackId: 'abc', trackIndex: 0 })))
  })

  it('routes messages to the handler registered for the path', (done) => {
    let a = false, b = false
    const finish = () => { if (a && b) done() }
    server.registerBot('/bot-a', { onJson: (j) => { assert.equal(j.tag, 'a'); a = true; finish() } })
    server.registerBot('/bot-b', { onJson: (j) => { assert.equal(j.tag, 'b'); b = true; finish() } })
    const wa = connect('/bot-a'); wa.on('open', () => wa.send(JSON.stringify({ tag: 'a' })))
    const wb = connect('/bot-b'); wb.on('open', () => wb.send(JSON.stringify({ tag: 'b' })))
  })

  it('closes the connection and fires onClose on unregister', (done) => {
    server.registerBot('/bot-unreg', { onClose: () => done() })
    const ws = connect('/bot-unreg')
    ws.on('open', () => server.unregisterBot('/bot-unreg'))
  })

  it('rejects a connection to an unregistered path', (done) => {
    const ws = connect('/bot-unknown')
    ws.on('close', () => done())
  })

  it('resets the port to 0 on stop', async () => {
    assert.ok(server.getPort() > 0)
    await server.stop()
    assert.equal(server.getPort(), 0)
  })
})
