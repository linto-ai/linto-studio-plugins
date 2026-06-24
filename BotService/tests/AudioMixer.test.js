const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const AudioMixer = require('../bot/AudioMixer')
const { logger } = require('live-srt-lib')

const frame = (value, n = 320) => Buffer.from(new Int16Array(n).fill(value).buffer)

// Build a Buffer of n samples from an array of values (rest filled with 0).
const samplesBuf = (values, n = values.length) => {
  const arr = new Int16Array(n)
  for (let i = 0; i < values.length && i < n; i++) arr[i] = values[i]
  return Buffer.from(arr.buffer)
}

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

    it('returns 0 before any mixAndEmit() call', () => {
      const m = new AudioMixer()
      m.addAudio('p1', frame(1000), 0) // adding audio alone must not advance the clock
      assert.equal(m.getPositionMs(), 0)
      m.stop()
    })

    it('advances correctly over 100+ ticks (not just one)', () => {
      const m = new AudioMixer()
      for (let i = 0; i < 137; i++) {
        m.addAudio('p1', frame(1000), 0)
        m.mixAndEmit()
      }
      assert.equal(m.getPositionMs(), 137 * 20)
      m.stop()
    })
  })

  describe('#constructor()', () => {
    it('persists custom options on the instance', () => {
      const m = new AudioMixer({ energyThreshold: 1234, silenceGraceMs: 5678, bufferFrames: 4 })
      assert.equal(m.energyThreshold, 1234)
      assert.equal(m.silenceGraceMs, 5678)
      assert.equal(m.bufferSize, 320 * 4) // SAMPLES_PER_FRAME * bufferFrames
      m.stop()
    })

    it('falls back to defaults when options are omitted', () => {
      const m = new AudioMixer()
      assert.equal(m.energyThreshold, 500)
      assert.equal(m.silenceGraceMs, 2000)
      assert.equal(m.bufferSize, 320 * 160)
      m.stop()
    })

    it('keeps two instances fully independent (no shared state)', () => {
      const a = new AudioMixer()
      const b = new AudioMixer()
      a.addAudio('only-in-a', frame(1000, 3), 0)
      assert.equal(a.hasParticipant('only-in-a'), true)
      assert.equal(b.hasParticipant('only-in-a'), false)
      assert.notStrictEqual(a.participantBuffers, b.participantBuffers)
      a.mixAndEmit()
      assert.equal(a.getPositionMs(), 20)
      assert.equal(b.getPositionMs(), 0) // b unaffected by a's tick
      a.stop()
      b.stop()
    })
  })

  describe('#addAudio() participant updates', () => {
    it('updates the participant name when a new name is supplied for an existing participant', () => {
      mixer.addAudio('p1', frame(1000, 3), 0, 'Alice')
      mixer.addAudio('p1', frame(1000, 3), 0, 'Bob')
      assert.equal(mixer.participantBuffers.get('p1').name, 'Bob')
    })

    it('does not overwrite an existing name when called without a name', () => {
      mixer.addAudio('p1', frame(1000, 3), 0, 'Alice')
      mixer.addAudio('p1', frame(1000, 3), 0) // no name passed
      assert.equal(mixer.participantBuffers.get('p1').name, 'Alice')
    })

    it('updates lastTimestamp after each addAudio() call', () => {
      mixer.addAudio('p1', frame(1000, 3), 111)
      assert.equal(mixer.participantBuffers.get('p1').lastTimestamp, 111)
      mixer.addAudio('p1', frame(1000, 3), 222)
      assert.equal(mixer.participantBuffers.get('p1').lastTimestamp, 222)
    })
  })

  describe('#removeParticipant() idempotency', () => {
    it('is a no-op (does not throw) for a non-existent participant', () => {
      assert.doesNotThrow(() => mixer.removeParticipant('never-existed'))
      assert.equal(mixer.hasParticipant('never-existed'), false)
    })

    it('does not clear the current speaker when removing a different participant', () => {
      mixer.addAudio('loud', frame(5000), 0)
      mixer.addAudio('other', frame(10, 3), 0)
      mixer.mixAndEmit()
      assert.equal(mixer.getCurrentSpeaker().id, 'loud')
      mixer.removeParticipant('other') // not the current speaker
      assert.equal(mixer.getCurrentSpeaker().id, 'loud')
    })
  })

  describe('#stop() state reset', () => {
    it('clears the participantBuffers Map completely', () => {
      mixer.addAudio('p1', frame(1000, 3), 0)
      mixer.addAudio('p2', frame(1000, 3), 0)
      assert.equal(mixer.participantBuffers.size, 2)
      mixer.stop()
      assert.equal(mixer.participantBuffers.size, 0)
    })

    it('resets currentSpeaker, mixPosition and the silence accumulator', () => {
      mixer.addAudio('p1', frame(5000), 0)
      mixer.addAudio('p2', frame(10, 3), 0)
      mixer.mixAndEmit()
      assert.equal(mixer.getCurrentSpeaker().id, 'p1')
      assert.equal(mixer.getPositionMs(), 20)
      mixer.stop()
      assert.equal(mixer.getCurrentSpeaker(), null)
      assert.equal(mixer.getPositionMs(), 0)
      assert.equal(mixer._silenceMs, 0)
    })
  })

  describe('#start() after #stop()', () => {
    it('reinitializes state and lets the mixer operate normally again', () => {
      mixer.addAudio('p1', frame(5000), 0)
      mixer.mixAndEmit()
      assert.equal(mixer.getPositionMs(), 20)
      mixer.stop()
      assert.equal(mixer.getPositionMs(), 0)
      assert.equal(mixer.mixInterval, null)

      mixer.start()
      assert.ok(mixer.mixInterval, 'a fresh interval is armed after restart')
      assert.equal(mixer.getPositionMs(), 0)
      assert.equal(mixer._silenceMs, 0)
      mixer.stop() // clear the live timer

      // After the restart cycle a manual tick still works normally.
      mixer.addAudio('p1', frame(5000), 0)
      let speaker = null
      mixer.on('speakerChanged', (ev) => { speaker = ev.speaker })
      mixer.mixAndEmit()
      assert.ok(speaker && speaker.id === 'p1')
      assert.equal(mixer.getPositionMs(), 20)
    })
  })

  describe('#mixAndEmit() mixing edge-cases', () => {
    it('clips the mix at -32768 (negative overflow)', (done) => {
      mixer.addAudio('p1', frame(-30000), 0)
      mixer.addAudio('p2', frame(-20000), 0)
      mixer.on('audio', (buf) => {
        const m = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
        assert.equal(m[0], -32768)
        done()
      })
      mixer.mixAndEmit()
    })

    it('skips participants with fewer than 320 buffered samples', (done) => {
      mixer.addAudio('full', frame(1000, 320), 0) // exactly one frame
      mixer.addAudio('short', frame(9000, 319), 0) // one sample short -> skipped
      mixer.on('audio', (buf) => {
        const m = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
        // Only 'full' contributed; 'short' (would have been louder) was skipped.
        assert.equal(m[0], 1000)
        done()
      })
      mixer.mixAndEmit()
      // 'short' is still pending, below the frame size, so it never became speaker.
      assert.equal(mixer.getCurrentSpeaker().id, 'full')
    })

    it('emits a fresh Buffer on each tick (not reused across ticks)', () => {
      mixer.addAudio('p1', frame(1000), 0)
      mixer.addAudio('p1', frame(2000), 0)
      const buffers = []
      mixer.on('audio', (buf) => buffers.push(buf))
      mixer.mixAndEmit()
      mixer.mixAndEmit()
      assert.equal(buffers.length, 2)
      assert.notStrictEqual(buffers[0], buffers[1])
      // The first buffer is not mutated by the second tick.
      const m0 = new Int16Array(buffers[0].buffer, buffers[0].byteOffset, buffers[0].length / 2)
      const m1 = new Int16Array(buffers[1].buffer, buffers[1].byteOffset, buffers[1].length / 2)
      assert.equal(m0[0], 1000)
      assert.equal(m1[0], 2000)
    })

    it('speakerChanged carries type and the position equal to the current mixPosition', () => {
      mixer.addAudio('p1', frame(5000), 0)
      mixer.addAudio('p2', frame(5000), 0) // second tick speaker change happens here
      let ev = null
      mixer.on('speakerChanged', (e) => { ev = e })
      mixer.mixAndEmit()
      assert.equal(ev.type, 'speakerChanged')
      // The transition is emitted before mixPosition advances for this tick, so it
      // equals the mixPosition value at emit time (0 on the first tick).
      assert.equal(ev.position, 0)
      assert.equal(mixer.getPositionMs(), 20)
    })

    it('produces no speakerChanged for a zero-amplitude (RMS 0) frame', () => {
      const m = new AudioMixer()
      m.addAudio('silent', frame(0), 0) // all samples 0 -> RMS 0
      let changed = false
      m.on('speakerChanged', () => { changed = true })
      m.mixAndEmit()
      assert.equal(changed, false)
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })

    it('computes energy from squares so a loud all-negative frame still becomes speaker', () => {
      // RMS of a constant -5000 frame == 5000 (sqrt of mean of squares), well above
      // the threshold; negatives must not cancel out into a low/negative energy.
      const m = new AudioMixer({ energyThreshold: 500 })
      m.addAudio('neg', frame(-5000), 0)
      let speaker = null
      m.on('speakerChanged', (ev) => { speaker = ev.speaker })
      m.mixAndEmit()
      assert.ok(speaker && speaker.id === 'neg')
      m.stop()
    })
  })

  describe('multi-participant drop accounting', () => {
    it('accumulates droppedSamples independently per participant', () => {
      const m = new AudioMixer({ bufferFrames: 1 }) // 320-sample ring each
      m.addAudio('a', samplesBuf([], 320 + 100), 0) // 100 dropped
      m.addAudio('b', samplesBuf([], 320 + 640), 0) // 640 dropped
      const stats = m.getDroppedStats()
      const byId = Object.fromEntries(stats.map(s => [s.id, s.droppedSamples]))
      assert.equal(byId.a, 100)
      assert.equal(byId.b, 640)
      m.stop()
    })

    it('keeps independent read/write pointers per participant on overflow', () => {
      // Two participants, ring of 1 frame each. Overfill both with distinct values;
      // each must independently keep only its own freshest frame.
      const m = new AudioMixer({ bufferFrames: 1 })
      m.addAudio('a', samplesBuf(new Array(320).fill(100), 320), 0) // dropped
      m.addAudio('a', samplesBuf(new Array(320).fill(111), 320), 0) // kept
      m.addAudio('b', samplesBuf(new Array(320).fill(200), 320), 0) // dropped
      m.addAudio('b', samplesBuf(new Array(320).fill(222), 320), 0) // kept
      m.on('audio', (buf) => {
        const arr = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
        assert.equal(arr[0], 111 + 222) // both freshest frames mixed
      })
      m.mixAndEmit()
      const byId = Object.fromEntries(m.getDroppedStats().map(s => [s.id, s.droppedSamples]))
      assert.equal(byId.a, 320)
      assert.equal(byId.b, 320)
      m.stop()
    })
  })

  describe('#getParticipants()', () => {
    it('returns a fresh array each call (mutations do not persist)', () => {
      mixer.addAudio('p1', frame(1000, 3), 0)
      const first = mixer.getParticipants()
      first.push({ id: 'injected' })
      const second = mixer.getParticipants()
      assert.notStrictEqual(first, second)
      assert.deepEqual(second.map(p => p.id), ['p1'])
    })
  })

  describe('#getCurrentSpeaker()', () => {
    it('returns null before the first speakerChanged event', () => {
      const m = new AudioMixer()
      assert.equal(m.getCurrentSpeaker(), null)
      m.addAudio('p1', frame(100), 0) // below threshold -> no speaker
      m.mixAndEmit()
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })
  })

  describe('#getDroppedStats() framing & names', () => {
    it('computes droppedFrames as floor(droppedSamples/320)', () => {
      const m = new AudioMixer({ bufferFrames: 1 }) // 320-sample ring
      m.addAudio('zero', samplesBuf([], 320 + 100), 0) // 100 dropped -> 0 frames
      m.addAudio('one', samplesBuf([], 320 + 320), 0) // 320 dropped -> 1 frame
      m.addAudio('two', samplesBuf([], 320 + 640), 0) // 640 dropped -> 2 frames
      const byId = Object.fromEntries(m.getDroppedStats().map(s => [s.id, s.droppedFrames]))
      assert.equal(byId.zero, 0)
      assert.equal(byId.one, 1)
      assert.equal(byId.two, 2)
      m.stop()
    })

    it('includes the participant name in each entry', () => {
      mixer.addAudio('p1', frame(1000, 3), 0, 'Alice')
      mixer.addAudio('p2', frame(1000, 3), 0) // no name -> defaults to id
      const byId = Object.fromEntries(mixer.getDroppedStats().map(s => [s.id, s.name]))
      assert.equal(byId.p1, 'Alice')
      assert.equal(byId.p2, 'p2')
    })
  })

  describe('overflow warning throttle', () => {
    let originalWarn
    let calls
    beforeEach(() => {
      calls = []
      originalWarn = logger.warn
      logger.warn = (...args) => calls.push(args.join(' '))
    })
    afterEach(() => { logger.warn = originalWarn })

    it('does not warn just below the 500-sample threshold but warns at exactly 500', () => {
      const below = new AudioMixer({ bufferFrames: 1 }) // 320-sample ring
      below.addAudio('p1', samplesBuf([], 320 + 499), 0) // 499 dropped -> no warn
      assert.equal(calls.length, 0)
      assert.equal(below.getDroppedStats()[0].droppedSamples, 499)
      below.stop()

      const at = new AudioMixer({ bufferFrames: 1 })
      at.addAudio('p1', samplesBuf([], 320 + 500), 0) // 500 dropped -> exactly one warn
      assert.equal(calls.length, 1)
      assert.ok(calls[0].includes('500 samples dropped'))
      at.stop()
    })
  })

  describe('#hasParticipant() return type', () => {
    it('returns strict booleans, not truthy/falsy values', () => {
      assert.strictEqual(mixer.hasParticipant('missing'), false)
      mixer.addAudio('p1', frame(1000, 3), 0)
      assert.strictEqual(mixer.hasParticipant('p1'), true)
    })
  })

  describe('silence-grace boundaries', () => {
    it('allows the null transition with exactly two participants (the >1 boundary)', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 20 }) // 1 tick grace
      const events = []
      m.on('speakerChanged', (ev) => { events.push(ev.speaker ? ev.speaker.id : null) })
      m.addAudio('a', frame(5000), 0)
      m.addAudio('b', frame(10, 3), 0)
      m.mixAndEmit() // ['a']
      m.addAudio('a', frame(10), 0)
      m.addAudio('b', frame(10), 0)
      m.mixAndEmit() // 20ms silence >= grace, size == 2 (> 1) -> null transition
      assert.deepEqual(events, ['a', null])
      m.stop()
    })

    it('lets a participant added during the silence countdown unlock the null transition', () => {
      // Lone speaker: the >1 guard blocks the null transition no matter how long the
      // silence runs. Adding a second participant mid-countdown makes size > 1 so the
      // next silent tick past the grace finally emits null.
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 20 })
      const events = []
      m.on('speakerChanged', (ev) => { events.push(ev.speaker ? ev.speaker.id : null) })
      m.addAudio('solo', frame(5000), 0)
      m.mixAndEmit() // ['solo']
      m.addAudio('solo', frame(10), 0)
      m.mixAndEmit() // 20ms silence but size == 1 -> blocked, _silenceMs keeps growing
      assert.deepEqual(events, ['solo'])
      m.addAudio('late', frame(10, 3), 0) // size becomes 2
      m.addAudio('solo', frame(10), 0)
      m.mixAndEmit() // size > 1 and silence already past grace -> null
      assert.deepEqual(events, ['solo', null])
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })

    it('resets the silence accumulator only when the removed participant was the speaker', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 60 })
      m.addAudio('spk', frame(5000), 0)
      m.addAudio('other', frame(10, 3), 0)
      m.mixAndEmit() // 'spk' is speaker, _silenceMs 0
      m.addAudio('spk', frame(10), 0)
      m.addAudio('other', frame(10), 0)
      m.mixAndEmit() // silence accumulating: _silenceMs == 20
      assert.equal(m._silenceMs, 20)

      // Removing a non-speaker must NOT reset the silence accumulator.
      m.removeParticipant('other')
      assert.equal(m._silenceMs, 20)
      assert.equal(m.getCurrentSpeaker().id, 'spk')

      // Removing the current speaker resets it (and clears the speaker).
      m.removeParticipant('spk')
      assert.equal(m._silenceMs, 0)
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })
  })
})
