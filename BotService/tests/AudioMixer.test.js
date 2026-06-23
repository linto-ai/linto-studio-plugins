const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const AudioMixer = require('../bot/AudioMixer')

const frame = (value, n = 320) => Buffer.from(new Int16Array(n).fill(value).buffer)

describe('AudioMixer', () => {
  let mixer
  beforeEach(() => { mixer = new AudioMixer() })
  afterEach(() => { mixer.stop() })

  describe('#addAudio()', () => {
    it('registers a participant on first audio', () => {
      mixer.addAudio('p1', Buffer.from(new Int16Array([1000, 2000, 3000]).buffer), 0)
      assert.equal(mixer.hasParticipant('p1'), true)
    })

    it('tracks multiple participants', () => {
      mixer.addAudio('p1', frame(1000, 2), 0)
      mixer.addAudio('p2', frame(500, 2), 0)
      assert.deepEqual(mixer.getParticipants().map(p => p.id).sort(), ['p1', 'p2'])
    })

    it('copies an unaligned (odd byteOffset) buffer without throwing', () => {
      const backing = Buffer.alloc(6)
      backing.writeInt16LE(1234, 0)
      const unaligned = backing.subarray(1) // odd byteOffset
      assert.doesNotThrow(() => mixer.addAudio('p1', unaligned, 0))
    })
  })

  describe('#removeParticipant()', () => {
    it('forgets the participant', () => {
      mixer.addAudio('p1', frame(1000, 3), 0)
      mixer.removeParticipant('p1')
      assert.equal(mixer.hasParticipant('p1'), false)
    })

    it('clears the current speaker if it was the removed participant', () => {
      mixer.addAudio('p1', frame(5000), 0)
      mixer.mixAndEmit()
      assert.equal(mixer.getCurrentSpeaker().id, 'p1')
      mixer.removeParticipant('p1')
      assert.equal(mixer.getCurrentSpeaker(), null)
    })
  })

  describe('#start()/#stop()', () => {
    it('is idempotent', () => {
      mixer.start()
      const handle = mixer.mixInterval
      mixer.start()
      assert.equal(mixer.mixInterval, handle)
      mixer.stop()
      assert.equal(mixer.mixInterval, null)
    })
  })

  describe('#mixAndEmit()', () => {
    it('emits a 640-byte (320-sample) S16LE frame', (done) => {
      mixer.addAudio('p1', frame(1000), 0)
      mixer.on('audio', (buf) => { assert.equal(buf.length, 640); done() })
      mixer.mixAndEmit()
    })

    it('sums participants additively', (done) => {
      mixer.addAudio('p1', frame(1000), 0)
      mixer.addAudio('p2', frame(500), 0)
      mixer.on('audio', (buf) => {
        const m = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
        assert.equal(m[0], 1500)
        done()
      })
      mixer.mixAndEmit()
    })

    it('clips the mix at +32767', (done) => {
      mixer.addAudio('p1', frame(30000), 0)
      mixer.addAudio('p2', frame(20000), 0)
      mixer.on('audio', (buf) => {
        const m = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
        assert.equal(m[0], 32767)
        done()
      })
      mixer.mixAndEmit()
    })

    it('emits speakerChanged for the highest-energy speaker above threshold', (done) => {
      mixer.addAudio('p1', frame(1000), 0)
      mixer.addAudio('p2', frame(5000), 0)
      mixer.on('speakerChanged', (ev) => {
        assert.equal(ev.type, 'speakerChanged')
        assert.equal(ev.speaker.id, 'p2')
        assert.ok(ev.position >= 0)
        done()
      })
      mixer.mixAndEmit()
    })

    it('does not emit speakerChanged below the energy threshold', (done) => {
      mixer.addAudio('quiet', frame(100), 0)
      let emitted = false
      mixer.on('speakerChanged', () => { emitted = true })
      mixer.on('audio', () => setTimeout(() => { assert.equal(emitted, false); done() }, 5))
      mixer.mixAndEmit()
    })

    it('does not emit an audio frame when no participant contributed (silence skip)', () => {
      let frames = 0
      mixer.on('audio', () => { frames++ })
      mixer.mixAndEmit() // no participants at all
      mixer.addAudio('p1', frame(1000), 0)
      mixer.mixAndEmit() // p1 has a full frame -> emits
      mixer.mixAndEmit() // p1 drained, nothing new -> skipped
      assert.equal(frames, 1)
    })

    it('emits a single transition while the same speaker keeps talking', () => {
      mixer.addAudio('p1', frame(5000), 0)
      let count = 0
      mixer.on('speakerChanged', () => { count++ })
      mixer.mixAndEmit()
      mixer.addAudio('p1', frame(5000), 0)
      mixer.mixAndEmit()
      assert.equal(count, 1)
    })
  })

  describe('#getDroppedStats()', () => {
    it('reports zero drops for a participant within the ring capacity', () => {
      mixer.addAudio('p1', frame(1000, 320), 0)
      const stats = mixer.getDroppedStats()
      assert.equal(stats.length, 1)
      assert.equal(stats[0].id, 'p1')
      assert.equal(stats[0].droppedSamples, 0)
      assert.equal(stats[0].droppedFrames, 0)
    })

    it('counts samples overwritten on ring-buffer overflow', () => {
      // bufferSize = 320 samples/frame * 160 frames = 51200 samples.
      // Write 51200 + 1000 samples without draining -> 1000 dropped.
      const overflow = new AudioMixer({ bufferFrames: 160 })
      const big = Buffer.from(new Int16Array(51200 + 1000).fill(1000).buffer)
      overflow.addAudio('p1', big, 0)
      const stats = overflow.getDroppedStats()
      assert.equal(stats[0].droppedSamples, 1000)
      assert.equal(stats[0].droppedFrames, Math.floor(1000 / 320))
      overflow.stop()
    })

    it('does not count drops once frames are drained by the mix tick', () => {
      // Fill exactly to capacity, drain one frame, then add one frame: no overflow.
      const exact = new AudioMixer({ bufferFrames: 2 }) // 640-sample ring
      exact.addAudio('p1', frame(1000, 640), 0) // fills the ring exactly
      exact.mixAndEmit() // drains 320 samples
      exact.addAudio('p1', frame(1000, 320), 0) // fits in the freed space
      assert.equal(exact.getDroppedStats()[0].droppedSamples, 0)
      exact.stop()
    })
  })

  describe('#getPositionMs()', () => {
    it('advances 20 ms per mixed frame', () => {
      assert.equal(mixer.getPositionMs(), 0)
      mixer.addAudio('p1', frame(1000), 0)
      mixer.mixAndEmit()
      assert.equal(mixer.getPositionMs(), 20)
    })
  })
})
