const { logger } = require('live-srt-lib')

/**
 * SpeakerTracker - Tracks speaker activity from LiveKit native diarization.
 *
 * Receives speaker metadata from the LivekitBot AudioMixer and correlates
 * it with ASR transcription timestamps to determine who spoke each segment.
 *
 * This enables native diarization with:
 * - Real-time speaker identification (no ASR delay)
 * - Actual participant names (not "Speaker 1", "Speaker 2")
 * - Higher accuracy than ASR-based diarization
 */
class SpeakerTracker {
  constructor () {
    this.participants = new Map() // id -> { name, ... }
    this.speakerEvents = [] // [{timestamp, position, speakers}]
    this.maxEventAge = 60000 // 60 seconds retention
  }

  /**
   * Updates participant information (join/leave).
   * @param {Object} message - { action: 'join'|'leave', participant: { id, name } }
   */
  updateParticipant (message) {
    if (message.action === 'join') {
      this.participants.set(message.participant.id, message.participant)
      logger.debug(`SpeakerTracker: Participant joined: ${message.participant.name || message.participant.id}`)
    } else if (message.action === 'leave') {
      this.participants.delete(message.participant.id)
      logger.debug(`SpeakerTracker: Participant left: ${message.participant.id}`)
    }
  }

  /**
   * Adds a speaker event from the AudioMixer.
   * @param {Object} event - { timestamp, position, speakers: [{id, energy}] }
   */
  addSpeakerEvent (event) {
    this.speakerEvents.push({
      timestamp: event.timestamp,
      position: event.position,
      speakers: event.speakers
    })

    // Clean up old events to prevent memory leak
    this.cleanupOldEvents()
  }

  /**
   * Removes speaker events older than maxEventAge.
   */
  cleanupOldEvents () {
    const cutoff = Date.now() - this.maxEventAge
    const originalLength = this.speakerEvents.length
    this.speakerEvents = this.speakerEvents.filter(e => e.timestamp > cutoff)

    if (this.speakerEvents.length < originalLength) {
      logger.debug(`SpeakerTracker: Cleaned up ${originalLength - this.speakerEvents.length} old events`)
    }
  }

  /**
   * Finds the dominant speaker for a given timestamp range.
   * Used to associate ASR transcriptions with speakers.
   *
   * @param {number} timestamp - Start timestamp of the transcription segment
   * @param {number} duration - Duration of the segment in milliseconds
   * @returns {string|null} - Speaker ID with highest cumulative energy, or null
   */
  getSpeakerForTimestamp (timestamp, duration) {
    // Find events within the time range (with 100ms margin for timing variations)
    const start = timestamp - 100
    const end = timestamp + duration + 100

    const relevantEvents = this.speakerEvents.filter(
      e => e.timestamp >= start && e.timestamp <= end
    )

    if (relevantEvents.length === 0) {
      return null
    }

    // Aggregate energy per speaker across all relevant events
    const speakerEnergies = new Map()
    for (const event of relevantEvents) {
      for (const speaker of event.speakers) {
        const current = speakerEnergies.get(speaker.id) || 0
        speakerEnergies.set(speaker.id, current + speaker.energy)
      }
    }

    // Find the speaker with the highest cumulative energy
    let maxEnergy = 0
    let dominantSpeaker = null
    for (const [id, energy] of speakerEnergies) {
      if (energy > maxEnergy) {
        maxEnergy = energy
        dominantSpeaker = id
      }
    }

    return dominantSpeaker
  }

  /**
   * Gets the display name of a participant.
   * @param {string} id - Participant ID
   * @returns {string} - Participant name, or ID if name not found
   */
  getParticipantName (id) {
    const participant = this.participants.get(id)
    return participant?.name || id
  }

  /**
   * Gets all current participants.
   * @returns {Array<{id: string, name: string}>}
   */
  getParticipants () {
    return Array.from(this.participants.values())
  }

  /**
   * Checks if there are any speaker events.
   * @returns {boolean}
   */
  hasSpeakerEvents () {
    return this.speakerEvents.length > 0
  }

  /**
   * Gets statistics for debugging.
   * @returns {Object}
   */
  getStats () {
    return {
      participantCount: this.participants.size,
      eventCount: this.speakerEvents.length,
      oldestEventAge: this.speakerEvents.length > 0
        ? Date.now() - this.speakerEvents[0].timestamp
        : 0
    }
  }

  /**
   * Clears all data.
   */
  clear () {
    this.participants.clear()
    this.speakerEvents = []
  }
}

module.exports = SpeakerTracker
