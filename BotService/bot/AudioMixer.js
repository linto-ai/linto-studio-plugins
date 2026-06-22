const EventEmitter = require('events')

// Wire format shared with the Transcriber WS ingest and the in-browser capture:
// 16 kHz, signed 16-bit little-endian, mono. 20 ms frames are the standard unit
// for real-time speech (matches WebRTC/Opus framing) and keep diarization
// positions aligned to a stable grid.
const SAMPLE_RATE = 16000
const FRAME_DURATION_MS = 20
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000 // 320 samples / 640 bytes

const DEFAULTS = {
  // Per-participant ring buffer depth (~200 ms) — absorbs jitter between the
  // browser capture cadence and the fixed 20 ms mix tick without unbounded growth.
  bufferFrames: 10,
  // RMS amplitude above which a participant is considered to be speaking. Tuned
  // for S16LE speech; below this is treated as silence/background noise.
  energyThreshold: 500,
  // Hold the current speaker for this long after they go quiet before emitting a
  // silence (null-speaker) transition. Intra-speech pauses are 300–800 ms, so a
  // shorter grace would flap the diarization label on every breath.
  silenceGraceMs: 2000
}

/**
 * AudioMixer — synchronises and mixes per-participant PCM streams (SFU bots:
 * LiveKit/Visio, Jitsi) into a single coherent S16LE 16 kHz mono stream, and
 * derives a native-diarization "who is speaking" signal by energy-based VAD.
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

    this.participantBuffers = new Map() // participantId -> ring buffer state
    this.mixInterval = null
    this.mixPosition = 0 // absolute position in ms since start() — diarization clock
    this.currentSpeaker = null // { id, name } | null
    this._silenceMs = 0

    // Pre-allocated mix accumulator: the hot path runs 50×/s, so we avoid a
    // per-frame allocation here.
    this._mixedFrame = new Int16Array(SAMPLES_PER_FRAME)
  }

  /**
   * Feed PCM for a participant. Late/early frames are absorbed by the ring
   * buffer; overflow drops the oldest samples (preferring fresh audio).
   * @param {string} participantId
   * @param {Buffer} pcmBuffer S16LE mono 16 kHz
   * @param {number} [timestamp] arrival timestamp in ms (informational)
   * @param {string} [participantName]
   */
  addAudio (participantId, pcmBuffer, timestamp = 0, participantName = null) {
    let participant = this.participantBuffers.get(participantId)
    if (!participant) {
      participant = {
        buffer: new Int16Array(this.bufferSize),
        writePos: 0,
        readPos: 0,
        samplesAvailable: 0,
        name: participantName || participantId
      }
      this.participantBuffers.set(participantId, participant)
    }
    if (participantName) participant.name = participantName

    // Reinterpret the Buffer as Int16. Buffer pooling can yield an odd byteOffset
    // that would make a zero-copy Int16Array view throw; copy only in that case.
    const aligned = pcmBuffer.byteOffset % 2 === 0 ? pcmBuffer : Buffer.from(pcmBuffer)
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2))

    for (let i = 0; i < samples.length; i++) {
      participant.buffer[participant.writePos] = samples[i]
      participant.writePos = (participant.writePos + 1) % this.bufferSize
      if (participant.samplesAvailable < this.bufferSize) {
        participant.samplesAvailable++
      } else {
        // Buffer full: advance readPos so we keep the most recent audio.
        participant.readPos = (participant.readPos + 1) % this.bufferSize
      }
    }
    participant.lastTimestamp = timestamp
  }

  /** Start the periodic mix tick. Idempotent. */
  start () {
    if (this.mixInterval) return
    this.mixPosition = 0
    this._silenceMs = 0
    this.mixInterval = setInterval(() => this.mixAndEmit(), FRAME_DURATION_MS)
  }

  /**
   * Mix one frame from every participant that has enough buffered samples,
   * pick the dominant speaker by RMS energy, and emit the frame (+ a speaker
   * transition when it changes). Called every 20 ms.
   */
  mixAndEmit () {
    const mixedFrame = this._mixedFrame
    mixedFrame.fill(0)
    let maxEnergy = 0
    let dominantSpeakerId = null
    let dominantSpeakerName = null

    for (const [participantId, participant] of this.participantBuffers) {
      if (participant.samplesAvailable < SAMPLES_PER_FRAME) continue

      let energySq = 0
      for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const sample = participant.buffer[participant.readPos]
        participant.readPos = (participant.readPos + 1) % this.bufferSize
        const mixed = mixedFrame[i] + sample
        mixedFrame[i] = mixed > 32767 ? 32767 : (mixed < -32768 ? -32768 : mixed)
        energySq += sample * sample
      }
      participant.samplesAvailable -= SAMPLES_PER_FRAME

      const energy = Math.sqrt(energySq / SAMPLES_PER_FRAME)
      if (energy > this.energyThreshold && energy > maxEnergy) {
        maxEnergy = energy
        dominantSpeakerId = participantId
        dominantSpeakerName = participant.name
      }
    }

    // Copy out: 'audio' consumers may hold the buffer across frames, and the
    // accumulator is reused next tick.
    const out = Buffer.allocUnsafe(mixedFrame.byteLength)
    out.set(new Uint8Array(mixedFrame.buffer, mixedFrame.byteOffset, mixedFrame.byteLength))
    this.emit('audio', out)

    this._updateSpeaker(dominantSpeakerId, dominantSpeakerName)
    this.mixPosition += FRAME_DURATION_MS
  }

  _updateSpeaker (dominantSpeakerId, dominantSpeakerName) {
    const currentId = this.currentSpeaker ? this.currentSpeaker.id : null

    if (dominantSpeakerId) {
      this._silenceMs = 0
      if (currentId !== dominantSpeakerId) {
        this.currentSpeaker = { id: dominantSpeakerId, name: dominantSpeakerName }
        this._emitSpeaker(this.currentSpeaker)
      }
      return
    }

    if (currentId !== null) {
      // Nobody speaking. Only emit a silence transition after the grace period,
      // and only when there is more than one participant — a lone participant's
      // pauses are not a meaningful diarization boundary.
      this._silenceMs += FRAME_DURATION_MS
      if (this._silenceMs >= this.silenceGraceMs && this.participantBuffers.size > 1) {
        this.currentSpeaker = null
        this._silenceMs = 0
        this._emitSpeaker(null)
      }
    }
  }

  _emitSpeaker (speaker) {
    this.emit('speakerChanged', { type: 'speakerChanged', position: this.mixPosition, speaker })
  }

  /** Forget a participant (left the meeting). Clears the speaker if it was them. */
  removeParticipant (participantId) {
    this.participantBuffers.delete(participantId)
    if (this.currentSpeaker && this.currentSpeaker.id === participantId) {
      this.currentSpeaker = null
      this._silenceMs = 0
    }
  }

  hasParticipant (participantId) {
    return this.participantBuffers.has(participantId)
  }

  getParticipants () {
    return Array.from(this.participantBuffers.keys()).map(id => ({ id }))
  }

  getPositionMs () {
    return this.mixPosition
  }

  getCurrentSpeaker () {
    return this.currentSpeaker
  }

  /** Stop the mix tick and clear all state. Idempotent. */
  stop () {
    if (this.mixInterval) {
      clearInterval(this.mixInterval)
      this.mixInterval = null
    }
    this.participantBuffers.clear()
    this.mixPosition = 0
    this.currentSpeaker = null
    this._silenceMs = 0
  }
}

module.exports = AudioMixer
module.exports.SAMPLE_RATE = SAMPLE_RATE
module.exports.FRAME_DURATION_MS = FRAME_DURATION_MS
module.exports.SAMPLES_PER_FRAME = SAMPLES_PER_FRAME
