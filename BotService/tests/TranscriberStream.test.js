const assert = require('assert')
const EventEmitter = require('events')
const { describe, it, beforeEach } = require('mocha')
const TranscriberStream = require('../bot/TranscriberStream')

class FakeWs extends EventEmitter {
  constructor () { super(); this.readyState = TranscriberStream.OPEN; this.sent = [] }
  send (data) { this.sent.push(data) }
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

  it('forwards speakerChanged and participant events only after ready', () => {
    ws.emit('open')
    bot.emit('speakerChanged', { type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } })
    assert.equal(jsonFrames(ws).filter(f => f.type === 'speakerChanged').length, 0, 'gated before ack')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    bot.emit('speakerChanged', { type: 'speakerChanged', position: 20, speaker: { id: 'u1', name: 'Alice' } })
    bot.emit('participant-joined', { identity: 'u2', name: 'Bob' })
    bot.emit('participant-left', { identity: 'u2', name: 'Bob' })
    const frames = jsonFrames(ws)
    assert.ok(frames.some(f => f.type === 'speakerChanged' && f.position === 20))
    assert.ok(frames.some(f => f.type === 'participant' && f.action === 'join' && f.participant.id === 'u2'))
    assert.ok(frames.some(f => f.type === 'participant' && f.action === 'leave' && f.participant.id === 'u2'))
  })

  it('does not send when the socket is not open', () => {
    ws.emit('open')
    ws.emit('message', JSON.stringify({ type: 'ack' }))
    ws.readyState = 3 // CLOSED
    bot.emit('audio', Buffer.from([1]))
    assert.equal(audioFrames(ws).length, 0)
  })
})
