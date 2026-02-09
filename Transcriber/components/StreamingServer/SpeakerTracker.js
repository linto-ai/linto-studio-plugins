const { logger } = require('live-srt-lib')

const DEFAULT_GRACE_PERIOD_MS = 200

/**
 * SpeakerTracker - Tracks speaker changes for native diarization.
 *
 * Receives speaker change events from the bot (LiveKit/Teams) and provides
 * segment-based speaker assignment for ASR transcriptions.
 *
 * Speaker assignment strategy:
 * - The bot updates `currentSpeaker` in real-time via speakerChanged events
 * - When the ASR wrapper sees a new segmentId for the first time, it calls
 *   assignSpeakerToSegment() which assigns the current speaker to that segment
 * - A grace period allows late-arriving speakerChanged events to correct
 *   the assignment (handles race conditions between bot events and ASR partials)
 * - After the grace period, the assignment is locked and won't change
 * - If currentSpeaker is null (silence), lastKnownSpeaker is used as fallback
 */
class SpeakerTracker {
  constructor (options = {}) {
    this.participants = new Map() // id -> { id, name }
    this.currentSpeaker = null // {id, name} | null — updated in real-time by bot
    this.lastKnownSpeaker = null // {id, name} | null — last non-null speaker, for fallback during silence
    this.segmentSpeakers = new Map() // segmentId -> { speaker, assignedAt }
    this.gracePeriodMs = options.gracePeriodMs != null ? options.gracePeriodMs : DEFAULT_GRACE_PERIOD_MS
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
   * Updates currentSpeaker and lastKnownSpeaker in real-time.
   * Also reactively corrects any active segments still within their grace period.
   * @param {Object} event - { position: number, speaker: {id, name} | null }
   */
  addSpeakerChange (event) {
    this.currentSpeaker = event.speaker
    logger.debug(`SpeakerTracker: Dominant speaker changed: ${event.speaker?.name || 'silence'} (position: ${event.position}ms)`)

    if (event.speaker) {
      this.lastKnownSpeaker = event.speaker

      // Reactive update: correct active segments within grace period.
      // This handles the race condition where a speakerChanged event arrives
      // shortly after the first partial of a segment (the segment was assigned
      // to the previous speaker, but the new speaker is the correct one).
      // Silence events (speaker=null) don't update segments — if someone stops
      // speaking mid-segment, the segment keeps its original speaker.
      const now = Date.now()
      for (const [, entry] of this.segmentSpeakers) {
        if (now - entry.assignedAt < this.gracePeriodMs) {
          entry.speaker = event.speaker
        }
      }
    }
  }

  /**
   * Associates the current speaker with a segment.
   * Called at each partial/final. Only the first call for a given segmentId
   * creates the assignment. The speaker may still be updated reactively by
   * addSpeakerChange() during the grace period.
   * @param {number} segmentId
   */
  assignSpeakerToSegment (segmentId) {
    if (!this.segmentSpeakers.has(segmentId)) {
      const speaker = this.currentSpeaker || this.lastKnownSpeaker
      this.segmentSpeakers.set(segmentId, {
        speaker,
        assignedAt: Date.now()
      })
    }
  }

  /**
   * Returns the speaker assigned to a segment.
   * @param {number} segmentId
   * @returns {{id: string, name: string}|null}
   */
  getSpeakerForSegment (segmentId) {
    const entry = this.segmentSpeakers.get(segmentId)
    return entry ? entry.speaker : null
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
    this.lastKnownSpeaker = null
  }
}

module.exports = SpeakerTracker
