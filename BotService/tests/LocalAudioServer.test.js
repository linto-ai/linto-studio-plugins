const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const WebSocket = require('ws')
const LocalAudioServer = require('../bot/LocalAudioServer')

// Build a binary audio frame: [u16BE trackIndex][u16BE reserved][PCM...]
const frame = (trackIndex, pcm = Buffer.alloc(0), reserved = 0) => {
  const header = Buffer.alloc(4)
  header.writeUInt16BE(trackIndex, 0)
  header.writeUInt16BE(reserved, 2)
  return Buffer.concat([header, Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)])
}

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

  describe('getPort lifecycle', () => {
    it('returns 0 before start (fresh instance)', () => {
      const fresh = new LocalAudioServer()
      assert.equal(fresh.getPort(), 0)
    })

    it('returns the same positive port on repeated calls while listening', () => {
      const p = server.getPort()
      assert.ok(p > 0)
      assert.equal(server.getPort(), p)
    })
  })

  describe('registerBot / unregisterBot', () => {
    it('wires onBinary, onJson and onClose handlers from the registered object', (done) => {
      const seen = { json: false, bin: false }
      server.registerBot('/bot-wire', {
        onJson: (j) => { assert.equal(j.k, 'v'); seen.json = true },
        onBinary: (trackIndex, pcm) => {
          assert.equal(trackIndex, 7)
          assert.equal(pcm.length, 2)
          seen.bin = true
        },
        onClose: () => { assert.ok(seen.json && seen.bin); done() }
      })
      const ws = connect('/bot-wire')
      ws.on('open', () => {
        ws.send(JSON.stringify({ k: 'v' }))
        ws.send(frame(7, Buffer.from([0x01, 0x02])))
        // Give the two messages a tick to be dispatched before closing.
        setTimeout(() => ws.close(), 30)
      })
    })

    it('a second registerBot on the same path replaces the handlers (last wins)', (done) => {
      server.registerBot('/bot-dup', { onJson: () => { throw new Error('stale handler must not fire') } })
      server.registerBot('/bot-dup', { onJson: (j) => { assert.equal(j.v, 2); done() } })
      const ws = connect('/bot-dup')
      ws.on('open', () => ws.send(JSON.stringify({ v: 2 })))
    })

    it('does not normalize the path: "/x" and "/x/" are distinct handlers', (done) => {
      server.registerBot('/x', { onJson: () => { throw new Error('"/x" must not receive "/x/" traffic') } })
      server.registerBot('/x/', { onJson: (j) => { assert.equal(j.where, 'trailing'); done() } })
      const ws = connect('/x/')
      ws.on('open', () => ws.send(JSON.stringify({ where: 'trailing' })))
    })

    it('unregisterBot on an unknown path is a no-op (no throw)', () => {
      assert.doesNotThrow(() => server.unregisterBot('/never-registered'))
    })

    it('unregisterBot removes the handler so later connections are rejected', (done) => {
      server.registerBot('/bot-gone', { onJson: () => {} })
      server.unregisterBot('/bot-gone')
      const ws = connect('/bot-gone')
      ws.on('close', () => done())
    })
  })

  describe('binary frame parsing over the wire', () => {
    it('ignores a frame shorter than the 4-byte header without crashing', (done) => {
      const seen = []
      server.registerBot('/bot-short', {
        onBinary: (trackIndex, pcm) => {
          // Only the valid trailing frame must reach onBinary; the short one is dropped.
          seen.push({ trackIndex, pcm: [...pcm] })
          assert.equal(seen.length, 1)
          assert.equal(trackIndex, 3)
          assert.deepEqual(seen[0].pcm, [0xaa, 0xbb])
          done()
        }
      })
      const ws = connect('/bot-short')
      ws.on('open', () => {
        ws.send(Buffer.from([0x00, 0x01])) // 2 bytes, sub-header -> dropped
        ws.send(frame(3, Buffer.from([0xaa, 0xbb]))) // valid -> delivered
      })
    })

    it('ignores an exact-header-only frame (zero PCM, length === HEADER_BYTES)', (done) => {
      const seen = []
      server.registerBot('/bot-exact', {
        onBinary: (trackIndex, pcm) => {
          // The 4-byte (header-only) frame is dropped; only the >4-byte trailer arrives.
          seen.push(pcm.length)
          assert.equal(seen.length, 1)
          assert.equal(trackIndex, 9)
          assert.equal(pcm.length, 2)
          done()
        }
      })
      const ws = connect('/bot-exact')
      ws.on('open', () => {
        ws.send(frame(9)) // exactly 4 bytes, no PCM -> dropped
        ws.send(frame(9, Buffer.from([0x10, 0x20]))) // delivered
      })
    })

    it('decodes a high trackIndex via uint16BE and slices PCM after the header', (done) => {
      server.registerBot('/bot-hi', {
        onBinary: (trackIndex, pcm) => {
          assert.equal(trackIndex, 0xBEEF)
          assert.deepEqual([...pcm], [1, 2, 3, 4, 5, 6])
          done()
        }
      })
      const ws = connect('/bot-hi')
      ws.on('open', () => ws.send(frame(0xBEEF, Buffer.from([1, 2, 3, 4, 5, 6]))))
    })

    it('does not crash when onBinary is absent on a valid binary frame', (done) => {
      // No onBinary handler: the binary frame must be silently ignored, and a
      // following JSON frame must still be handled (server survived the frame).
      server.registerBot('/bot-nobin', {
        onJson: (j) => { assert.equal(j.ping, true); done() }
      })
      const ws = connect('/bot-nobin')
      ws.on('open', () => {
        ws.send(frame(1, Buffer.from([0x00, 0x01]))) // no onBinary -> ignored
        ws.send(JSON.stringify({ ping: true })) // still dispatched
      })
    })
  })

  describe('JSON-on-binary sniff', () => {
    it('routes a binary frame starting with `{"` to onJson, not onBinary', (done) => {
      server.registerBot('/bot-sniff', {
        onBinary: () => { throw new Error('a {"-prefixed binary frame must go to onJson') },
        onJson: (j) => { assert.equal(j.type, 'participantMapping'); done() }
      })
      const ws = connect('/bot-sniff')
      ws.on('open', () => {
        // Send JSON text as an explicit BINARY frame.
        ws.send(Buffer.from(JSON.stringify({ type: 'participantMapping' })), { binary: true })
      })
    })

    it('treats a binary frame starting with `{` but not `{"` as PCM, not JSON', (done) => {
      // First byte 0x7B ('{'), second byte not 0x22 -> fails the sniff -> PCM path.
      server.registerBot('/bot-nosniff', {
        onJson: () => { throw new Error('"{x" must not be parsed as JSON') },
        onBinary: (trackIndex, pcm) => {
          // header u16BE of bytes [0x7B,0x78] = 0x7B78
          assert.equal(trackIndex, 0x7B78)
          assert.deepEqual([...pcm], [0x99, 0x88])
          done()
        }
      })
      const ws = connect('/bot-nosniff')
      ws.on('open', () => {
        ws.send(Buffer.from([0x7B, 0x78, 0x00, 0x00, 0x99, 0x88]), { binary: true })
      })
    })
  })

  describe('connection close and lifecycle', () => {
    it('fires onClose when the client drops the connection', (done) => {
      server.registerBot('/bot-drop', { onClose: () => done() })
      const ws = connect('/bot-drop')
      ws.on('open', () => ws.close())
    })

    it('supports multiple concurrent connections on distinct paths', (done) => {
      const got = {}
      const finish = () => { if (got[1] && got[2] && got[3]) done() }
      for (const i of [1, 2, 3]) {
        const p = `/multi-${i}`
        server.registerBot(p, { onJson: (j) => { assert.equal(j.i, i); got[i] = true; finish() } })
        const ws = connect(p)
        ws.on('open', () => ws.send(JSON.stringify({ i })))
      }
    })

    it('ignores (and closes) a connection whose path has no handler while others work', (done) => {
      server.registerBot('/live', { onJson: (j) => { assert.equal(j.ok, true); done() } })
      const dead = connect('/dead')
      dead.on('close', () => {
        const live = connect('/live')
        live.on('open', () => live.send(JSON.stringify({ ok: true })))
      })
    })

    it('does not throw and cleans up handlers/connections when stop() runs during an active connection', (done) => {
      server.registerBot('/bot-active', { onJson: () => {} })
      const ws = connect('/bot-active')
      ws.on('open', async () => {
        await assert.doesNotReject(() => server.stop())
        assert.equal(server.handlers.size, 0)
        assert.equal(server.connections.size, 0)
        assert.equal(server.wss, null)
        assert.equal(server.server, null)
        done()
      })
    })

    it('stop() is idempotent (a second stop on a stopped server does not throw)', async () => {
      await assert.doesNotReject(() => server.stop())
      await assert.doesNotReject(() => server.stop())
    })
  })

  describe('_dispatch logic (direct, deterministic)', () => {
    // Drive _dispatch directly with a fake handler — no socket, fully synchronous.
    const dispatch = (handler, message, isBinary) =>
      server._dispatch('/p', handler, message, isBinary)

    it('routes a JS string message to onJson', () => {
      let seen = null
      dispatch({ onJson: (j) => { seen = j } }, JSON.stringify({ a: 1 }), false)
      assert.deepEqual(seen, { a: 1 })
    })

    it('routes a non-binary Buffer (isBinary === false) to onJson via toString', () => {
      let seen = null
      dispatch({ onJson: (j) => { seen = j } }, Buffer.from(JSON.stringify({ b: 2 })), false)
      assert.deepEqual(seen, { b: 2 })
    })

    it('ignores a message that is neither string nor Buffer', () => {
      let called = false
      const h = { onJson: () => { called = true }, onBinary: () => { called = true } }
      assert.doesNotThrow(() => dispatch(h, { not: 'a buffer' }, true))
      assert.equal(called, false)
    })

    it('swallows malformed JSON without throwing and without calling onJson with garbage', () => {
      let calls = 0
      assert.doesNotThrow(() => dispatch({ onJson: () => { calls++ } }, '{not valid json', false))
      // onJson is only called on successful parse, so a parse error means 0 calls.
      assert.equal(calls, 0)
    })

    it('does nothing when onJson is missing for a JSON message', () => {
      assert.doesNotThrow(() => dispatch({}, JSON.stringify({ x: 1 }), false))
    })

    it('passes a Buffer subarray (view) to onBinary, not a copy of the header', () => {
      let captured = null
      dispatch({ onBinary: (_t, pcm) => { captured = pcm } }, frame(5, Buffer.from([7, 8, 9])), true)
      assert.deepEqual([...captured], [7, 8, 9])
    })

    it('ignores a binary frame of exactly HEADER_BYTES length', () => {
      let called = false
      dispatch({ onBinary: () => { called = true } }, frame(1), true)
      assert.equal(called, false)
    })

    it('ignores a sub-header binary frame', () => {
      let called = false
      dispatch({ onBinary: () => { called = true } }, Buffer.from([0x00]), true)
      assert.equal(called, false)
    })
  })
})
