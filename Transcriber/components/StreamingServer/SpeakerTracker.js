const { logger } = require('live-srt-lib')

const DEFAULT_GRACE_PERIOD_MS = 200

/**
 * SpeakerTracker — native diarization for bot streams.
 *
 * A meeting bot streams, alongside the mixed audio, real-time speaker changes
 * (SFU: energy-VAD on per-participant tracks; Teams: page-polled). This tracker
 * turns that signal into a per-ASR-segment speaker assignment:
 *   - `addSpeakerChange` keeps `currentSpeaker` up to date (and `lastKnownSpeaker`
 *     as a fallback during silence);
 *   - `assignSpeakerToSegment` pins the current speaker the first time a segmentId
 *     is seen by the ASR;
 *   - a short grace period lets a speakerChanged that arrives just after the
 *     segment's first partial correct the assignment (ASR partial vs bot event race).
 */
class SpeakerTracker {
  constructor (options = {}) {
    this.participants = new Map() // id -> { id, name }
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
    this.segmentSpeakers = new Map() // segmentId -> { speaker, assignedAt }
    this.gracePeriodMs = options.gracePeriodMs != null ? options.gracePeriodMs : DEFAULT_GRACE_PERIOD_MS
  }

  updateParticipant (message) {
    if (message.action === 'join') {
      this.participants.set(message.participant.id, message.participant)
      logger.debug(`SpeakerTracker: participant joined ${message.participant.name || message.participant.id}`)
    } else if (message.action === 'leave') {
      const id = message.participant.id
      this.participants.delete(id)
      // Don't keep stamping a departed participant onto new segments.
      if (this.currentSpeaker && this.currentSpeaker.id === id) this.currentSpeaker = null
      if (this.lastKnownSpeaker && this.lastKnownSpeaker.id === id) this.lastKnownSpeaker = null
      logger.debug(`SpeakerTracker: participant left ${id}`)
    }
  }

  addSpeakerChange (event) {
    this.currentSpeaker = event.speaker || null
    if (!event.speaker) return
    this.lastKnownSpeaker = event.speaker
    // Reactively correct segments still within their grace window (the segment
    // may have been assigned to the previous speaker a few ms before this event).
    const now = this._now()
    for (const entry of this.segmentSpeakers.values()) {
      if (now - entry.assignedAt < this.gracePeriodMs) entry.speaker = event.speaker
    }
  }

  assignSpeakerToSegment (segmentId) {
    if (segmentId == null || this.segmentSpeakers.has(segmentId)) return
    this.segmentSpeakers.set(segmentId, {
      speaker: this.currentSpeaker || this.lastKnownSpeaker,
      assignedAt: this._now()
    })
  }

  getSpeakerForSegment (segmentId) {
    const entry = this.segmentSpeakers.get(segmentId)
    return entry ? entry.speaker : null
  }

  clearSegment (segmentId) {
    this.segmentSpeakers.delete(segmentId)
  }

  clear () {
    this.participants.clear()
    this.segmentSpeakers.clear()
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
  }

  _now () {
    return Date.now()
  }
}

module.exports = SpeakerTracker
