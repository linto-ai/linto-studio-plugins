const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const AudioMixer = require('../bot/AudioMixer')
const { logger } = require('live-srt-lib')

const { SAMPLES_PER_FRAME } = AudioMixer // 320

const frame = (value, n = SAMPLES_PER_FRAME) => Buffer.from(new Int16Array(n).fill(value).buffer)
const pcm = (values) => Buffer.from(Int16Array.from(values).buffer)
const samplesOf = (buf) => Array.from(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2))

// Record what a mixer emits.
function record (mixer) {
  const out = { frames: [], speakers: [] }
  mixer.on('audio', (buf) => out.frames.push(buf))
  mixer.on('speakerChanged', (ev) => out.speakers.push(ev.speaker ? ev.speaker.id : null))
  return out
}

// Open tracks (an empty delivery makes a track flowing without giving it audio),
// attributed to the participant of the same name, so that the following feed()
// calls mix them together.
function open (mixer, ids, attribute = true) {
  for (const id of ids) {
    if (attribute) mixer.setTrackParticipant(id, { id, name: id })
    mixer.addAudio(id, Buffer.alloc(0))
  }
}
// One delivery per track, in order: { trackId: Buffer }.
function feed (mixer, deliveries) {
  for (const [id, buf] of Object.entries(deliveries)) mixer.addAudio(id, buf)
}

describe('AudioMixer', () => {
  let mixer, out
  beforeEach(() => { mixer = new AudioMixer(); out = record(mixer) })
  afterEach(() => { mixer.stop() })

  describe('single track (pure pass-through)', () => {
    it('emits a 640-byte (20 ms) frame once a frame is buffered, nothing before', () => {
      mixer.addAudio('t', frame(1000, 319))
      assert.equal(out.frames.length, 0)
      mixer.addAudio('t', frame(1000, 1))
      assert.equal(out.frames.length, 1)
      assert.equal(out.frames[0].length, 640)
    })

    it('outputs exactly the input samples, whatever the delivery sizes (bit-identical)', () => {
      let seed = 1
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
      const input = Int16Array.from({ length: 16000 * 10 }, () => Math.round((rnd() * 2 - 1) * 32767))
      for (let i = 0; i < input.length;) {
        const n = Math.min(1 + Math.floor(rnd() * 2000), input.length - i)
        mixer.addAudio('t', pcm(input.subarray(i, i + n)))
        i += n
      }
      const output = out.frames.flatMap(samplesOf)
      assert.equal(output.length, Math.floor(input.length / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME)
      assert.deepEqual(output, Array.from(input.subarray(0, output.length)))
    })

    it('emits nothing while no track delivers (no continuous silence)', () => {
      mixer.addAudio('t', frame(1000))
      assert.equal(out.frames.length, 1)
      mixer.removeTrack('missing')
      assert.equal(out.frames.length, 1)
    })

    it('emits a fresh Buffer per frame (not reused)', () => {
      mixer.addAudio('t', frame(1000))
      mixer.addAudio('t', frame(2000))
      assert.notStrictEqual(out.frames[0], out.frames[1])
      assert.equal(samplesOf(out.frames[0])[0], 1000)
      assert.equal(samplesOf(out.frames[1])[0], 2000)
    })

    it('copies an unaligned (odd byteOffset) buffer without throwing', () => {
      const backing = Buffer.alloc(SAMPLES_PER_FRAME * 2 + 1)
      backing.writeInt16LE(1234, 1)
      mixer.addAudio('t', backing.subarray(1))
      assert.equal(samplesOf(out.frames[0])[0], 1234)
    })
  })

  // A live Teams call streamed two tracks at once (the one Teams replaced on
  // admission kept rendering zeros next to the real one) and they were forwarded
  // one after the other: 2x real time, the voice slowed down and chopped by
  // 3-8 ms runs of zeros.
  describe('several tracks are summed, never concatenated', () => {
    it('sums simultaneous tracks sample by sample into one stream at the input rate', () => {
      open(mixer, ['a', 'b'], false)
      for (let k = 0; k < 50; k++) feed(mixer, { a: frame(1000, 128), b: frame(500, 128) })
      const output = out.frames.flatMap(samplesOf)
      assert.equal(output.length, Math.floor(50 * 128 / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME, 'one track worth of samples, not two')
      assert.ok(output.every((v) => v === 1500))
    })

    it('a voice next to a track of digital zeros comes out unchanged', () => {
      open(mixer, ['zeros', 'voice'], false)
      const voice = Int16Array.from({ length: 128 * 30 }, (_, i) => Math.round(8000 * Math.sin(i / 7)))
      for (let k = 0; k < 30; k++) feed(mixer, { zeros: frame(0, 128), voice: pcm(voice.subarray(k * 128, (k + 1) * 128)) })
      const output = out.frames.flatMap(samplesOf)
      assert.deepEqual(output, Array.from(voice.subarray(0, output.length)))
    })

    it('clips the sum at +32767 and -32768', () => {
      open(mixer, ['a', 'b'], false)
      feed(mixer, { a: frame(30000), b: frame(20000) })
      feed(mixer, { a: frame(-30000), b: frame(-20000) })
      assert.equal(samplesOf(out.frames[0])[0], 32767)
      assert.equal(samplesOf(out.frames[1])[0], -32768)
    })

    it('waits for a lagging track rather than emitting a frame without it', () => {
      open(mixer, ['a', 'b'], false)
      feed(mixer, { a: frame(1000, 3 * SAMPLES_PER_FRAME) })
      assert.equal(out.frames.length, 0, 'held while b, still flowing, has no frame yet')
      feed(mixer, { b: frame(1, 3 * SAMPLES_PER_FRAME) })
      assert.equal(out.frames.length, 3)
      assert.ok(out.frames.flatMap(samplesOf).every((v) => v === 1001))
    })

    it('lines a track that starts mid-stream up with the newest samples of the others', () => {
      // a holds 200 samples when b delivers its first 128: those match a's last
      // 128, so b starts after 72 samples of silence.
      mixer.addAudio('a', pcm(Array.from({ length: 200 }, (_, i) => i)))
      mixer.addAudio('b', frame(1000, 128))
      mixer.addAudio('a', pcm(Array.from({ length: 120 }, (_, i) => 200 + i)))
      mixer.addAudio('b', frame(1000, 120))
      const output = out.frames.flatMap(samplesOf)
      assert.equal(output.length, SAMPLES_PER_FRAME)
      assert.deepEqual(output.slice(0, 72), Array.from({ length: 72 }, (_, i) => i), 'b silent before it started')
      assert.deepEqual(output.slice(72), Array.from({ length: 248 }, (_, i) => 72 + i + 1000), 'then a + b aligned')
    })

    it('stops waiting for a track that fell maxLag behind, mixes its tail, and lines it up again on resume', () => {
      const m = new AudioMixer({ maxLagMs: 40 }) // 640 samples
      const o = record(m)
      open(m, ['a', 'b'], false)
      feed(m, { a: frame(1000, 100), b: frame(1, 100) })
      // b stops delivering; a goes on.
      m.addAudio('a', frame(1000, SAMPLES_PER_FRAME + 640 - 101))
      assert.equal(o.frames.length, 0, 'still waiting: a is not yet maxLag ahead')
      m.addAudio('a', frame(1000, 1))
      assert.equal(o.frames.length, 3, 'a reached maxLag ahead: everything a holds is emitted')
      const first = samplesOf(o.frames[0])
      assert.deepEqual(first.slice(0, 100), new Array(100).fill(1001), "b's tail mixed where it belongs")
      assert.deepEqual(first.slice(100), new Array(220).fill(1000), 'then a alone')
      assert.equal(m.getStats().tracks.find((t) => t.id === 'b').stalls, 1)
      assert.equal(m.getStats().tracks.find((t) => t.id === 'b').active, false)
      assert.equal(m.getStats().stalls, 1, 'counted in the total too')
      // a keeps flowing without waiting for b.
      m.addAudio('a', frame(1000, SAMPLES_PER_FRAME))
      assert.equal(o.frames.length, 4)
      // b resumes: lined up with a's newest samples, waited for again.
      m.addAudio('b', frame(1, 128))
      m.addAudio('a', frame(1000, SAMPLES_PER_FRAME))
      assert.equal(o.frames.length, 4, 'b is waited for again')
      m.addAudio('b', frame(1, SAMPLES_PER_FRAME))
      assert.equal(o.frames.length, 5)
      m.stop()
    })

    // See _drain: an early track is not realigned below maxLag (it would take
    // dropping its audio), and is realigned without loss beyond.
    it('an early track (backlog on top of its flow) stays offset by at most maxLag, and loses nothing', () => {
      const q = (v) => frame(v, 128)
      for (const [backlogMs, offset] of [[100, 1600], [250, 4000], [1000, 0], [3000, 0]]) {
        const m = new AudioMixer()
        open(m, ['x', 'y'], false)
        for (let i = 0; i < 50; i++) { m.addAudio('x', q(1)); m.addAudio('y', q(2)) }
        m.addAudio('x', frame(1, backlogMs * 16))
        for (let i = 0; i < 1000; i++) { m.addAudio('x', q(1)); m.addAudio('y', q(2)) }
        const x = m.tracks.get('x')
        const y = m.tracks.get('y')
        assert.equal(x.samplesAvailable - y.samplesAvailable, offset, `${backlogMs} ms backlog`)
        assert.ok(offset <= m.maxLagSamples)
        assert.equal(m.getStats().droppedSamples, 0)
        assert.equal(m.getStats().outputSamples + x.samplesAvailable, x.inputSamples, `${backlogMs} ms: all of x mixed or pending`)
        m.stop()
      }
    })

    it('a removed track is no longer waited for, and its tail goes with it', () => {
      open(mixer, ['a', 'b'], false)
      feed(mixer, { a: frame(1000, 2 * SAMPLES_PER_FRAME), b: frame(1, 100) })
      assert.equal(out.frames.length, 0)
      mixer.removeTrack('b')
      assert.equal(out.frames.length, 2)
      assert.ok(out.frames.flatMap(samplesOf).every((v) => v === 1000))
      assert.equal(mixer.hasTrack('b'), false)
    })
  })

  // Frames are driven by the input, not by a wall-clock timer: there is nothing
  // to drift against. Simulated hours of render-ordered deliveries (8 ms quanta at
  // 16 kHz, in bursts) check that the output carries exactly the input, without a
  // drop or a gap, with a latency that stays bounded.
  describe('clocking: one hour of input', function () {
    this.timeout(60000)

    // Sample values of the two simulated tracks (small enough never to clip).
    const valueA = (n) => (n % 2000) - 1000
    const valueB = (n) => ((n * 7) % 600) - 300
    const QUANTUM = 128
    // Deepest track buffer right now, i.e. the mixer's latency in samples.
    const buffered = (m) => {
      let max = 0
      for (const t of m.tracks.values()) max = Math.max(max, t.samplesAvailable)
      return max
    }

    function deliver (m, id, value, from, n, scratch) {
      for (let i = 0; i < n; i++) scratch.writeInt16LE(value(from + i), i * 2)
      m.addAudio(id, scratch.subarray(0, n * 2))
      return buffered(m)
    }

    for (const rate of [15840, 16160]) {
      it(`two tracks of one page, input clock ${rate === 16160 ? '+' : '-'}1% off nominal, bursty, reordered within a quantum: exact sum, nothing dropped, bounded latency`, () => {
        const m = new AudioMixer()
        const quanta = Math.round(3600 * rate / QUANTUM) // one hour of input at that rate
        const scratch = Buffer.alloc(QUANTUM * 2 * 4)
        let seed = rate
        const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
        let emitted = 0
        let mismatches = 0
        m.on('audio', (buf) => {
          for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
            const n = emitted + i
            if (buf.readInt16LE(i * 2) !== valueA(n) + valueB(n)) mismatches++
          }
          emitted += SAMPLES_PER_FRAME
        })
        let maxBuffered = 0
        let wallSeconds = 0
        open(m, ['a', 'b'], false) // both captured from the start
        // Bursts of 1-30 quanta (a main thread that was busy), each track's quanta in
        // render order, the two tracks' order within a quantum at random, and up to
        // 4 quanta of one track ahead of the other at times (jitter).
        for (let q = 0; q < quanta;) {
          const burst = Math.min(1 + Math.floor(rnd() * 30), quanta - q)
          for (let k = 0; k < burst;) {
            const ahead = Math.min(1 + Math.floor(rnd() * 4), burst - k)
            const [first, second] = rnd() < 0.5 ? [['a', valueA], ['b', valueB]] : [['b', valueB], ['a', valueA]]
            maxBuffered = Math.max(maxBuffered, deliver(m, first[0], first[1], (q + k) * QUANTUM, ahead * QUANTUM, scratch))
            maxBuffered = Math.max(maxBuffered, deliver(m, second[0], second[1], (q + k) * QUANTUM, ahead * QUANTUM, scratch))
            k += ahead
          }
          q += burst
          wallSeconds += burst * QUANTUM / rate
        }
        const stats = m.getStats()
        const input = quanta * QUANTUM
        assert.equal(mismatches, 0, 'every output sample is a + b at the same position')
        assert.equal(stats.outputSamples, Math.floor(input / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME, 'all the input, nothing more')
        assert.ok(stats.tracks.every((t) => t.inputSamples === input && t.droppedSamples === 0 && t.stalls === 0))
        // Latency: under a frame plus the deliveries one track can be ahead.
        assert.ok(maxBuffered < SAMPLES_PER_FRAME + 4 * QUANTUM, `max buffered ${maxBuffered} samples`)
        // The output follows the input clock, not a nominal one.
        assert.ok(Math.abs(stats.outputSamples / wallSeconds - rate) < 1, `${stats.outputSamples / wallSeconds} samples/s`)
        m.stop()
      })
    }

    it('two sources 1% apart (one AudioContext cannot produce that): bounded latency, nothing dropped', () => {
      const m = new AudioMixer()
      const rates = { a: 16160, b: 15840 }
      const next = { a: 0, b: 0 } // time of each track's next delivery
      const sent = { a: 0, b: 0 }
      let maxBuffered = 0
      const quantumOf = { a: frame(100, QUANTUM), b: frame(1, QUANTUM) }
      while (Math.min(next.a, next.b) < 3600) {
        const id = next.a <= next.b ? 'a' : 'b'
        m.addAudio(id, quantumOf[id])
        sent[id] += QUANTUM
        next[id] += QUANTUM / rates[id]
        maxBuffered = Math.max(maxBuffered, buffered(m))
      }
      const stats = m.getStats()
      const a = stats.tracks.find((t) => t.id === 'a')
      const b = stats.tracks.find((t) => t.id === 'b')
      assert.equal(a.droppedSamples + b.droppedSamples, 0)
      assert.equal(a.stalls, 0, 'the faster track is never cut')
      assert.ok(b.stalls > 0, 'the slower one is caught up with now and then')
      assert.ok(maxBuffered <= SAMPLES_PER_FRAME + m.maxLagSamples + QUANTUM, `max buffered ${maxBuffered} samples`)
      assert.ok(Math.abs(stats.outputSamples - sent.a) < SAMPLES_PER_FRAME + m.maxLagSamples, 'the output follows the faster track')
      m.stop()
    })
  })

  describe('speaker detection (SFU tracks attributed to participants)', () => {
    it('emits speakerChanged for the highest-energy participant above the threshold', () => {
      open(mixer, ['p1', 'p2'])
      feed(mixer, { p1: frame(1000), p2: frame(5000) })
      assert.deepEqual(out.speakers, ['p2'])
    })

    it('does not emit speakerChanged below the energy threshold', () => {
      open(mixer, ['quiet'])
      feed(mixer, { quiet: frame(100) })
      assert.equal(out.frames.length, 1)
      assert.deepEqual(out.speakers, [])
    })

    it('treats energy exactly AT the threshold as silence (strict >), one above as speech', () => {
      open(mixer, ['edge'])
      feed(mixer, { edge: frame(500) }) // RMS == 500, NOT > 500
      assert.deepEqual(out.speakers, [])
      feed(mixer, { edge: frame(501) })
      assert.deepEqual(out.speakers, ['edge'])
    })

    it('computes energy from squares so a loud all-negative frame still becomes speaker', () => {
      open(mixer, ['neg'])
      feed(mixer, { neg: frame(-5000) })
      assert.deepEqual(out.speakers, ['neg'])
    })

    it('breaks an exact energy tie in favour of the first-added track', () => {
      open(mixer, ['first', 'second'])
      feed(mixer, { first: frame(5000), second: frame(5000) })
      assert.deepEqual(out.speakers, ['first'])
    })

    it('lets a strictly louder later track take over', () => {
      open(mixer, ['a', 'b'])
      feed(mixer, { a: frame(3000), b: frame(6000) })
      assert.deepEqual(out.speakers, ['b'])
    })

    it('emits a single transition while the same speaker keeps talking', () => {
      open(mixer, ['p1'])
      feed(mixer, { p1: frame(5000) })
      feed(mixer, { p1: frame(5000) })
      assert.deepEqual(out.speakers, ['p1'])
    })

    it("a participant's energy is that of all their tracks together (mic + screen share)", () => {
      mixer.setTrackParticipant('mic', { id: 'u1', name: 'Alice' })
      mixer.setTrackParticipant('screen', { id: 'u1', name: 'Alice' })
      mixer.setTrackParticipant('other', { id: 'u2', name: 'Bob' })
      open(mixer, ['mic', 'screen', 'other'], false)
      // 300 + 300 in phase = RMS 600 > 500, while Bob's 450 stays below.
      feed(mixer, { mic: frame(300), screen: frame(300), other: frame(450) })
      assert.deepEqual(out.speakers, ['u1'])
      assert.equal(mixer.getCurrentSpeaker().name, 'Alice')
    })

    it('mixes unattributed tracks but never makes them the speaker', () => {
      open(mixer, ['mapped'])
      open(mixer, ['unmapped'], false)
      feed(mixer, { mapped: frame(100), unmapped: frame(9000) })
      assert.equal(samplesOf(out.frames[0])[0], 9100)
      assert.deepEqual(out.speakers, [null], 'unknown, not them')
    })

    it('attribution can come before any audio and be renamed', () => {
      mixer.setTrackParticipant('t', { id: 'u1', name: 'Old' })
      mixer.setTrackParticipant('t', { id: 'u1', name: 'New' })
      feed(mixer, { t: frame(5000) })
      assert.equal(mixer.getCurrentSpeaker().name, 'New')
    })

    it('carries the position of the transition (20 ms per mixed frame)', () => {
      open(mixer, ['p1'])
      const events = []
      mixer.on('speakerChanged', (ev) => events.push(ev))
      feed(mixer, { p1: frame(100) })
      feed(mixer, { p1: frame(100) })
      feed(mixer, { p1: frame(5000) })
      assert.deepEqual(events, [{ type: 'speakerChanged', position: 40, speaker: { id: 'p1', name: 'p1' } }])
      assert.equal(mixer.getPositionMs(), 60)
    })

    it('removeParticipant clears their attribution and the current speaker, not their audio', () => {
      open(mixer, ['p1', 'p2'])
      feed(mixer, { p1: frame(5000), p2: frame(10) })
      assert.equal(mixer.getCurrentSpeaker().id, 'p1')
      mixer.removeParticipant('p1')
      assert.equal(mixer.getCurrentSpeaker(), null)
      feed(mixer, { p1: frame(5000), p2: frame(10) })
      assert.equal(samplesOf(out.frames[1])[0], 5010, 'still mixed')
      assert.deepEqual(out.speakers, ['p1', null], 'but no longer attributed: unknown, not p1 (nor whoever spoke before)')
      assert.equal(mixer.getStats().tracks.find((t) => t.id === 'p1').participantId, null)
    })

    it('removeParticipant of someone else keeps the current speaker', () => {
      open(mixer, ['loud', 'other'])
      feed(mixer, { loud: frame(5000), other: frame(10) })
      mixer.removeParticipant('other')
      assert.equal(mixer.getCurrentSpeaker().id, 'loud')
      assert.doesNotThrow(() => mixer.removeParticipant('never-existed'))
    })
  })

  // An SFU track speaks before the page maps it to its participant (its first
  // seconds). The Transcriber pins a segment's speaker at its first partial, with
  // a 200 ms grace: the previous speaker must not stay current meanwhile, and the
  // participant must be announced the moment the mapping arrives.
  describe('tracks not attributed yet (SFU first words)', () => {
    const events = (m) => {
      const list = []
      m.on('speakerChanged', (ev) => list.push([ev.position, ev.speaker && ev.speaker.id]))
      return list
    }

    it('an unattributed track speaking over the current speaker makes the speaker unknown, even for a lone participant', () => {
      const ev = events(mixer)
      open(mixer, ['alice'])
      open(mixer, ['new'], false)
      feed(mixer, { alice: frame(5000), new: frame(0) })
      feed(mixer, { alice: frame(0), new: frame(5000) }) // someone not mapped yet speaks
      assert.deepEqual(ev, [[0, 'alice'], [20, null]])
      assert.equal(mixer.getCurrentSpeaker(), null)
    })

    it('marks that null with reason "unattributed"; a silence null keeps its shape (no reason)', () => {
      const m = new AudioMixer({ silenceGraceMs: 40 })
      const raw = []
      m.on('speakerChanged', (ev) => raw.push(ev))
      open(m, ['alice', 'bob'])
      open(m, ['new'], false)
      feed(m, { alice: frame(5000), bob: frame(0), new: frame(0) })
      feed(m, { alice: frame(0), bob: frame(0), new: frame(5000) })
      feed(m, { alice: frame(0), bob: frame(5000), new: frame(0) })
      for (let i = 0; i < 2; i++) feed(m, { alice: frame(0), bob: frame(0), new: frame(0) })
      assert.deepEqual(raw, [
        { type: 'speakerChanged', position: 0, speaker: { id: 'alice', name: 'alice' } },
        { type: 'speakerChanged', position: 20, speaker: null, reason: 'unattributed' },
        { type: 'speakerChanged', position: 40, speaker: { id: 'bob', name: 'bob' } },
        { type: 'speakerChanged', position: 80, speaker: null }
      ])
      assert.equal('reason' in raw[3], false)
      m.stop()
    })

    it('also after a silence null, when the previous speaker would otherwise be assumed', () => {
      const m = new AudioMixer({ silenceGraceMs: 40 })
      const raw = []
      m.on('speakerChanged', (ev) => raw.push([ev.position, ev.speaker && ev.speaker.id, ev.reason]))
      open(m, ['alice', 'bob'])
      open(m, ['new'], false)
      feed(m, { alice: frame(5000), bob: frame(0), new: frame(0) })
      for (let i = 0; i < 2; i++) feed(m, { alice: frame(0), bob: frame(0), new: frame(0) }) // silence null
      feed(m, { alice: frame(0), bob: frame(0), new: frame(5000) })
      feed(m, { alice: frame(0), bob: frame(0), new: frame(5000) }) // not twice in a row
      assert.deepEqual(raw, [[0, 'alice', undefined], [40, null, undefined], [60, null, 'unattributed']])
      m.stop()
    })

    // The first words of the meeting: the Transcriber must know they are somebody
    // still unnamed, to name them with the participant mapped next.
    it('also for the first episode, before any speaker was announced', () => {
      const raw = []
      mixer.on('speakerChanged', (ev) => raw.push(ev))
      open(mixer, ['alice'])
      open(mixer, ['new'], false)
      feed(mixer, { alice: frame(0), new: frame(5000) })
      feed(mixer, { alice: frame(0), new: frame(5000) })
      assert.deepEqual(raw, [{ type: 'speakerChanged', position: 0, speaker: null, reason: 'unattributed' }])
    })

    it('again for each new episode: after the grace, or after a speaker (never twice within one)', () => {
      const m = new AudioMixer({ silenceGraceMs: 40 })
      const raw = []
      m.on('speakerChanged', (ev) => raw.push([ev.position, ev.speaker && ev.speaker.id, ev.reason]))
      open(m, ['alice'])
      open(m, ['u1', 'u2'], false)
      const step = (a, u1, u2) => feed(m, { alice: frame(a), u1: frame(u1), u2: frame(u2) })
      step(0, 5000, 0) // 0: episode 1
      step(0, 0, 5000) // 20: u2 takes over: same episode
      step(0, 0, 0) // 40: a pause shorter than the grace
      step(0, 5000, 0) // 60: same episode
      step(0, 0, 0); step(0, 0, 0) // 80, 100: the grace is over: the episode ends
      step(0, 5000, 0) // 120: episode 2
      step(5000, 0, 0) // 140: Alice
      step(0, 0, 5000) // 160: episode 3
      assert.deepEqual(raw, [
        [0, null, 'unattributed'], [120, null, 'unattributed'], [140, 'alice', undefined], [160, null, 'unattributed']
      ])
      m.stop()
    })

    it('keeps the current speaker while the unattributed track is quiet or quieter', () => {
      const ev = events(mixer)
      open(mixer, ['alice'])
      open(mixer, ['new'], false)
      feed(mixer, { alice: frame(5000), new: frame(400) }) // below the threshold
      feed(mixer, { alice: frame(5000), new: frame(3000) }) // louder than the threshold, quieter than Alice
      assert.deepEqual(ev, [[0, 'alice']])
    })

    it('announces the participant at once when the speaking track gets mapped', () => {
      const ev = events(mixer)
      open(mixer, ['alice'])
      open(mixer, ['new'], false)
      feed(mixer, { alice: frame(5000), new: frame(0) })
      feed(mixer, { alice: frame(0), new: frame(5000) })
      feed(mixer, { alice: frame(0), new: frame(5000) })
      mixer.setTrackParticipant('new', { id: 'bob', name: 'Bob' }) // no further audio needed
      assert.deepEqual(ev, [[0, 'alice'], [20, null], [60, 'bob']])
      assert.deepEqual(mixer.getCurrentSpeaker(), { id: 'bob', name: 'Bob' })
      feed(mixer, { alice: frame(0), new: frame(5000) })
      assert.equal(ev.length, 3, 'no second transition while Bob goes on')
    })

    it("marks that announcement with reason 'mapped', and only that one", () => {
      const raw = []
      mixer.on('speakerChanged', (ev) => raw.push(ev))
      open(mixer, ['alice'])
      open(mixer, ['new'], false)
      feed(mixer, { alice: frame(5000), new: frame(0) })
      feed(mixer, { alice: frame(0), new: frame(5000) })
      mixer.setTrackParticipant('new', { id: 'bob', name: 'Bob' })
      feed(mixer, { alice: frame(5000), new: frame(0) })
      assert.deepEqual(raw, [
        { type: 'speakerChanged', position: 0, speaker: { id: 'alice', name: 'alice' } },
        { type: 'speakerChanged', position: 20, speaker: null, reason: 'unattributed' },
        { type: 'speakerChanged', position: 40, speaker: { id: 'bob', name: 'Bob' }, reason: 'mapped' },
        { type: 'speakerChanged', position: 40, speaker: { id: 'alice', name: 'alice' } }
      ])
    })

    // Alice's screen share starts: a second track of hers, not mapped yet.
    it("also when the mapped track belongs to a participant known already", () => {
      const raw = []
      mixer.on('speakerChanged', (ev) => raw.push([ev.position, ev.speaker && ev.speaker.id, ev.reason]))
      mixer.setTrackParticipant('mic', { id: 'alice', name: 'Alice' })
      open(mixer, ['mic'], false)
      open(mixer, ['screen'], false)
      feed(mixer, { mic: frame(5000), screen: frame(0) })
      feed(mixer, { mic: frame(0), screen: frame(5000) })
      mixer.setTrackParticipant('screen', { id: 'alice', name: 'Alice' })
      assert.deepEqual(raw, [[0, 'alice', undefined], [20, null, 'unattributed'], [40, 'alice', 'mapped']])
    })

    it('also after a pause shorter than the grace', () => {
      const m = new AudioMixer({ silenceGraceMs: 100 })
      const ev = events(m)
      open(m, ['new'], false)
      feed(m, { new: frame(5000) })
      for (let i = 0; i < 4; i++) feed(m, { new: frame(0) }) // 80 ms pause
      m.setTrackParticipant('new', { id: 'bob', name: 'Bob' })
      assert.deepEqual(ev, [[0, null], [100, 'bob']])
      m.stop()
    })

    it('not once the track has been quiet for the grace (its next loud frame tells)', () => {
      const m = new AudioMixer({ silenceGraceMs: 100 })
      const ev = events(m)
      open(m, ['new'], false)
      feed(m, { new: frame(5000) })
      for (let i = 0; i < 5; i++) feed(m, { new: frame(0) }) // 100 ms of silence
      m.setTrackParticipant('new', { id: 'bob', name: 'Bob' })
      assert.deepEqual(ev, [[0, null]])
      feed(m, { new: frame(5000) })
      assert.deepEqual(ev, [[0, null], [120, 'bob']])
      m.stop()
    })

    it('mapping a track that is not the one speaking announces nobody', () => {
      const ev = events(mixer)
      open(mixer, ['a', 'b'], false)
      feed(mixer, { a: frame(5000), b: frame(100) })
      mixer.setTrackParticipant('b', { id: 'bob', name: 'Bob' })
      assert.deepEqual(ev, [[0, null]])
    })

    it('a removed track is no longer the one speaking', () => {
      const ev = events(mixer)
      open(mixer, ['new', 'other'], false)
      feed(mixer, { new: frame(5000), other: frame(0) })
      mixer.removeTrack('new')
      mixer.setTrackParticipant('new', { id: 'bob', name: 'Bob' })
      assert.deepEqual(ev, [[0, null]])
    })

    // The Bot relays the mixer's speaker events on SFU platforms only (see
    // 'never derives speakers from the mixer on Teams').
    it('nothing attributed (MCU/Teams): never a participant, one null per episode', () => {
      const ev = events(mixer)
      open(mixer, ['t0', 't1'], false)
      for (let i = 0; i < 10; i++) feed(mixer, { t0: frame(i % 2 ? 9000 : 0), t1: frame(i % 2 ? 0 : 9000) })
      assert.deepEqual(ev, [[0, null]])
    })
  })

  describe('silence/grace transitions', () => {
    it('emits silence only after the grace period, then re-attributes on the next loud frame', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 40 }) // 2 frames of grace
      const o = record(m)
      open(m, ['loud', 'quiet'])
      feed(m, { loud: frame(5000), quiet: frame(10) })
      feed(m, { loud: frame(10), quiet: frame(10) }) // 20 ms of silence: held
      assert.deepEqual(o.speakers, ['loud'])
      feed(m, { loud: frame(10), quiet: frame(10) }) // 40 ms >= grace: null
      assert.deepEqual(o.speakers, ['loud', null])
      assert.equal(m.getCurrentSpeaker(), null)
      feed(m, { loud: frame(5000), quiet: frame(10) })
      assert.deepEqual(o.speakers, ['loud', null, 'loud'])
      m.stop()
    })

    it('never emits a silence transition for a lone participant (pauses are not boundaries)', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 20 })
      const o = record(m)
      open(m, ['solo'])
      feed(m, { solo: frame(5000) })
      for (let i = 0; i < 10; i++) feed(m, { solo: frame(10) })
      assert.deepEqual(o.speakers, ['solo'])
      m.stop()
    })

    it('counts participants, not tracks: one participant with two tracks is still alone', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 20 })
      const o = record(m)
      m.setTrackParticipant('mic', { id: 'u1' })
      m.setTrackParticipant('screen', { id: 'u1' })
      open(m, ['mic', 'screen'], false)
      feed(m, { mic: frame(5000), screen: frame(10) })
      for (let i = 0; i < 5; i++) feed(m, { mic: frame(10), screen: frame(10) })
      assert.deepEqual(o.speakers, ['u1'])
      m.stop()
    })

    it('resets the silence accumulator so an intra-speech pause never crosses the grace', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 40 })
      const o = record(m)
      open(m, ['a', 'b'])
      feed(m, { a: frame(5000), b: frame(10) })
      feed(m, { a: frame(10), b: frame(10) }) // 20 ms of silence
      feed(m, { a: frame(5000), b: frame(10) }) // a again: accumulator reset
      feed(m, { a: frame(10), b: frame(10) }) // 20 ms again: still under the grace
      assert.deepEqual(o.speakers, ['a'])
      m.stop()
    })

    it('resets the silence accumulator only when the removed participant was the speaker', () => {
      const m = new AudioMixer({ energyThreshold: 500, silenceGraceMs: 60 })
      open(m, ['spk', 'other'])
      feed(m, { spk: frame(5000), other: frame(10) })
      feed(m, { spk: frame(10), other: frame(10) })
      assert.equal(m._silenceMs, 20)
      m.removeParticipant('other')
      assert.equal(m._silenceMs, 20)
      m.removeParticipant('spk')
      assert.equal(m._silenceMs, 0)
      assert.equal(m.getCurrentSpeaker(), null)
      m.stop()
    })
  })

  describe('ring buffer', () => {
    it('mixes the correct samples after the write pointer wraps past the end', () => {
      const m = new AudioMixer({ bufferFrames: 2 }) // 640-sample ring
      const o = record(m)
      m.addAudio('t', pcm(Array.from({ length: 500 }, (_, i) => i)))
      m.addAudio('t', pcm(Array.from({ length: 460 }, (_, i) => 500 + i))) // wraps
      assert.deepEqual(o.frames.flatMap(samplesOf), Array.from({ length: 960 }, (_, i) => i))
      assert.equal(m.getStats().tracks[0].droppedSamples, 0)
      m.stop()
    })

    it('keeps the freshest audio of an oversized delivery and counts the drop', () => {
      const m = new AudioMixer({ bufferFrames: 2 }) // 640-sample ring
      const o = record(m)
      m.addAudio('t', pcm(Array.from({ length: 740 }, (_, i) => i)))
      assert.deepEqual(o.frames.flatMap(samplesOf), Array.from({ length: 640 }, (_, i) => 100 + i))
      assert.equal(m.getStats().tracks[0].droppedSamples, 100)
      m.removeTrack('t')
      assert.equal(m.getStats().droppedSamples, 100, 'the total outlives the track')
      m.stop()
    })

    describe('overflow warning throttle', () => {
      let calls, originalWarn
      beforeEach(() => { calls = []; originalWarn = logger.warn; logger.warn = (...args) => calls.push(args.join(' ')) })
      afterEach(() => { logger.warn = originalWarn })

      it('does not warn just below 500 dropped samples, warns once at 500', () => {
        const below = new AudioMixer({ bufferFrames: 1 })
        below.addAudio('t', frame(0, SAMPLES_PER_FRAME + 499))
        assert.equal(calls.length, 0)
        below.stop()
        const at = new AudioMixer({ bufferFrames: 1 })
        at.addAudio('t', frame(0, SAMPLES_PER_FRAME + 500))
        assert.equal(calls.length, 1)
        assert.ok(calls[0].includes('track t') && calls[0].includes('500 samples dropped'))
        at.stop()
      })
    })
  })

  describe('#getStats()', () => {
    it('reports output samples and, per track, input, drops, buffered audio, stalls and attribution', () => {
      mixer.setTrackParticipant('a', { id: 'u1', name: 'A' })
      mixer.addAudio('a', frame(1, 400))
      const stats = mixer.getStats()
      assert.equal(stats.outputSamples, SAMPLES_PER_FRAME)
      assert.equal(stats.droppedSamples, 0)
      assert.equal(stats.stalls, 0)
      assert.deepEqual(stats.tracks, [{ id: 'a', participantId: 'u1', active: true, inputSamples: 400, droppedSamples: 0, bufferedSamples: 80, stalls: 0 }])
    })

    it('lists the track ids', () => {
      mixer.addAudio('a', frame(1, 10))
      mixer.setTrackParticipant('b', { id: 'u2' })
      assert.deepEqual(mixer.trackIds(), ['a', 'b'])
    })
  })

  describe('#constructor()', () => {
    it('applies options and falls back to defaults', () => {
      const custom = new AudioMixer({ energyThreshold: 1234, silenceGraceMs: 5678, bufferFrames: 4, maxLagMs: 100 })
      assert.equal(custom.energyThreshold, 1234)
      assert.equal(custom.silenceGraceMs, 5678)
      assert.equal(custom.bufferSize, SAMPLES_PER_FRAME * 4)
      assert.equal(custom.maxLagSamples, 1600)
      const defaults = new AudioMixer()
      assert.equal(defaults.energyThreshold, 500)
      assert.equal(defaults.silenceGraceMs, 2000)
      assert.equal(defaults.bufferSize, SAMPLES_PER_FRAME * 160)
      assert.equal(defaults.maxLagSamples, 4800)
    })

    it('keeps two instances fully independent', () => {
      const a = new AudioMixer()
      const b = new AudioMixer()
      a.addAudio('t', frame(1000))
      assert.equal(a.hasTrack('t'), true)
      assert.equal(b.hasTrack('t'), false)
      assert.equal(a.getPositionMs(), 20)
      assert.equal(b.getPositionMs(), 0)
    })
  })

  describe('#stop()', () => {
    it('clears tracks, position, speaker and counters; is idempotent', () => {
      open(mixer, ['p1', 'p2'])
      feed(mixer, { p1: frame(5000), p2: frame(10) })
      mixer.stop()
      mixer.stop()
      assert.equal(mixer.tracks.size, 0)
      assert.equal(mixer.getPositionMs(), 0)
      assert.equal(mixer.getCurrentSpeaker(), null)
      assert.deepEqual(mixer.getStats(), { outputSamples: 0, droppedSamples: 0, stalls: 0, tracks: [] })
      assert.equal(mixer._silenceMs, 0)
    })
  })
})
