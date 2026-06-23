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
    this.departed = new Set() // ids of participants that have left
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
    this.segmentSpeakers = new Map() // segmentId -> { speaker, assignedAt }
    this.gracePeriodMs = options.gracePeriodMs != null ? options.gracePeriodMs : DEFAULT_GRACE_PERIOD_MS
  }

  // A speaker can only be stamped onto a segment if it has not left the meeting.
  // `participant-left` and `speakerChanged` are independent events, so a reorder
  // can leave currentSpeaker/lastKnownSpeaker pointing at a departed participant.
  // We only suppress participants we have actually seen leave (the `departed`
  // set): speakers that were never explicitly tracked are passed through.
  _presentSpeaker (speaker) {
    if (!speaker) return null
    if (this.departed.has(speaker.id) && !this.participants.has(speaker.id)) return null
    return speaker
  }

  updateParticipant (message) {
    if (message.action === 'join') {
      this.participants.set(message.participant.id, message.participant)
      this.departed.delete(message.participant.id)
      logger.debug(`SpeakerTracker: participant joined ${message.participant.name || message.participant.id}`)
    } else if (message.action === 'leave') {
      const id = message.participant.id
      this.participants.delete(id)
      this.departed.add(id)
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
      speaker: this._presentSpeaker(this.currentSpeaker || this.lastKnownSpeaker),
      assignedAt: this._now()
    })
  }

  getSpeakerForSegment (segmentId) {
    const entry = this.segmentSpeakers.get(segmentId)
    // A participant may have left between assignment and read (reordered events):
    // never surface a departed participant for the segment.
    return entry ? this._presentSpeaker(entry.speaker) : null
  }

  clearSegment (segmentId) {
    this.segmentSpeakers.delete(segmentId)
  }

  clear () {
    this.participants.clear()
    this.departed.clear()
    this.segmentSpeakers.clear()
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
  }

  _now () {
    return Date.now()
  }
}

module.exports = SpeakerTracker
