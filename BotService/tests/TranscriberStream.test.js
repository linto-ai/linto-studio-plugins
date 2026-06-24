const assert = require('assert')
const EventEmitter = require('events')
const { describe, it, beforeEach } = require('mocha')
const TranscriberStream = require('../bot/TranscriberStream')

class FakeWs extends EventEmitter {
  constructor () { super(); this.readyState = TranscriberStream.OPEN; this.sent = []; this.closed = false }
  send (data) { this.sent.push(data) }
  // Mirror the real ws: close() flips state and emits 'close' so the watchdog's
  // teardown drives the same path a real socket close would.
  close () { this.closed = true; this.readyState = 3; this.emit('close') }
}

function fakeBot () {
  const bot = new EventEmitter()
  bot.manifest = { diarizationMode: 'native' }
  bot.getParticipantsList = () => [{ id: 'u1', name: 'Alice' }]
  return bot
}

const jsonFrames = (ws) => ws.sent.filter(x => typeof x === 'string').map(JSON.parse)
const audioFrames = (ws) => ws.sent.filter(x => Buffer.isBuffer(x))

describe('TranscriberStream', () => {
  let ws, bot
  beforeEach(() => { ws = new FakeWs(); bot = fakeBot(); new TranscriberStream(ws, bot, { maxBuffer: 3 }) })

  it('sends the init handshake on open', () => {
    ws.emit('open')
    const init = jsonFrames(ws)[0]
    assert.equal(init.type, 'init')
    assert.equal(init.encoding, 'pcm')
    assert.equal(init.sampleRate, 16000)
    assert.equal(init.diarizationMode, 'native')
    assert.deepEqual(init.participants, [{ id: 'u1', name: 'Alice' }])
  })

  it('buffers audio until ack, then flushes in order', () => {
    ws.emit('open')
    bot.emit('audio', Buffer.from([1]))
    bot.emit('audio', Buffer.from([2]))
    assert.equal(audioFrames(ws).length, 0, 'no audio before ack')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    const audio = audioFrames(ws)
    assert.equal(audio.length, 2)
    assert.deepEqual([...audio[0]], [1])
    assert.deepEqual([...audio[1]], [2])
  })

  it('sends audio immediately once ready', () => {
    ws.emit('open')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    bot.emit('audio', Buffer.from([9]))
    assert.equal(audioFrames(ws).length, 1)
  })

  it('drops the oldest buffered frame past maxBuffer', () => {
    ws.emit('open')
    for (let i = 1; i <= 5; i++) bot.emit('audio', Buffer.from([i])) // cap 3
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    const audio = audioFrames(ws)
    assert.equal(audio.length, 3)
    assert.deepEqual([...audio[0]], [3]) // 1 and 2 dropped
    assert.deepEqual([...audio[2]], [5])
  })

  it('counts pre-ack frames dropped past maxBuffer', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { maxBuffer: 3 })
    ws2.emit('open')
    // maxBuffer is 3. 5 frames -> 2 dropped (oldest first).
    for (let i = 1; i <= 5; i++) bot2.emit('audio', Buffer.from([i]))
    assert.equal(stream.getDroppedFrames(), 2)
    ws2.emit('message', JSON.stringify({ type: 'ack' }))
    assert.equal(stream.getDroppedFrames(), 2, 'drop count is stable after flush')
  })

  it('does not count drops when the buffer never overflows', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { maxBuffer: 10 })
    ws2.emit('open')
    for (let i = 1; i <= 5; i++) bot2.emit('audio', Buffer.from([i]))
    assert.equal(stream.getDroppedFrames(), 0)
  })

  it('forwards speakerChanged and participant events as soon as the socket is open (not ack-gated)', () => {
    // Control is NOT ack-gated: the Transcriber creates its SpeakerTracker while
    // processing init (before ack) and tolerates control before audio, so a
    // speaker boundary during the handshake must not be dropped.
    ws.emit('open')
    bot.emit('speakerChanged', { type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } })
    assert.equal(jsonFrames(ws).filter(f => f.type === 'speakerChanged').length, 1, 'sent pre-ack once open')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    bot.emit('participant-joined', { identity: 'u2', name: 'Bob' })
    bot.emit('participant-left', { identity: 'u2', name: 'Bob' })
    const frames = jsonFrames(ws)
    assert.ok(frames.some(f => f.type === 'participant' && f.action === 'join' && f.participant.id === 'u2'))
    assert.ok(frames.some(f => f.type === 'participant' && f.action === 'leave' && f.participant.id === 'u2'))
  })

  it('does not send control before the socket is open', () => {
    bot.emit('speakerChanged', { type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } })
    // ws starts OPEN in the fake; simulate a not-yet-open socket explicitly.
    const ws2 = new FakeWs(); ws2.readyState = 0 // CONNECTING
    const bot2 = fakeBot(); new TranscriberStream(ws2, bot2)
    bot2.emit('speakerChanged', { type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } })
    assert.equal(ws2.sent.length, 0)
  })

  it('does not send audio when the socket is not open', () => {
    ws.emit('open')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    ws.readyState = 3 // CLOSED
    bot.emit('audio', Buffer.from([1]))
    assert.equal(audioFrames(ws).length, 0)
  })

  it('retains the audio buffer across a reconnect and flushes it in order on the new ack', () => {
    // A shared buffer object survives the socket teardown (the BrokerClient owns
    // it on the bot record); a fresh stream over a new socket reuses it.
    const shared = { buffered: [], droppedFrames: 0 }
    const ws1 = new FakeWs(); const bot1 = fakeBot()
    const s1 = new TranscriberStream(ws1, bot1, { maxBuffer: 10, buffer: shared })
    ws1.emit('open')
    // No ack yet: frames produced during the (about-to-drop) connection are held.
    bot1.emit('audio', Buffer.from([1]))
    bot1.emit('audio', Buffer.from([2]))
    assert.equal(audioFrames(ws1).length, 0, 'not flushed without ack')
    // Socket drops; the shared buffer is NOT cleared (no _flush ran). The dead
    // stream detaches from the bot (as the BrokerClient does on reconnect).
    ws1.readyState = 3
    s1.detach()
    assert.equal(shared.buffered.length, 2, 'buffer retained across the drop')

    // Reconnect: a new stream over a new socket, reusing the same buffer.
    const ws2 = new FakeWs(); new TranscriberStream(ws2, bot1, { maxBuffer: 10, buffer: shared })
    ws2.emit('open')
    // More audio arrives during the gap, before the re-ack: also retained.
    bot1.emit('audio', Buffer.from([3]))
    assert.equal(audioFrames(ws2).length, 0, 'still ack-gated on the new socket')
    ws2.emit('message', JSON.stringify({ type: 'ack' }))
    const audio = audioFrames(ws2)
    assert.equal(audio.length, 3, 'all retained frames flushed on re-ack')
    assert.deepEqual([...audio[0]], [1])
    assert.deepEqual([...audio[1]], [2])
    assert.deepEqual([...audio[2]], [3])
    assert.equal(shared.buffered.length, 0, 'buffer drained after flush')
  })

  it('fires the init-ack watchdog when no ack arrives, closing the socket and signalling an error', (done) => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    let errored = null
    bot2.on('transcriber-error', (e) => { errored = e })
    new TranscriberStream(ws2, bot2, { ackTimeoutMs: 15 })
    ws2.emit('open') // init sent, watchdog armed; NO ack will come
    setTimeout(() => {
      assert.ok(errored instanceof Error, 'a transcriber-error was emitted on ack timeout')
      assert.equal(ws2.closed, true, 'the hung socket was closed so the reconnect-or-stop path engages')
      done()
    }, 40)
  })

  it('does NOT fire the watchdog once an ack arrives (happy path)', (done) => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    let errored = false
    bot2.on('transcriber-error', () => { errored = true })
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 15 })
    ws2.emit('open')
    ws2.emit('message', JSON.stringify({ type: 'ack' })) // ack before the timeout
    assert.equal(stream._ackTimer, null, 'watchdog cancelled on ack')
    setTimeout(() => {
      assert.equal(errored, false, 'no error fired after a timely ack')
      assert.equal(ws2.closed, false, 'socket not closed on the happy path')
      done()
    }, 40)
  })

  it('cancels the watchdog on close and on dispose (no leaked timer)', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    ws2.emit('open')
    assert.notEqual(stream._ackTimer, null, 'watchdog armed on open')
    ws2.emit('close')
    assert.equal(stream._ackTimer, null, 'watchdog cancelled on socket close')

    const ws3 = new FakeWs(); const bot3 = fakeBot()
    const stream3 = new TranscriberStream(ws3, bot3, { ackTimeoutMs: 1000 })
    ws3.emit('open')
    stream3.dispose()
    assert.equal(stream3._ackTimer, null, 'watchdog cancelled on dispose')
    assert.equal(stream3._disposed, true)
  })

  it('the dropped-frames counter is preserved across a reconnect', () => {
    const shared = { buffered: [], droppedFrames: 0 }
    const ws1 = new FakeWs(); const bot1 = fakeBot()
    const s1 = new TranscriberStream(ws1, bot1, { maxBuffer: 2, buffer: shared })
    ws1.emit('open')
    for (let i = 1; i <= 5; i++) bot1.emit('audio', Buffer.from([i])) // cap 2 -> 3 dropped
    assert.equal(s1.getDroppedFrames(), 3)
    ws1.readyState = 3

    const ws2 = new FakeWs(); const s2 = new TranscriberStream(ws2, bot1, { maxBuffer: 2, buffer: shared })
    assert.equal(s2.getDroppedFrames(), 3, 'drop count carried over to the reconnected stream')
  })
})
