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

    it('treats energy exactly AT the threshold as silence (strict >)', () => {
      // A constant-amplitude frame has RMS == |amplitude|. At exactly 500 the
      // `energy > energyThreshold` guard is false, so nobody becomes dominant.
      const m = new AudioMixer({ energyThreshold: 500 })
      m.addAudio('edge', frame(500), 0) // RMS == 500, NOT > 500
      let changed = false
      m.on('speakerChanged', () => { changed = true })
      m.mixAndEmit()
      assert.equal(changed, false)
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })

    it('treats energy one above the threshold as speech', () => {
      const m = new AudioMixer({ energyThreshold: 500 })
      m.addAudio('edge', frame(501), 0) // RMS == 501, > 500
      let speaker = null
      m.on('speakerChanged', (ev) => { speaker = ev.speaker })
      m.mixAndEmit()
      assert.ok(speaker && speaker.id === 'edge')
      m.stop()
    })

    it('breaks an exact energy tie in favour of the first-added participant', () => {
      // Both frames carry identical RMS; the dominant-speaker scan uses a strict
      // `energy > maxEnergy`, so the participant iterated first (insertion order
      // in the Map) wins and the equal-energy latecomer never displaces them.
      mixer.addAudio('first', frame(5000), 0)
      mixer.addAudio('second', frame(5000), 0)
      let speaker = null
      mixer.on('speakerChanged', (ev) => { speaker = ev.speaker })
      mixer.mixAndEmit()
      assert.equal(speaker.id, 'first')
    })

    it('does not flip speaker on a marginally-louder-then-equal tie within a frame', () => {
      // 'a' added first at a higher energy; 'b' added second exactly equal to 'a'
      // would not win (strict >), and a strictly louder 'b' would. Verify the
      // strictly-louder later participant DOES take over (sanity vs the tie case).
      mixer.addAudio('a', frame(3000), 0)
      mixer.addAudio('b', frame(6000), 0)
      let speaker = null
      mixer.on('speakerChanged', (ev) => { speaker = ev.speaker })
      mixer.mixAndEmit()
      assert.equal(speaker.id, 'b')
    })
  })

  describe('ring-buffer wraparound', () => {
    it('mixes the correct samples after the write pointer wraps past the end', () => {
      // 640-sample ring. Fill it, drain one frame, then write another frame: the
      // write pointer wraps to 0 and the second frame must be returned intact.
      const m = new AudioMixer({ bufferFrames: 2 })
      m.addAudio('p1', frame(1111, 640), 0) // fills the ring, writePos -> 0 (wrapped)
      const first = []
      m.on('audio', (buf) => { first.push(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)[0]) })
      m.mixAndEmit() // drains frame #1 (value 1111), readPos -> 320
      m.addAudio('p1', frame(2222, 320), 0) // written at writePos 0..319 (post-wrap region)
      m.mixAndEmit() // drains frame #2 (value 1111, the remaining tail) ...
      m.mixAndEmit() // ... then the wrapped frame (value 2222)
      assert.deepEqual(first, [1111, 1111, 2222])
      assert.equal(m.getDroppedStats()[0].droppedSamples, 0)
      m.stop()
    })

    it('keeps the freshest audio (drops oldest) when both pointers wrap on overflow', () => {
      // Ring holds 2 frames. Write 3 frames back-to-back without draining: the
      // first frame is overwritten, so the next two mixed frames are #2 and #3.
      const m = new AudioMixer({ bufferFrames: 2 })
      m.addAudio('p1', frame(100, 320), 0) // frame #1 (will be dropped)
      m.addAudio('p1', frame(200, 320), 0) // frame #2
      m.addAudio('p1', frame(300, 320), 0) // frame #3 -> overflow, drops 320 oldest samples
      const vals = []
      m.on('audio', (buf) => { vals.push(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)[0]) })
      m.mixAndEmit()
      m.mixAndEmit()
      assert.deepEqual(vals, [200, 300])
      assert.equal(m.getDroppedStats()[0].droppedSamples, 320)
      m.stop()
    })
  })

  describe('silence/grace transitions', () => {
    it('emits silence only after the grace period, then re-attributes on the next loud frame', () => {
      // Two participants so the silence (null-speaker) transition is allowed.
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 40 }) // 2 ticks of grace
      const events = []
      m.on('speakerChanged', (ev) => { events.push(ev.speaker ? ev.speaker.id : null) })
      m.addAudio('loud', frame(5000), 0)
      m.addAudio('quiet', frame(10), 0)
      m.mixAndEmit() // 'loud' becomes dominant -> ['loud']
      // Now everyone silent: grace is 40ms == 2 ticks; silence emitted on the 2nd.
      m.addAudio('loud', frame(10), 0); m.addAudio('quiet', frame(10), 0)
      m.mixAndEmit() // silence tick 1 (20ms) -> no transition yet
      m.addAudio('loud', frame(10), 0); m.addAudio('quiet', frame(10), 0)
      m.mixAndEmit() // silence tick 2 (40ms >= grace) -> null transition
      assert.deepEqual(events, ['loud', null])
      assert.equal(m.getCurrentSpeaker(), null)
      // A fresh loud frame re-attributes the speaker.
      m.addAudio('loud', frame(5000), 0); m.addAudio('quiet', frame(10), 0)
      m.mixAndEmit()
      assert.deepEqual(events, ['loud', null, 'loud'])
      m.stop()
    })

    it('never emits a silence transition for a lone participant (pauses are not boundaries)', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 20 })
      const events = []
      m.on('speakerChanged', (ev) => { events.push(ev.speaker ? ev.speaker.id : null) })
      m.addAudio('solo', frame(5000), 0)
      m.mixAndEmit() // -> ['solo']
      // Long silence from the only participant: size > 1 guard blocks the null event.
      for (let i = 0; i < 10; i++) { m.addAudio('solo', frame(10), 0); m.mixAndEmit() }
      assert.deepEqual(events, ['solo'])
      assert.equal(m.getCurrentSpeaker().id, 'solo')
      m.stop()
    })

    it('resets the silence accumulator so an intra-speech pause never crosses the grace', () => {
      // Speak, pause one tick (< grace), speak again: the silence counter resets
      // on the loud frame, so no null transition is ever emitted.
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 40 })
      const events = []
      m.on('speakerChanged', (ev) => { events.push(ev.speaker ? ev.speaker.id : null) })
      m.addAudio('a', frame(5000), 0); m.addAudio('b', frame(10), 0)
      m.mixAndEmit() // ['a']
      m.addAudio('a', frame(10), 0); m.addAudio('b', frame(10), 0)
      m.mixAndEmit() // 20ms silence (< 40 grace) -> no transition
      m.addAudio('a', frame(5000), 0); m.addAudio('b', frame(10), 0)
      m.mixAndEmit() // 'a' loud again, same speaker -> no new transition, counter reset
      assert.deepEqual(events, ['a'])
      m.stop()
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
