const EventEmitter = require('events')

const SAMPLE_RATE = 16000
const FRAME_DURATION_MS = 20 // 20ms frames standard
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000 // 320 samples
const BUFFER_SIZE = SAMPLES_PER_FRAME * 10 // ~200ms buffer per participant
const ENERGY_THRESHOLD = 500 // VAD threshold for voice detection

/**
 * AudioMixer - Synchronizes and mixes audio from multiple LiveKit participants.
 *
 * Takes separate audio streams per participant and:
 * 1. Mixes them into a single coherent audio stream
 * 2. Tracks which participant is speaking via energy detection (VAD)
 * 3. Emits speaker metadata for native diarization
 *
 * @emits audio - Mixed PCM audio buffer (Buffer, S16LE 16kHz mono)
 * @emits speaker - Speaker metadata ({ timestamp, position, speakers: [{id, energy}] })
 */
class AudioMixer extends EventEmitter {
  constructor () {
    super()
    this.participantBuffers = new Map() // participantId -> { buffer, writePos, lastTimestamp }
    this.mixInterval = null
    this.mixPosition = 0 // Absolute position in samples (for timestamp correlation)
    this.startTime = null // Timestamp when mixing started
  }

  /**
   * Adds audio samples for a participant.
   * @param {string} participantId - Unique identifier of the participant
   * @param {Buffer} pcmBuffer - PCM S16LE audio buffer
   * @param {number} timestamp - Timestamp in milliseconds
   */
  addAudio (participantId, pcmBuffer, timestamp) {
    if (!this.participantBuffers.has(participantId)) {
      this.participantBuffers.set(participantId, {
        buffer: new Int16Array(BUFFER_SIZE),
        writePos: 0,
        readPos: 0,
        lastTimestamp: timestamp,
        samplesAvailable: 0
      })
    }

    const participant = this.participantBuffers.get(participantId)

    // Convert Buffer to Int16Array
    const samples = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2
    )

    // Write samples into circular buffer
    for (let i = 0; i < samples.length; i++) {
      participant.buffer[participant.writePos] = samples[i]
      participant.writePos = (participant.writePos + 1) % BUFFER_SIZE
    }

    participant.samplesAvailable = Math.min(
      participant.samplesAvailable + samples.length,
      BUFFER_SIZE
    )
    participant.lastTimestamp = timestamp
  }

  /**
   * Starts the periodic mixing process.
   */
  start () {
    if (this.mixInterval) {
      return // Already running
    }

    this.startTime = Date.now()
    this.mixPosition = 0
    this.mixInterval = setInterval(() => this.mixAndEmit(), FRAME_DURATION_MS)
  }

  /**
   * Mixes all participant buffers and emits the result.
   * Called every FRAME_DURATION_MS (20ms).
   */
  mixAndEmit () {
    const mixedFrame = new Int16Array(SAMPLES_PER_FRAME)
    const activeSpeakers = []
    const timestamp = Date.now()

    // Mix all participants
    for (const [participantId, participant] of this.participantBuffers) {
      // Skip if not enough samples available
      if (participant.samplesAvailable < SAMPLES_PER_FRAME) {
        continue
      }

      let energy = 0

      for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const sample = participant.buffer[participant.readPos]
        participant.readPos = (participant.readPos + 1) % BUFFER_SIZE

        // Add sample to mix with clipping
        const mixed = mixedFrame[i] + sample
        mixedFrame[i] = Math.max(-32768, Math.min(32767, mixed))

        // Calculate energy (RMS)
        energy += sample * sample
      }

      participant.samplesAvailable -= SAMPLES_PER_FRAME

      // Calculate RMS energy
      energy = Math.sqrt(energy / SAMPLES_PER_FRAME)

      // VAD: if energy exceeds threshold, speaker is active
      if (energy > ENERGY_THRESHOLD) {
        activeSpeakers.push({
          id: participantId,
          energy: Math.round(energy)
        })
      }
    }

    // Emit mixed audio
    const outputBuffer = Buffer.from(mixedFrame.buffer)
    this.emit('audio', outputBuffer)

    // Emit speaker metadata if someone is speaking
    if (activeSpeakers.length > 0) {
      // Sort by energy (descending)
      activeSpeakers.sort((a, b) => b.energy - a.energy)

      this.emit('speaker', {
        type: 'speaker',
        timestamp,
        position: this.mixPosition,
        speakers: activeSpeakers
      })
    }

    this.mixPosition += SAMPLES_PER_FRAME
  }

  /**
   * Removes a participant from the mixer.
   * @param {string} participantId - Participant to remove
   */
  removeParticipant (participantId) {
    this.participantBuffers.delete(participantId)
  }

  /**
   * Gets the list of current participants.
   * @returns {Array<{id: string, name: string}>}
   */
  getParticipants () {
    return Array.from(this.participantBuffers.keys()).map(id => ({ id }))
  }

  /**
   * Checks if a participant exists in the mixer.
   * @param {string} participantId
   * @returns {boolean}
   */
  hasParticipant (participantId) {
    return this.participantBuffers.has(participantId)
  }

  /**
   * Stops the mixer and clears all buffers.
   */
  stop () {
    if (this.mixInterval) {
      clearInterval(this.mixInterval)
      this.mixInterval = null
    }
    this.participantBuffers.clear()
    this.mixPosition = 0
    this.startTime = null
  }

  /**
   * Gets the current mixing position in milliseconds.
   * @returns {number}
   */
  getPositionMs () {
    return (this.mixPosition / SAMPLE_RATE) * 1000
  }
}

module.exports = AudioMixer
