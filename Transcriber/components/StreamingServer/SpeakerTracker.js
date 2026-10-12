const { logger } = require('live-srt-lib')

const DEFAULT_GRACE_PERIOD_MS = 200
// After a `reason: 'unattributed'` null, how long the bot's `reason: 'mapped'`
// change naming the participant the track got mapped to can still name the
// time heard from the speaker the bot could not name. The bot sends it as soon
// as the track is mapped, ~250 ms on an SFU: 1.5 s covers that delay several
// times over, event and network jitter included.
const DEFAULT_UNATTRIBUTED_WINDOW_MS = 1500
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
 *     new speaker (ASR partial vs bot event race);
 *   - a `{ speaker: null, reason: 'unattributed' }` change means someone the bot
 *     cannot name yet is speaking (SFU track not mapped to a participant yet).
 *     Their speaking time is credited to that unnamed speaker, never to the
 *     previous one, and a segment's label shows nobody while they speak. Only
 *     the bot's `{ speaker, reason: 'mapped' }` change, naming the participant
 *     that unattributed track was just mapped to, names that time, within the
 *     unattributed window, and only for its own episode (the latest null).
 *     Otherwise it stays unnamed (unknown beats wrong): unnamed time that wins
 *     a segment's majority leaves it without speaker. A null without reason is
 *     silence.
 */
class SpeakerTracker {
  constructor (options = {}) {
    this.participants = new Map() // id -> { id, name }
    this.departed = new Set() // ids of participants that have left
    this.currentSpeaker = null
    this.lastKnownSpeaker = null
    // segmentId -> { speaker, assignedAt, final, durations, openSpeaker,
    //                openSince, unattributed, startedUnattributed, finalUnnamed }
    //   durations: Map<key, { speaker, ms } | { unnamed, ms }> in first-spoken
    //     order; `key` is a participant id, or the key of an unnamed speaker
    //     (see _unnamed), whose entry in `unattributed` says whether, and by
    //     whom, it got named;
    //   unattributed: Map<key, { episode, pendingUntil, speaker }>, the
    //     unnamed speakers heard in the segment;
    //   openSpeaker: the participant or the unnamed speaker holding the floor
    //     (null during silence), since openSince;
    //   finalUnnamed: the unnamed speaker a final was frozen on, so its later
    //     naming still names the segment.
    this.segmentSpeakers = new Map()
    this.gracePeriodMs = options.gracePeriodMs != null ? options.gracePeriodMs : DEFAULT_GRACE_PERIOD_MS
    this.unattributedWindowMs = options.unattributedWindowMs != null ? options.unattributedWindowMs : DEFAULT_UNATTRIBUTED_WINDOW_MS
    // Time of the 'unattributed' null the current state comes from, null when
    // the current state is a speaker or silence. Each null opens a new
    // episode: a 'mapped' change names the latest episode's time only.
    this.unattributedSince = null
    this.unattributedEpisode = 0
    // Bounded ring of recent diarization events for offline debugging of locutor
    // accuracy. Not on any hot path (one push per assignment/correction/final).
    this.eventRingSize = options.eventRingSize != null ? options.eventRingSize : DEFAULT_EVENT_RING_SIZE
    this._events = [] // { position, action, speaker } — FIFO, capped at eventRingSize
  }

  // Record a diarization event into the bounded debug ring. `position` is the
  // segmentId or speaker-change position, `action` a short tag, `speaker` the
  // id/name pair (or null for silence or an unnamed speaker).
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
    if (speaker.unnamed) return null
    if (this.departed.has(speaker.id) && !this.participants.has(speaker.id)) return null
    return speaker
  }

  // The speaker the bot cannot name yet, when one is speaking: the latest
  // episode's.
  _unnamed () {
    if (this.unattributedSince === null) return null
    const episode = this.unattributedEpisode
    return { unnamed: true, episode, key: `episode:${episode}` }
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
        if (!entry.final && entry.openSpeaker && !entry.openSpeaker.unnamed && entry.openSpeaker.id === id) {
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
      const key = speaker.unnamed ? speaker.key : speaker.id
      const slot = entry.durations.get(key)
      if (slot) {
        slot.ms += elapsed
        if (!speaker.unnamed) slot.speaker = speaker
      } else {
        entry.durations.set(key, speaker.unnamed ? { unnamed: speaker.key, ms: elapsed } : { speaker, ms: elapsed })
      }
    }
    entry.openSince = now
  }

  // The unnamed speaker takes the floor in an open segment: its time can be
  // named until the window of its unattributed null ends.
  _openUnnamed (entry, unnamed) {
    if (!entry.unattributed.has(unnamed.key)) {
      const pendingUntil = this.unattributedSince + this.unattributedWindowMs
      entry.unattributed.set(unnamed.key, {
        episode: unnamed.episode,
        pendingUntil: this._now() <= pendingUntil ? pendingUntil : null,
        speaker: null
      })
    }
    entry.openSpeaker = unnamed
    entry.speaker = null
    return entry.unattributed.get(unnamed.key)
  }

  // Re-attribute an open segment from its very start to `speaker` (a
  // participant or an unnamed speaker): the grace-period correction of the
  // ASR partial vs bot event race.
  _reattribute (segmentId, entry, speaker) {
    const before = entry.speaker
    entry.durations.clear()
    entry.unattributed.clear()
    entry.openSince = entry.assignedAt
    if (speaker.unnamed) {
      entry.startedUnattributed = true
      this._openUnnamed(entry, speaker)
      logger.debug(`SpeakerTracker: segment ${segmentId} unattributed`)
      this._recordEvent(segmentId, 'pending', null)
      return
    }
    entry.openSpeaker = speaker
    entry.speaker = speaker
    if (!before || before.id !== speaker.id) {
      logger.debug(`SpeakerTracker: grace-period correction of segment ${segmentId} ${before ? before.id : 'null'} -> ${speaker.id}`)
      this._recordEvent(segmentId, 'correct', speaker)
    }
  }

  addSpeakerChange (event) {
    const now = this._now()
    if (!event.speaker) {
      this.currentSpeaker = null
      if (event.reason === 'unattributed') {
        this._setUnattributed(event, now)
        return
      }
      // Silence: the clock stops, the open segments keep their label.
      this.unattributedSince = null
      for (const entry of this.segmentSpeakers.values()) {
        if (entry.final) continue
        this._accrue(entry, now)
        entry.openSpeaker = null
      }
      return
    }
    // The unnamed speaker's time is named only by the 'mapped' change of its
    // episode (the latest), within the window. Any other speaker (e.g. a
    // participant answering the newcomer, another newcomer) never names it,
    // nor does a grace-period correction.
    if (event.reason === 'mapped') {
      const episode = this.unattributedEpisode
      this._resolvePending(event, (slot) => slot.episode === episode)
    }
    this.currentSpeaker = event.speaker
    this.unattributedSince = null
    this.lastKnownSpeaker = event.speaker
    const present = this._presentSpeaker(event.speaker)
    for (const [segmentId, entry] of this.segmentSpeakers) {
      if (entry.final) continue
      // Grace window: the segment was opened a few ms before this event, so it
      // belongs to the new speaker from its very start. Never for a segment
      // that started unattributed: its words are the unnamed speaker's.
      if (!entry.startedUnattributed && now - entry.assignedAt < this.gracePeriodMs) {
        this._reattribute(segmentId, entry, event.speaker)
        continue
      }
      // Past the grace window: split the segment. Time so far goes to the
      // previous speaker; the live label (carried by the next partial) follows
      // the new one.
      this._accrue(entry, now)
      entry.openSpeaker = present
      if (present) entry.speaker = present
    }
  }

  // Someone the bot cannot name yet is speaking.
  _setUnattributed (event, now) {
    this.unattributedEpisode += 1
    this.unattributedSince = now
    this._recordEvent(event.position, 'unattributed', null)
    const unnamed = this._unnamed()
    for (const [segmentId, entry] of this.segmentSpeakers) {
      if (entry.final) continue
      // Same race as the grace-period correction: a segment assigned a few ms
      // before this event most likely holds the unnamed speaker's first words,
      // not the previous speaker's.
      if (!entry.startedUnattributed && now - entry.assignedAt < this.gracePeriodMs) {
        this._reattribute(segmentId, entry, unnamed)
        continue
      }
      this._accrue(entry, now)
      this._openUnnamed(entry, unnamed)
    }
  }

  // Names the unnamed time `matches` selects in every segment (still within
  // its window) with the mapped participant. A final frozen on that unnamed
  // speaker is named too.
  _resolvePending (event, matches) {
    const now = this._now()
    for (const [segmentId, entry] of this.segmentSpeakers) {
      for (const [key, slot] of entry.unattributed) {
        if (slot.speaker || slot.pendingUntil === null) continue
        if (now > slot.pendingUntil) {
          slot.pendingUntil = null
          continue
        }
        if (!matches(slot)) continue
        slot.speaker = event.speaker
        slot.pendingUntil = null
        if (entry.final && entry.finalUnnamed === key) {
          entry.speaker = event.speaker
          entry.finalUnnamed = null
        }
        logger.debug(`SpeakerTracker: unattributed speech of segment ${segmentId} -> ${event.speaker.id}`)
        this._recordEvent(segmentId, 'resolve', event.speaker)
      }
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
      if (this.unattributedSince !== null) {
        // Someone the bot cannot name yet is speaking: nobody, never the
        // previous speaker.
        existing.speaker = null
      } else {
        // Silence keeps the label of whoever spoke last in the segment.
        const live = this._presentSpeaker(this.currentSpeaker)
        if (live) existing.speaker = live
      }
      return
    }
    const entry = {
      speaker: null,
      assignedAt: now,
      final: false,
      durations: new Map(),
      unattributed: new Map(),
      openSpeaker: null,
      openSince: now,
      startedUnattributed: false,
      finalUnnamed: null
    }
    this.segmentSpeakers.set(segmentId, entry)
    const unnamed = this._unnamed()
    if (unnamed) {
      // Someone the bot cannot name yet is speaking: no lastKnownSpeaker fallback.
      entry.startedUnattributed = true
      this._openUnnamed(entry, unnamed)
      logger.debug(`SpeakerTracker: segment ${segmentId} unattributed`)
      this._recordEvent(segmentId, 'pending', null)
      return
    }
    // Only an ACTUAL current speaker accrues time; a lastKnownSpeaker fallback
    // (silence) labels the segment but earns no speaking time.
    entry.speaker = this._presentSpeaker(this.currentSpeaker || this.lastKnownSpeaker)
    entry.openSpeaker = this._presentSpeaker(this.currentSpeaker)
    logger.debug(`SpeakerTracker: assigned segment ${segmentId} -> ${entry.speaker ? entry.speaker.id : 'null'}`)
    this._recordEvent(segmentId, 'assign', entry.speaker)
  }

  // Close a segment on its ASR final: freeze the label on the speaker with the
  // most accumulated speaking time during the segment (ties: first to have
  // spoken). Unnamed time counts for the speaker who named it, and for nobody
  // otherwise: unnamed time that wins leaves the segment without speaker,
  // until it gets named, if still within its window. A segment with no
  // accumulated time (final without any partial, or pure fallback) keeps its
  // live label. Opens the segment first if needed.
  finalizeSegment (segmentId) {
    if (segmentId == null) return
    if (!this.segmentSpeakers.has(segmentId)) this.assignSpeakerToSegment(segmentId)
    const entry = this.segmentSpeakers.get(segmentId)
    if (entry.final) return
    this._accrue(entry, this._now())
    const totals = new Map() // participant id or unnamed key -> { speaker, unnamed, ms }
    for (const [key, slot] of entry.durations) {
      let speaker = slot.speaker || null
      let unnamed = null
      if (slot.unnamed) {
        speaker = entry.unattributed.get(slot.unnamed).speaker
        if (!speaker) unnamed = slot.unnamed
      }
      if (speaker && !this._presentSpeaker(speaker)) continue
      const totalKey = speaker ? speaker.id : key
      const total = totals.get(totalKey)
      if (total) total.ms += slot.ms
      else totals.set(totalKey, { speaker, unnamed, ms: slot.ms })
    }
    let best = null
    for (const total of totals.values()) {
      if (!best || total.ms > best.ms) best = total
    }
    if (best) {
      entry.speaker = best.speaker
      entry.finalUnnamed = best.unnamed
    }
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
    this.unattributedSince = null
    this.unattributedEpisode = 0
    this._events = []
  }

  _now () {
    return Date.now()
  }
}

module.exports = SpeakerTracker
