const { logger } = require('live-srt-lib')

/**
 * SpeakerTracker - Tracks speaker changes for native diarization.
 *
 * Receives speaker change events from the bot (LiveKit/Teams) and provides
 * segment-based speaker assignment for ASR transcriptions.
 *
 * Speaker assignment strategy:
 * - The bot updates `currentSpeaker` in real-time via speakerChanged events
 * - When the ASR wrapper sees a new segmentId for the first time, it calls
 *   assignSpeakerToSegment() which "freezes" currentSpeaker for that segment
 * - All subsequent partials and the final of that segment return the same speaker
 */
class SpeakerTracker {
  constructor () {
    this.participants = new Map() // id -> { id, name }
    this.currentSpeaker = null // {id, name} | null — updated in real-time by bot
    this.segmentSpeakers = new Map() // segmentId -> {id, name} | null
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
   * Records a speaker change event from the bot.
   * Updates currentSpeaker in real-time.
   * @param {Object} event - { position: number, speaker: {id, name} | null }
   */
  addSpeakerChange (event) {
    this.currentSpeaker = event.speaker
  }

  /**
   * Associates the current speaker with a segment.
   * Called at each partial/final. Only the first call for a given segmentId
   * "freezes" the speaker — subsequent calls are no-ops.
   * @param {number} segmentId
   */
  assignSpeakerToSegment (segmentId) {
    if (!this.segmentSpeakers.has(segmentId)) {
      this.segmentSpeakers.set(segmentId, this.currentSpeaker)
    }
  }

  /**
   * Returns the speaker assigned to a segment.
   * @param {number} segmentId
   * @returns {{id: string, name: string}|null}
   */
  getSpeakerForSegment (segmentId) {
    return this.segmentSpeakers.get(segmentId) || null
  }

  /**
   * Removes a completed segment from the map.
   * Called by the ASR wrapper after emitting a final.
   * @param {number} segmentId
   */
  clearSegment (segmentId) {
    this.segmentSpeakers.delete(segmentId)
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
   * Gets statistics for debugging.
   * @returns {Object}
   */
  getStats () {
    return {
      participantCount: this.participants.size,
      activeSegments: this.segmentSpeakers.size,
      currentSpeaker: this.currentSpeaker?.name || null
    }
  }

  /**
   * Clears all data.
   */
  clear () {
    this.participants.clear()
    this.segmentSpeakers.clear()
    this.currentSpeaker = null
  }
}

module.exports = SpeakerTracker
