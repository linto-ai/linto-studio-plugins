const { logger } = require('live-srt-lib')

/**
 * SpeakerTracker - Tracks speaker changes for native diarization.
 *
 * Receives speaker change events from the bot (LivekitBot) and provides
 * a simple lookup to find who was speaking at a given position in the audio stream.
 *
 * This enables native diarization with:
 * - Real-time speaker identification (no ASR delay)
 * - Actual participant names (not "Speaker 1", "Speaker 2")
 * - Simple position-based correlation with ASR results
 */
class SpeakerTracker {
  constructor () {
    this.participants = new Map() // id -> { id, name }
    this.changes = [] // [{position, speaker: {id, name} | null}]
    this.maxRetentionMs = 60000 // 60 seconds retention
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
   * Records a speaker change event.
   * @param {Object} event - { position: number, speaker: {id, name} | null }
   */
  addSpeakerChange (event) {
    this.changes.push({
      position: event.position,
      speaker: event.speaker
    })

    // Clean up old events to prevent memory leak
    this.cleanup()
  }

  /**
   * Removes speaker changes older than maxRetentionMs based on position.
   */
  cleanup () {
    if (this.changes.length === 0) return

    // Get the latest position
    const latestPosition = this.changes[this.changes.length - 1].position
    const cutoff = latestPosition - this.maxRetentionMs

    const originalLength = this.changes.length
    this.changes = this.changes.filter(c => c.position > cutoff)

    if (this.changes.length < originalLength) {
      logger.debug(`SpeakerTracker: Cleaned up ${originalLength - this.changes.length} old changes`)
    }
  }

  /**
   * Finds the speaker at a given position in the audio stream.
   * Returns the last speaker change that occurred before or at this position.
   *
   * @param {number} position - Position in ms in the audio stream (from ASR start/end)
   * @returns {{id: string, name: string}|null} - Speaker info or null if silence/unknown
   */
  getSpeakerAtPosition (position) {
    // Find the last change that occurred at or before this position
    for (let i = this.changes.length - 1; i >= 0; i--) {
      if (this.changes[i].position <= position) {
        return this.changes[i].speaker
      }
    }
    return null
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
   * Checks if there are any speaker changes recorded.
   * @returns {boolean}
   */
  hasSpeakerChanges () {
    return this.changes.length > 0
  }

  /**
   * Gets statistics for debugging.
   * @returns {Object}
   */
  getStats () {
    return {
      participantCount: this.participants.size,
      changeCount: this.changes.length,
      latestPosition: this.changes.length > 0
        ? this.changes[this.changes.length - 1].position
        : 0
    }
  }

  /**
   * Clears all data.
   */
  clear () {
    this.participants.clear()
    this.changes = []
  }
}

module.exports = SpeakerTracker
