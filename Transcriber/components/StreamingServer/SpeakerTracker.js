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
 *   - `assignSpeakerToSegment` opens a segment the first time its segmentId is
 *     seen (first partial) and, while the segment is still OPEN (partial), every
 *     later call refreshes it: the segment's label follows the current speaker,
 *     so each partial carries who is speaking now;
 *   - while a segment is open, the tracker accumulates speaking time per
 *     participant (speaker-change events split the segment into intervals);
 *   - `finalizeSegment` closes it on the ASR final and freezes the label on the
 *     participant who spoke the longest during the segment (majority);
 *   - a short grace period lets a speakerChanged that arrives just after the
 *     segment's first partial re-attribute the segment from its start to the
 *     new speaker (ASR partial vs bot event race).
 */
class SpeakerTracker {
  constructor (options = {}) {
    this.participants = new Map() // id -> { id, name }
    this.departed = new Set() // ids of participants that have left
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
    // segmentId -> { speaker, assignedAt, final, durations: Map<id, {speaker, ms}>,
    //                openSpeaker, openSince }
    this.segmentSpeakers = new Map()
    this.gracePeriodMs = options.gracePeriodMs != null ? options.gracePeriodMs : DEFAULT_GRACE_PERIOD_MS
    // Bounded ring of recent diarization events for offline debugging of locutor
    // accuracy. Not on any hot path (one push per assignment/correction/final).
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
      const now = this._now()
      for (const entry of this.segmentSpeakers.values()) {
        if (!entry.final && entry.openSpeaker && entry.openSpeaker.id === id) {
          this._accrue(entry, now)
          entry.openSpeaker = null
        }
      }
      if (this.currentSpeaker && this.currentSpeaker.id === id) this.currentSpeaker = null
      if (this.lastKnownSpeaker && this.lastKnownSpeaker.id === id) this.lastKnownSpeaker = null
      logger.debug(`SpeakerTracker: participant left ${id}`)
    }
  }

  // Close the running interval of an open segment at `now`, crediting the
  // elapsed time to the speaker who held the floor (nobody during silence).
  _accrue (entry, now) {
    if (entry.final) return
    const speaker = entry.openSpeaker
    const elapsed = now - entry.openSince
    if (speaker && elapsed > 0) {
      const slot = entry.durations.get(speaker.id)
      if (slot) {
        slot.ms += elapsed
        slot.speaker = speaker
      } else {
        entry.durations.set(speaker.id, { speaker, ms: elapsed })
      }
    }
    entry.openSince = now
  }

  addSpeakerChange (event) {
    this.currentSpeaker = event.speaker || null
    if (event.speaker) this.lastKnownSpeaker = event.speaker
    const now = this._now()
    for (const [segmentId, entry] of this.segmentSpeakers) {
      if (entry.final) continue
      if (event.speaker && now - entry.assignedAt < this.gracePeriodMs) {
        // Grace window: the segment was opened a few ms before this event, so
        // it belongs to the new speaker from its very start.
        const before = entry.speaker
        entry.durations.clear()
        entry.openSpeaker = event.speaker
        entry.openSince = entry.assignedAt
        entry.speaker = event.speaker
        if (!before || before.id !== event.speaker.id) {
          logger.debug(`SpeakerTracker: grace-period correction of segment ${segmentId} ${before ? before.id : 'null'} -> ${event.speaker.id}`)
          this._recordEvent(segmentId, 'correct', event.speaker)
        }
        continue
      }
      // Past the grace window: split the segment. Time so far goes to the
      // previous speaker; the live label (carried by the next partial) follows
      // the new one. Silence (null) stops the clock but keeps the label.
      this._accrue(entry, now)
      entry.openSpeaker = this._presentSpeaker(event.speaker || null)
      if (entry.openSpeaker) entry.speaker = entry.openSpeaker
    }
  }

  // Called for every PRIMARY result (partial or final) of a segment. Opens the
  // segment on first sight; on later calls, while the segment is still open,
  // refreshes its live label with the current speaker. No-op once finalized.
  assignSpeakerToSegment (segmentId) {
    if (segmentId == null) return
    const now = this._now()
    const existing = this.segmentSpeakers.get(segmentId)
    if (existing) {
      if (existing.final) return
      const live = this._presentSpeaker(this.currentSpeaker || this.lastKnownSpeaker)
      if (live) existing.speaker = live
      return
    }
    const speaker = this._presentSpeaker(this.currentSpeaker || this.lastKnownSpeaker)
    this.segmentSpeakers.set(segmentId, {
      speaker,
      assignedAt: now,
      final: false,
      durations: new Map(),
      // Only an ACTUAL current speaker accrues time; a lastKnownSpeaker
      // fallback (silence) labels the segment but earns no speaking time.
      openSpeaker: this._presentSpeaker(this.currentSpeaker),
      openSince: now
    })
    logger.debug(`SpeakerTracker: assigned segment ${segmentId} -> ${speaker ? speaker.id : 'null'}`)
    this._recordEvent(segmentId, 'assign', speaker)
  }

  // Close a segment on its ASR final: freeze the label on the participant with
  // the most accumulated speaking time during the segment (ties: first to have
  // spoken). A segment with no accumulated time (final without any partial, or
  // pure fallback) keeps its live label. Opens the segment first if needed.
  finalizeSegment (segmentId) {
    if (segmentId == null) return
    if (!this.segmentSpeakers.has(segmentId)) this.assignSpeakerToSegment(segmentId)
    const entry = this.segmentSpeakers.get(segmentId)
    if (entry.final) return
    this._accrue(entry, this._now())
    let best = null
    for (const slot of entry.durations.values()) {
      if (!this._presentSpeaker(slot.speaker)) continue
      if (!best || slot.ms > best.ms) best = slot
    }
    if (best) entry.speaker = best.speaker
    entry.final = true
    entry.openSpeaker = null
    logger.debug(`SpeakerTracker: finalized segment ${segmentId} -> ${entry.speaker ? entry.speaker.id : 'null'}`)
    this._recordEvent(segmentId, 'final', entry.speaker)
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
