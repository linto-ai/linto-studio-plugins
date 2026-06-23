const { logger } = require('live-srt-lib')

const DEFAULT_GRACE_PERIOD_MS = 200
// Cap of the in-memory diarization-event ring kept for debugging. Bounded so a
// long-running channel can never grow it without limit (one entry per
// assignment/correction, dropped FIFO past this size).
const DEFAULT_EVENT_RING_SIZE = 50

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
    // Bounded ring of recent diarization events for offline debugging of locutor
    // accuracy. Not on any hot path (one push per assignment/grace-correction).
    this.eventRingSize = options.eventRingSize != null ? options.eventRingSize : DEFAULT_EVENT_RING_SIZE
    this._events = [] // { position, action, speaker } — FIFO, capped at eventRingSize
  }

  // Record a diarization event into the bounded debug ring. `position` is the
  // segmentId or speaker-change position, `action` a short tag, `speaker` the
  // id/name pair (or null for silence).
  _recordEvent (position, action, speaker) {
    this._events.push({
      position,
      action,
      speaker: speaker ? { id: speaker.id, name: speaker.name } : null
    })
    if (this._events.length > this.eventRingSize) this._events.shift()
  }

  // Snapshot of the recent diarization events (oldest first). Returns a copy so
  // callers cannot mutate internal state.
  getRecentEvents () {
    return this._events.slice()
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
    for (const [segmentId, entry] of this.segmentSpeakers) {
      if (now - entry.assignedAt < this.gracePeriodMs) {
        const before = entry.speaker
        entry.speaker = event.speaker
        if (!before || before.id !== event.speaker.id) {
          logger.debug(`SpeakerTracker: grace-period correction of segment ${segmentId} ${before ? before.id : 'null'} -> ${event.speaker.id}`)
          this._recordEvent(segmentId, 'correct', event.speaker)
        }
      }
    }
  }

  assignSpeakerToSegment (segmentId) {
    if (segmentId == null || this.segmentSpeakers.has(segmentId)) return
    const speaker = this._presentSpeaker(this.currentSpeaker || this.lastKnownSpeaker)
    this.segmentSpeakers.set(segmentId, {
      speaker,
      assignedAt: this._now()
    })
    logger.debug(`SpeakerTracker: assigned segment ${segmentId} -> ${speaker ? speaker.id : 'null'}`)
    this._recordEvent(segmentId, 'assign', speaker)
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
    this._events = []
  }

  _now () {
    return Date.now()
  }
}

module.exports = SpeakerTracker
