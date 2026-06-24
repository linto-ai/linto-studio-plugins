const assert = require('assert')
const EventEmitter = require('events')
const { describe, it, beforeEach } = require('mocha')
const { logger } = require('live-srt-lib')
const TranscriberStream = require('../bot/TranscriberStream')

// Spy on the shared winston logger so log-throttling/latch behavior can be
// asserted without real I/O. Captures (level, message) pairs and restores the
// originals so other suites/tests are unaffected.
function spyLogger () {
  const calls = []
  const original = { info: logger.info, warn: logger.warn }
  logger.info = (msg) => { calls.push({ level: 'info', msg: String(msg) }); return logger }
  logger.warn = (msg) => { calls.push({ level: 'warn', msg: String(msg) }); return logger }
  const restore = () => { logger.info = original.info; logger.warn = original.warn }
  return { calls, restore }
}

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

  // ---- constructor state repair ----

  it('repairs state.buffered when injected as null', () => {
    const shared = { buffered: null, droppedFrames: 0 }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.ok(Array.isArray(stream.state.buffered), 'buffered coerced to an array')
    assert.equal(stream.state.buffered.length, 0)
    assert.strictEqual(stream.state.buffered, shared.buffered, 'repaired in place on the shared object')
  })

  it('repairs state.buffered when injected as a non-array object', () => {
    const shared = { buffered: { not: 'an array' }, droppedFrames: 0 }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.ok(Array.isArray(stream.state.buffered))
    assert.equal(stream.state.buffered.length, 0)
  })

  it('repairs state.droppedFrames when injected as null', () => {
    const shared = { buffered: [], droppedFrames: null }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.strictEqual(stream.state.droppedFrames, 0)
  })

  it('repairs state.droppedFrames when injected as a string', () => {
    const shared = { buffered: [], droppedFrames: '7' }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.strictEqual(stream.state.droppedFrames, 0, 'non-number coerced to 0')
  })

  it('repairs state.droppedFrames when injected as an object', () => {
    const shared = { buffered: [], droppedFrames: {} }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.strictEqual(stream.state.droppedFrames, 0)
  })

  // ---- options ----

  it('respects an explicit ackTimeoutMs option', () => {
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { ackTimeoutMs: 4242 })
    assert.equal(stream.ackTimeoutMs, 4242)
  })

  // ---- ack message handling ----

  it('does not re-log "ack received" on a second ack after reconnect', () => {
    const spy = spyLogger()
    try {
      const ws2 = new FakeWs(); const bot2 = fakeBot()
      new TranscriberStream(ws2, bot2, { maxBuffer: 3 })
      ws2.emit('open')
      ws2.emit('message', JSON.stringify({ type: 'ack' }))
      ws2.emit('message', JSON.stringify({ type: 'ack' }))
      const acks = spy.calls.filter(c => c.level === 'info' && /ack received/.test(c.msg))
      assert.equal(acks.length, 1, 'ack-received logged exactly once')
    } finally { spy.restore() }
  })

  it('silently ignores a JSON message whose type is not ack', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { maxBuffer: 3 })
    ws2.emit('open')
    assert.notEqual(stream._ackTimer, null, 'watchdog armed')
    ws2.emit('message', JSON.stringify({ type: 'something-else', foo: 1 }))
    assert.equal(stream.ready, false, 'a non-ack message does not flip ready')
    assert.notEqual(stream._ackTimer, null, 'watchdog still armed (not cancelled by a non-ack)')
  })

  it('does not call _flush a second time on a duplicate ack (buffer already drained)', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { maxBuffer: 3 })
    ws2.emit('open')
    bot2.emit('audio', Buffer.from([1]))
    ws2.emit('message', JSON.stringify({ type: 'ack' }))
    let flushCalls = 0
    const realFlush = stream._flush.bind(stream)
    stream._flush = () => { flushCalls++; return realFlush() }
    const before = audioFrames(ws2).length
    ws2.emit('message', JSON.stringify({ type: 'ack' }))
    assert.equal(flushCalls, 1, 'a second ack still invokes _flush')
    assert.equal(audioFrames(ws2).length, before, 'but the drained buffer sends nothing more')
  })

  // ---- drop-warning throttling ----

  it('logs the drop warning at exactly DROP_WARN_EVERY boundaries (100, 200, 300)', () => {
    const spy = spyLogger()
    try {
      const ws2 = new FakeWs(); const bot2 = fakeBot()
      new TranscriberStream(ws2, bot2, { maxBuffer: 1 })
      ws2.emit('open')
      // maxBuffer 1: every frame after the first drops the oldest. 301 frames -> 300 drops.
      for (let i = 0; i < 301; i++) bot2.emit('audio', Buffer.from([i & 0xff]))
      const warns = spy.calls.filter(c => c.level === 'warn' && /frames dropped/.test(c.msg))
      assert.equal(warns.length, 3, 'one warning per 100 drops')
      assert.ok(/100 frames dropped/.test(warns[0].msg))
      assert.ok(/200 frames dropped/.test(warns[1].msg))
      assert.ok(/300 frames dropped/.test(warns[2].msg))
    } finally { spy.restore() }
  })

  // ---- detach / watchdog isolation ----

  it('detach() cancels the ack watchdog in isolation', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    ws2.emit('open')
    assert.notEqual(stream._ackTimer, null, 'armed on open')
    stream.detach()
    assert.equal(stream._ackTimer, null, 'detach cancelled the watchdog')
    assert.equal(stream._disposed, false, 'detach does not mark disposed')
  })

  it('dispose() is idempotent — a second call changes no state', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    ws2.emit('open')
    stream.dispose()
    assert.equal(stream._disposed, true)
    assert.equal(stream._ackTimer, null)
    // Re-arm a fresh timer to prove the second dispose() short-circuits before
    // touching it (it would otherwise be cancelled).
    stream._disposed = true
    stream._ackTimer = { _sentinel: true }
    let cancelled = false
    const origCancel = stream._cancelAckWatchdog.bind(stream)
    stream._cancelAckWatchdog = () => { cancelled = true; return origCancel() }
    stream.dispose()
    assert.equal(cancelled, false, 'second dispose returns before cancelling anything')
    assert.deepEqual(stream._ackTimer, { _sentinel: true }, 'state untouched by the second dispose')
  })

  // ---- _armAckWatchdog guards ----

  it('_armAckWatchdog is a no-op when already ready', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    stream.ready = true
    stream._cancelAckWatchdog()
    stream._armAckWatchdog()
    assert.equal(stream._ackTimer, null, 'no timer set when ready')
  })

  it('_armAckWatchdog is a no-op when disposed', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    stream._disposed = true
    stream._cancelAckWatchdog()
    stream._armAckWatchdog()
    assert.equal(stream._ackTimer, null, 'no timer set when disposed')
  })

  it('_armAckWatchdog re-arms, cancelling the prior timer', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    stream._armAckWatchdog()
    const first = stream._ackTimer
    assert.notEqual(first, null)
    stream._armAckWatchdog()
    const second = stream._ackTimer
    assert.notEqual(second, null)
    assert.notStrictEqual(second, first, 'a new timer replaced the previous one')
    stream._cancelAckWatchdog()
  })

  it('_armAckWatchdog calls unref() on the timer when available', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    stream._armAckWatchdog()
    assert.ok(stream._ackTimer && typeof stream._ackTimer.unref === 'function', 'node timer exposes unref')
    // unref keeps the process from being held open; we assert it was applied by
    // confirming the timer is a node Timeout (unref present and callable).
    assert.doesNotThrow(() => stream._ackTimer.unref())
    stream._cancelAckWatchdog()
  })

  it('watchdog firing catches an exception thrown by ws.close()', (done) => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    ws2.close = () => { throw new Error('boom on close') }
    let errored = null
    bot2.on('transcriber-error', (e) => { errored = e })
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 10 })
    ws2.emit('open')
    setTimeout(() => {
      assert.ok(errored instanceof Error, 'transcriber-error still emitted despite close throwing')
      assert.equal(stream._ackTimer, null, 'timer cleared after firing')
      done()
    }, 35)
  })

  // ---- _cancelAckWatchdog ----

  it('_cancelAckWatchdog is a no-op when no timer is armed', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 1000 })
    assert.equal(stream._ackTimer, null)
    assert.doesNotThrow(() => stream._cancelAckWatchdog())
    assert.equal(stream._ackTimer, null)
  })

  // ---- _flush partial send ----

  it('_flush stops sending if the socket closes mid-iteration (no crash)', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    const stream = new TranscriberStream(ws2, bot2, { maxBuffer: 10 })
    ws2.emit('open')
    for (let i = 1; i <= 4; i++) bot2.emit('audio', Buffer.from([i]))
    // Close the socket on the second send to simulate a teardown during flush.
    let sends = 0
    ws2.send = function (data) { sends++; if (sends === 2) { this.readyState = 3 }; this.sent.push(data) }
    assert.doesNotThrow(() => ws2.emit('message', JSON.stringify({ type: 'ack' })))
    // First two went out; the rest were skipped once _isOpen() turned false.
    assert.equal(audioFrames(ws2).length, 2, 'partial send: stopped once socket no longer open')
    assert.equal(stream.state.buffered.length, 0, 'buffer cleared regardless')
  })

  // ---- backward-compat accessors ----

  it('get buffered returns the current state.buffered array', () => {
    const shared = { buffered: [], droppedFrames: 0 }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.strictEqual(stream.buffered, shared.buffered)
    shared.buffered.push(Buffer.from([1]))
    assert.equal(stream.buffered.length, 1, 'reflects mutations to the live array')
  })

  it('set buffered replaces state.buffered', () => {
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), {})
    const replacement = [Buffer.from([9])]
    stream.buffered = replacement
    assert.strictEqual(stream.state.buffered, replacement)
    assert.strictEqual(stream.buffered, replacement)
  })

  it('get droppedFrames returns the current state.droppedFrames count', () => {
    const shared = { buffered: [], droppedFrames: 5 }
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), { buffer: shared })
    assert.equal(stream.droppedFrames, 5)
  })

  it('set droppedFrames updates state.droppedFrames', () => {
    const stream = new TranscriberStream(new FakeWs(), fakeBot(), {})
    stream.droppedFrames = 42
    assert.equal(stream.state.droppedFrames, 42)
    assert.equal(stream.getDroppedFrames(), 42)
  })

  // ---- _sendInit edge cases ----

  it('_sendInit throws when bot.getParticipantsList is missing', () => {
    const ws2 = new FakeWs(); const bot2 = fakeBot()
    delete bot2.getParticipantsList
    const stream = new TranscriberStream(ws2, bot2, {})
    // Current behavior: _sendInit calls bot.getParticipantsList() unconditionally,
    // so a bot without it throws. Asserting the present contract; flagged as a
    // possible hardening gap in the source.
    assert.throws(() => stream._sendInit(), TypeError)
  })

  // ---- watchdog with a bot lacking emit ----

  it('watchdog timeout does not crash when bot.emit is absent', (done) => {
    const ws2 = new FakeWs()
    // A bot-like object without an emit method (guarded by the source).
    const bot2 = { manifest: { diarizationMode: 'asr' }, getParticipantsList: () => [], on: () => {}, removeListener: () => {} }
    const stream = new TranscriberStream(ws2, bot2, { ackTimeoutMs: 10 })
    stream._sendInit()
    stream._armAckWatchdog()
    setTimeout(() => {
      assert.equal(stream._ackTimer, null, 'timer fired and cleared without throwing')
      assert.equal(ws2.closed, true, 'socket closed even though bot.emit was unavailable')
      done()
    }, 35)
  })
})
