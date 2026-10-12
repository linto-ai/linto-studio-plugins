const EventEmitter = require('events')
const { logger } = require('live-srt-lib')

// Emit at most one overflow warning per track every this many dropped samples,
// so a sustained overflow is visible in the log without flooding it (the drop
// itself is counted every time, lock-free).
const DROP_WARN_EVERY = 500

// Wire format shared with the Transcriber WS ingest and the in-browser capture:
// 16 kHz, signed 16-bit little-endian, mono. 20 ms frames are the standard unit
// for real-time speech (matches WebRTC/Opus framing) and keep diarization
// positions aligned to a stable grid.
const SAMPLE_RATE = 16000
const FRAME_DURATION_MS = 20
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000 // 320 samples / 640 bytes

const DEFAULTS = {
  // Per-track ring buffer depth (~3.2 s). A flowing track holds less than a frame
  // plus one delivery, and a lagging one at most maxLagMs more; the depth is a
  // safety net for an oversized delivery, whose oldest samples are dropped
  // (counted) on overflow.
  bufferFrames: 160,
  // Bounded wait for a lagging track: a frame is held while a track that is
  // flowing has less than a frame buffered, until another track is this far
  // ahead. The page delivers every track's render quanta in order (8 ms at
  // 16 kHz, or 256 ms ScriptProcessor chunks in the fallback), so a track this
  // far behind has stopped delivering, or delivers slower than the others.
  maxLagMs: 300,
  // RMS amplitude above which a participant is considered to be speaking. Tuned
  // for S16LE speech; below this is treated as silence/background noise.
  energyThreshold: 500,
  // Hold the current speaker for this long after they go quiet before emitting a
  // silence (null-speaker) transition. Intra-speech pauses are 300–800 ms, so a
  // shorter grace would flap the diarization label on every breath.
  silenceGraceMs: 2000
}

/**
 * AudioMixer — sums the captured tracks of a meeting page (one per remote audio
 * stream: a participant's microphone, their screen share audio, or a server-mixed
 * MCU/Teams stream) sample-aligned into a single S16LE 16 kHz mono stream, and,
 * for tracks attributed to participants (SFU), derives a native-diarization "who
 * is speaking" signal by energy-based VAD. A track speaks before the page has
 * mapped it to its participant (its first seconds): the speaker is then unknown
 * (null) rather than whoever spoke before, and its participant becomes the
 * speaker as soon as the mapping arrives.
 *
 * Frames are driven by the input, not by a timer: every track of a page is
 * rendered by one AudioContext and its quanta reach us in render order, so the
 * tracks advance together and a 20 ms frame is emitted as soon as every flowing
 * track has buffered one. The output therefore runs at exactly the input rate
 * (no drift against a wall clock, nothing dropped in steady state), a sample
 * waits at most one frame plus one delivery, and a single track passes through
 * unchanged. A track that falls more than maxLagMs behind is no longer waited
 * for: the rest of its frame is mixed, and it is waited for again once it
 * delivers. Nothing is emitted while no track delivers (no continuous silence).
 *
 * It is intentionally decoupled from any transport: it consumes `addAudio()`
 * calls and emits frames + speaker transitions for the caller to forward.
 *
 * @emits audio          Buffer — one mixed 20 ms frame (S16LE 16 kHz mono, 640 B)
 * @emits speakerChanged {type:'speakerChanged', position:number, speaker:{id,name}|null}
 *                       — emitted ONLY on a transition (new dominant speaker, or
 *                       silence after the grace period)
 */
class AudioMixer extends EventEmitter {
  constructor (options = {}) {
    super()
    const opts = { ...DEFAULTS, ...options }
    this.energyThreshold = opts.energyThreshold
    this.silenceGraceMs = opts.silenceGraceMs
    this.bufferSize = SAMPLES_PER_FRAME * opts.bufferFrames
    this.maxLagSamples = Math.round(opts.maxLagMs * SAMPLE_RATE / 1000)

    this.tracks = new Map() // trackId -> track state (ring buffer, attribution, counters)
    this.mixPosition = 0 // ms of mixed audio emitted — diarization clock
    this.outputSamples = 0 // samples emitted
    this.droppedSamples = 0 // samples dropped on overflow, by every track (removed ones too)
    this.stalls = 0 // stalls of every track (removed ones too)
    this.currentSpeaker = null // { id, name } | null
    this._unattributedSpeaker = null // id of the unattributed track last heard speaking
    this._silenceMs = 0

    // Pre-allocated accumulators: the hot path runs 50×/s. Tracks are summed wide
    // and clipped once, so the result does not depend on the summing order.
    this._mix = new Int32Array(SAMPLES_PER_FRAME)
    this._frame = new Int16Array(SAMPLES_PER_FRAME)
    this._participantMix = new Map() // participantId -> Int32Array, VAD sub-mix
  }

  _newTrack (id) {
    return {
      id,
      buffer: new Int16Array(this.bufferSize),
      writePos: 0,
      readPos: 0,
      samplesAvailable: 0,
      active: false, // waited for: delivering, and not left behind
      participant: null, // { id, name } the track is attributed to (SFU)
      inputSamples: 0, // samples received
      droppedSamples: 0, // samples overwritten on ring-buffer overflow
      lastWarnedDrops: 0, // droppedSamples value at the last throttled warn
      stalls: 0 // times it fell maxLag behind and stopped being waited for
    }
  }

  _track (trackId) {
    let track = this.tracks.get(trackId)
    if (!track) {
      track = this._newTrack(trackId)
      this.tracks.set(trackId, track)
    }
    return track
  }

  /**
   * Feed PCM for a track, then emit every frame it completes.
   * @param {*} trackId
   * @param {Buffer} pcmBuffer S16LE mono 16 kHz
   */
  addAudio (trackId, pcmBuffer) {
    // Reinterpret the Buffer as Int16. Buffer pooling can yield an odd byteOffset
    // that would make a zero-copy Int16Array view throw; copy only in that case.
    const aligned = pcmBuffer.byteOffset % 2 === 0 ? pcmBuffer : Buffer.from(pcmBuffer)
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2))

    const track = this._track(trackId)
    if (!track.active) {
      // A track (re)starting joins at the input's current point: the tracks that
      // are flowing hold the audio of the last deliveries, which this delivery
      // covers too, so it starts after a lead-in of silence lining it up with
      // their newest samples. Its own audio is never delayed nor cut.
      track.active = true
      this._write(track, null, Math.max(0, this._maxAvailable() - samples.length))
    }
    this._write(track, samples, samples.length)
    track.inputSamples += samples.length
    this._drain()
  }

  // Append `count` samples (zeros when `samples` is null) to a track's ring.
  // Overflow drops the oldest samples, preferring fresh audio.
  _write (track, samples, count) {
    for (let i = 0; i < count; i++) {
      track.buffer[track.writePos] = samples ? samples[i] : 0
      track.writePos = (track.writePos + 1) % this.bufferSize
      if (track.samplesAvailable < this.bufferSize) {
        track.samplesAvailable++
      } else {
        // Buffer full: advance readPos so we keep the most recent audio. The
        // overwritten oldest sample is lost — count it (no per-sample logging).
        track.readPos = (track.readPos + 1) % this.bufferSize
        track.droppedSamples++
        this.droppedSamples++
      }
    }
    // Throttled overflow warning (outside the per-sample loop).
    if (track.droppedSamples - track.lastWarnedDrops >= DROP_WARN_EVERY) {
      track.lastWarnedDrops = track.droppedSamples
      logger.warn(`AudioMixer: track ${track.id} ring-buffer overflow, ${track.droppedSamples} samples dropped`)
    }
  }

  _maxAvailable () {
    let max = 0
    for (const track of this.tracks.values()) if (track.samplesAvailable > max) max = track.samplesAvailable
    return max
  }

  // Emit frames while the buffered audio allows: once every flowing track has a
  // frame, or once a track is maxLag ahead of one that has not.
  //
  // Only LATE tracks are realigned (they stop being waited for, and line up again
  // with a lead-in). An EARLY track, holding more than the others (a burst that
  // was not preceded by a gap), keeps its offset, and that is on purpose:
  // - It cannot happen within one document: its tracks share one AudioContext
  //   and reach us through one ordered transport (ScriptProcessor callbacks are
  //   interleaved as well), so a track is never more than a delivery ahead. Only
  //   two documents capturing at once can skew, and none of the meeting clients
  //   does.
  // - The offset is bounded by maxLag: beyond it the other tracks look stalled,
  //   the backlog is mixed at once (no loss) and the tracks are aligned again.
  // - Removing it below maxLag would mean dropping up to maxLag of that track's
  //   real audio, words, to fix a relative shift between two speakers that
  //   costs the ASR nothing.
  _drain () {
    for (;;) {
      let ready = false
      let lagging = false
      for (const track of this.tracks.values()) {
        if (track.samplesAvailable >= SAMPLES_PER_FRAME) ready = true
        else if (track.active) lagging = true
      }
      if (!ready) return
      if (lagging) {
        if (this._maxAvailable() < SAMPLES_PER_FRAME + this.maxLagSamples) return
        // Stop waiting for the laggards: their buffered tail (under a frame) is the
        // audio that lines up with this frame, so it is mixed into it, and they
        // rejoin at the input's current point when they deliver again.
        for (const track of this.tracks.values()) {
          if (track.active && track.samplesAvailable < SAMPLES_PER_FRAME) {
            track.active = false
            track.stalls++
            this.stalls++
          }
        }
      }
      this._mixFrame()
    }
  }

  // Mix one frame from every track with buffered audio (a full frame, or the tail
  // of a track that just stopped being waited for), pick the dominant speaker by
  // RMS energy, and emit the frame (+ a speaker transition when it changes).
  _mixFrame () {
    const mix = this._mix
    mix.fill(0)
    // What speaks is told apart per participant (their tracks together: mic +
    // screen share) and, for a track not attributed yet, per track. In track order.
    const units = [] // { participant, sub } | { trackId, energySq }
    for (const track of this.tracks.values()) {
      const n = Math.min(track.samplesAvailable, SAMPLES_PER_FRAME)
      if (n === 0) continue
      let sub = null
      if (track.participant) {
        const id = track.participant.id
        sub = this._participantMix.get(id)
        if (!sub) {
          sub = new Int32Array(SAMPLES_PER_FRAME)
          this._participantMix.set(id, sub)
        }
        if (!units.some(u => u.participant && u.participant.id === id)) {
          sub.fill(0)
          units.push({ participant: track.participant, sub })
        }
      }
      let energySq = 0
      for (let i = 0; i < n; i++) {
        const sample = track.buffer[track.readPos]
        track.readPos = (track.readPos + 1) % this.bufferSize
        mix[i] += sample
        if (sub) sub[i] += sample
        else energySq += sample * sample
      }
      if (!sub) units.push({ trackId: track.id, energySq })
      track.samplesAvailable -= n
    }

    const frame = this._frame
    for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
      const v = mix[i]
      frame[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v)
    }
    // Copy out: 'audio' consumers may hold the buffer across frames, and the
    // accumulator is reused next frame.
    const out = Buffer.allocUnsafe(frame.byteLength)
    out.set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength))
    this.emit('audio', out)
    this.outputSamples += SAMPLES_PER_FRAME

    let maxEnergy = 0
    let dominant = null
    for (const unit of units) {
      let energySq = unit.energySq
      if (unit.sub) {
        energySq = 0
        for (let i = 0; i < SAMPLES_PER_FRAME; i++) energySq += unit.sub[i] * unit.sub[i]
      }
      const energy = Math.sqrt(energySq / SAMPLES_PER_FRAME)
      if (energy > this.energyThreshold && energy > maxEnergy) {
        maxEnergy = energy
        dominant = unit
      }
    }
    this._updateSpeaker(dominant)
    this.mixPosition += FRAME_DURATION_MS
  }

  // dominant: the loudest unit of the frame above the energy threshold, or null.
  _updateSpeaker (dominant) {
    const currentId = this.currentSpeaker ? this.currentSpeaker.id : null

    if (dominant && dominant.participant) {
      this._silenceMs = 0
      this._unattributedSpeaker = null
      if (currentId !== dominant.participant.id) {
        this.currentSpeaker = { id: dominant.participant.id, name: dominant.participant.name }
        this._emitSpeaker(this.currentSpeaker)
      }
      return
    }

    if (dominant) {
      // A track not attributed yet is speaking (its participant is not mapped
      // yet): the speaker is unknown, and keeping the previous one would put their
      // name on someone else's words. Its participant is announced as soon as the
      // track is attributed (setTrackParticipant).
      this._silenceMs = 0
      this._unattributedSpeaker = dominant.trackId
      if (currentId !== null) {
        this.currentSpeaker = null
        this._emitSpeaker(null)
      }
      return
    }

    if (currentId !== null) {
      // Nobody speaking. Only emit a silence transition after the grace period,
      // and only when there is more than one participant — a lone participant's
      // pauses are not a meaningful diarization boundary.
      this._silenceMs += FRAME_DURATION_MS
      if (this._silenceMs >= this.silenceGraceMs && this._participantCount() > 1) {
        this.currentSpeaker = null
        this._silenceMs = 0
        this._emitSpeaker(null)
      }
    } else if (this._unattributedSpeaker !== null) {
      // The unattributed track is quiet: past the grace, its mapping no longer
      // means that its participant is the one speaking.
      this._silenceMs += FRAME_DURATION_MS
      if (this._silenceMs >= this.silenceGraceMs) {
        this._unattributedSpeaker = null
        this._silenceMs = 0
      }
    }
  }

  _participantCount () {
    const ids = new Set()
    for (const track of this.tracks.values()) if (track.participant) ids.add(track.participant.id)
    return ids.size
  }

  _emitSpeaker (speaker) {
    this.emit('speakerChanged', { type: 'speakerChanged', position: this.mixPosition, speaker })
  }

  /**
   * Attribute a track to a participant (SFU native diarization), or to nobody.
   * Unattributed tracks are mixed but never make anyone the speaker. When the
   * track is the one heard speaking, its participant becomes the speaker at once
   * (rather than at their next loud frame), so that the segment under way can
   * still be put on them.
   * @param {*} trackId
   * @param {{id:string, name?:string}|null} participant
   */
  setTrackParticipant (trackId, participant) {
    const track = this._track(trackId)
    track.participant = participant ? { id: participant.id, name: participant.name || participant.id } : null
    if (track.participant && this._unattributedSpeaker === trackId) {
      this._unattributedSpeaker = null
      this._silenceMs = 0
      this.currentSpeaker = { id: track.participant.id, name: track.participant.name }
      this._emitSpeaker(this.currentSpeaker)
    }
  }

  /** Forget a track (it ended). Its unmixed tail (under a frame) goes with it. */
  removeTrack (trackId) {
    if (!this.tracks.delete(trackId)) return
    if (this._unattributedSpeaker === trackId) this._unattributedSpeaker = null
    this._drain() // nobody waits for it anymore
  }

  /**
   * Forget a participant (left the meeting): their tracks are no longer attributed
   * to them, and the current speaker is cleared if it was them.
   */
  removeParticipant (participantId) {
    for (const track of this.tracks.values()) {
      if (track.participant && track.participant.id === participantId) track.participant = null
    }
    this._participantMix.delete(participantId)
    if (this.currentSpeaker && this.currentSpeaker.id === participantId) {
      this.currentSpeaker = null
      this._silenceMs = 0
    }
  }

  hasTrack (trackId) {
    return this.tracks.has(trackId)
  }

  trackIds () {
    return Array.from(this.tracks.keys())
  }

  getPositionMs () {
    return this.mixPosition
  }

  getCurrentSpeaker () {
    return this.currentSpeaker
  }

  /**
   * Counters for health logging: samples emitted, samples dropped and stalls in
   * total, and per track the samples received, dropped on overflow, buffered, and
   * its stalls.
   * @returns {{outputSamples:number, droppedSamples:number, stalls:number,
   *   tracks:Array<{id, participantId:string|null, active:boolean, inputSamples:number,
   *   droppedSamples:number, bufferedSamples:number, stalls:number}>}}
   */
  getStats () {
    return {
      outputSamples: this.outputSamples,
      droppedSamples: this.droppedSamples,
      stalls: this.stalls,
      tracks: Array.from(this.tracks.values(), (t) => ({
        id: t.id,
        participantId: t.participant ? t.participant.id : null,
        active: t.active,
        inputSamples: t.inputSamples,
        droppedSamples: t.droppedSamples,
        bufferedSamples: t.samplesAvailable,
        stalls: t.stalls
      }))
    }
  }

  /** Clear all state. Idempotent. */
  stop () {
    this.tracks.clear()
    this._participantMix.clear()
    this.mixPosition = 0
    this.outputSamples = 0
    this.droppedSamples = 0
    this.stalls = 0
    this.currentSpeaker = null
    this._unattributedSpeaker = null
    this._silenceMs = 0
  }
}

module.exports = AudioMixer
module.exports.SAMPLE_RATE = SAMPLE_RATE
module.exports.FRAME_DURATION_MS = FRAME_DURATION_MS
module.exports.SAMPLES_PER_FRAME = SAMPLES_PER_FRAME
