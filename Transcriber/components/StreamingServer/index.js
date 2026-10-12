const { Component } = require("live-srt-lib");
const logger = require('../../logger')
const ASR = require('../../ASR');
const MultiplexedSRTServer = require('./srt/SRTServer.js');
const MultiplexedWebsocketServer = require('./websocket/WebsocketServer.js');
const MultiplexedRTMPServer = require('./rtmp/RTMPServer.js');


const SERVER_MAPPING = {
  "SRT": MultiplexedSRTServer,
  "WS": MultiplexedWebsocketServer,
  "RTMP": MultiplexedRTMPServer,
}

// Per-stream overflow: tags beyond the per-channel ASR cap collapse onto this
// single shared "mixed" sub-ASR. 255 is reserved by the tagged-frame protocol
// (see WebsocketServer._parseTaggedFrame) and is never a real participant tag.
const OVERFLOW_TAG = 255;

// K2: key suffix of the single per-channel RECORDER ASR (per-stream channels
// that keep their audio). Deliberately NON-NUMERIC so it can never collide with
// a participant key `${ck}#${tag}` whatever the tag.
const RECORDER_SUFFIX = '#rec';

class StreamingServer extends Component {
  static states = {
    INITIALIZED: 'initialized',
    READY: 'ready',
    ERROR: 'errored',
    STREAMING: 'streaming',
    CLOSED: 'closed'
  };

  constructor(app) {
    super(app);
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.state = StreamingServer.states.CLOSED;
    this.ASRs = new Map();
    this.lastSegmentIds = new Map();
    // Channels whose legacy stream is being stopped on this instance, mapped to
    // a promise that settles once that stream's segment cursor is final (see
    // _stopAsr and initialSegmentIdFor).
    this.stoppingStreams = new Map();
    // Latest stream started on each channel, running or being stopped: its
    // legacy ASR, or its per-stream channel context. Only its stop reports the
    // channel inactive (see _stopAsr).
    this.latestStreams = new Map();
    this.servers = [];
    this.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
    // Per-stream diarization (one ASR per participant). All keyed by the channel
    // key `${sessionId}_${channelId}` (ck); the sub-ASR live in `this.ASRs`
    // under `${ck}#${tag}` (the '#' guarantees no startsWith collision with the
    // legacy `${ck}` key, e.g. "s_10".startsWith("s_1#") === false). Per-stream
    // channels are exactly those whose context carries an `allocator` (the shared
    // per-channel segmentId source for the channel's sub-ASR).
    this.channels = new Map();           // ck -> { session, channel, allocator? } for lazy ASR creation
    // C9: in-flight participant teardowns (a `leave` flush), ck -> Set<Promise>.
    // A channel stop waits for them so the end-of-stream marker stays the
    // provably-LAST final of the channel.
    this.pendingLeaves = new Map();
    // K9: orphan-channel reaper, twin of WebsocketServer's tracker reaper (same
    // interval convention). It is armed LAZILY by the first per-stream channel
    // and disarmed by its own sweep once nothing is left to reap, so a process
    // that has gone quiet (or never went per-stream) carries no interval at all.
    // Held here so that sweep — and the tests — can clear it.
    this.channelReaperInterval = null;
    this.channelReaperIntervalMs = 60000;
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  // Resolve the per-channel ASR cap from env. parseInt of a non-numeric value
  // returns NaN, and `subCount >= NaN` is ALWAYS false, so the cap would never
  // engage -> unbounded ASR per speaker -> instance OOM. Guard NaN and any
  // non-positive value by defaulting to 6.
  static _resolveCap(envVal) {
    const n = parseInt(envVal, 10);
    return Number.isInteger(n) && n > 0 ? n : 6;
  }

  // Launch servers defined in prcess.env STREAMING_PROTOCOLS
  //@TODO: reimplemented SRT. Still need to reimplement other protocols
  async initialize() {
    const protocols = process.env.STREAMING_PROTOCOLS.split(',').map(protocol => protocol.trim());
    for (const protocol of protocols) {
      await this.initServer(protocol);
    }
    // K9: the reaper is armed LAZILY, by the first per-stream channel (see
    // session-start). `this.channels` only ever holds per-stream contexts, so an
    // SRT/RTMP-only or non-per-stream deployment would otherwise carry a 60 s
    // interval iterating an always-empty Map — a new unconditional side effect
    // on the legacy startup path for no benefit.
  }

  async initServer(protocol) {
    try {
      const serverClass = SERVER_MAPPING[protocol]
      const server = new serverClass(this.app);
      this.servers.push(server);

      server.on('session-start', (session, channel) => {
        try {
          // Per-stream: a bot announced perStream at init and the env flag is on,
          // so the WS server holds a participant map for this channel. We do NOT
          // create an ASR here — sub-ASR are created lazily on the first tagged
          // frame of each participant. We only mark the channel, remember
          // {session,channel} for lazy creation, and seed the shared per-channel
          // segmentId allocator. The active status (1 per channel) is unchanged.
          const isPerStream = typeof server.getStreamParticipants === 'function'
            && server.getStreamParticipants(session.id, channel.id) != null;
          if (isPerStream) {
            const ck = `${session.id}_${channel.id}`;
            // K1 (segment-id continuity across a connection replacement): a
            // reconnect's session-start lands INSIDE the outgoing stop's flush
            // window — cleanupWebsocket emits 'session-stop' synchronously from
            // the new connection's handler. At that instant the outgoing
            // channel's allocator is still LIVE (its sub-ASR draw the ids of
            // their trailing finals from it) and `lastSegmentIds` has not been
            // written yet — it is only written after the flushes, and then only
            // if the context is still ours. resolveInitialSegmentId would
            // therefore hand the successor the OUTGOING connection's starting
            // id, and both connections would publish the same segment ids. Reuse
            // the predecessor's allocator OBJECT instead: one shared monotonic
            // source for the trailing finals and for the successor's sub-ASR,
            // whatever order they draw in.
            const previous = this.channels.get(ck);
            const allocator = (previous && previous.allocator)
              ? previous.allocator
              : { next: this.resolveInitialSegmentId(session.id, channel.id, channel) };
            // K9: `registeredAt` is the reaper's grace anchor — a channel marked
            // here but not yet streaming a single tagged frame must never be
            // collected as an orphan.
            const ctx = { session, channel, allocator, registeredAt: Date.now() };
            this.channels.set(ck, ctx);
            this.latestStreams.set(ck, ctx);
            // K9: arm the orphan-channel reaper on the first per-stream channel
            // (idempotent), so a deployment that never goes per-stream never
            // arms it at all.
            this.startChannelReaper();
            // K2: the channel archive is owned by ONE dedicated recorder ASR fed
            // with the bot's mixed flow, never by the N participant sub-ASR
            // (which all resolve to the same .pcm path and would interleave
            // their writes and race on transcode/unlink). The handshake only
            // grants per-stream on a keepAudio channel when the bot ships that
            // mixed flow, so this ASR always has a source.
            if (channel.keepAudio) {
              this._createRecorderAsr(session, channel, ck);
            }
            this.emit('session-start', session, channel);
            logger.info(`Session ${session.id}, channel ${channel.id} started (per-stream diarization, lazy ASR${channel.keepAudio ? ', mixed recorder' : ''})`);
            return;
          }
          // K1: a LEGACY successor can land inside a per-stream stop's flush
          // window — a keepAudio bot DEMOTED by the mixedRecording gate, the
          // native->web re-route, or any plain WS client. The outgoing shared
          // allocator is still LIVE (the trailing finals draw their ids from it)
          // and sits far above `channel.lastSegmentId` from the retained
          // broadcast, which is only republished on activate/deactivate; seeding
          // from that stale value re-uses ids whose captions are already stored.
          // A legacy ASR owns an integer counter and cannot share the allocator
          // OBJECT the per-stream branch reuses, so snapshot its cursor instead.
          // Residual: the predecessor's trailing finals keep drawing from the
          // allocator after this snapshot, so a handful of ids can still overlap
          // — closing that fully would mean giving the legacy ASR the shared
          // allocator, which is out of scope here.
          const liveCtx = this.channels.get(`${session.id}_${channel.id}`);
          const initialSegmentId = (liveCtx && liveCtx.allocator)
            ? liveCtx.allocator.next
            : this.initialSegmentIdFor(session, channel);
          // Native diarization: bot WS streams register a SpeakerTracker on the
          // WS server at init. Non-bot sources (SRT/RTMP/non-native WS) have none.
          const speakerTracker = typeof server.getSpeakerTracker === 'function'
            ? server.getSpeakerTracker(session.id, channel.id)
            : null;
          const diarizationMode = speakerTracker ? 'native' : 'asr';
          const asr = this._wireAsr(session, channel, { initialSegmentId, speakerTracker, diarizationMode },
            `${session.id}_${channel.id}`, session.id, channel.id);
          this.latestStreams.set(`${session.id}_${channel.id}`, asr);
          this.emit('session-start', session, channel);
          logger.info(`Session ${session.id}, channel ${channel.id} started`);
        } catch (error) {
          logger.error(`Error starting session ${session.id}, channel ${channel.id}: ${error}`);
        }
      });

      server.on('session-stop', async (session, channelId) => {
        try {
          logger.info(`Session ${session.id}, channel ${channelId} stopped`);
          await this._stopAsr(session, channelId);
        } catch (error) {
          logger.error(`Error stopping session ${session.id}, channel ${channelId}: ${error}`);
        }
      });

      server.on('data', (audio, sessionId, channelId, tag, meetingTimeMs) => {
        try {
          const buffer = Buffer.from(audio);
          if (tag === undefined) {
            // Legacy: single mixed ASR per channel. Unchanged.
            const asr = this.ASRs.get(`${sessionId}_${channelId}`);
            if (asr) {
              asr.transcribe(buffer);
            } else {
              logger.warn(`No ASR found for session ${sessionId}, channel ${channelId}`);
            }
            return;
          }
          // Per-stream: route the tagged frame to its participant's ASR,
          // lazily creating it on the first frame of each tag. `meetingTimeMs`
          // (C2) feeds the sub-ASR's audio-clock -> meeting-clock map; it is
          // undefined for every legacy emit, which keeps the map unbuilt.
          const asr = this._getOrCreatePerStreamAsr(server, sessionId, channelId, tag);
          if (asr) asr.transcribe(buffer, meetingTimeMs);
        } catch (error) {
          logger.error(`Error processing data for session ${sessionId}, channel ${channelId}: ${error}`);
        }
      });

      // K2: the bot's MIXED flow, emitted only in per-stream mode (magic 0x02).
      // It never goes through the tag/cap/lazy-create logic — it is written
      // verbatim to the channel's single recorder ASR, whose only job is the
      // archive (recordOnly => FakeTranscriber => no ASR cost).
      server.on('record-data', (audio, sessionId, channelId) => {
        try {
          const recorder = this.ASRs.get(`${sessionId}_${channelId}${RECORDER_SUFFIX}`);
          if (!recorder) {
            // Warn once per channel: this fires at frame rate otherwise.
            const ck = `${sessionId}_${channelId}`;
            const warned = (this._noRecorderWarned ||= new Set());
            if (!warned.has(ck)) {
              warned.add(ck);
              logger.warn(`Received mixed recording audio for ${ck} but no recorder ASR exists (channel not keepAudio, or already stopped); dropping`);
            }
            return;
          }
          recorder.transcribe(Buffer.from(audio));
        } catch (error) {
          logger.error(`Error processing recording data for session ${sessionId}, channel ${channelId}: ${error}`);
        }
      });

      // Per-stream: a participant left the meeting. Tear down their sub-ASR and
      // FREE the cap slot (a dead `${ck}#${tag}` would otherwise keep counting
      // toward the cap and wrongly push present speakers into overflow). No
      // end-of-stream marker here — that belongs to channel stop only (#9).
      server.on('participant-leave', (sessionId, channelId, tag) => {
        this._disposePerStreamParticipant(sessionId, channelId, tag)
          .catch(error => logger.error(`Error disposing per-stream ASR on leave (${sessionId}_${channelId}#${tag}): ${error}`));
      });

      // Per-stream: a participant's identity changed for a tag — a mid-call
      // rename, or (K6) a `join` that arrives AFTER a tagged frame already
      // lazily created the sub-ASR with an empty participant. Re-key the live
      // sub-ASR (name AND id) so subsequent captions carry it (the WS server
      // already updated its participant map).
      server.on('participant-rename', (sessionId, channelId, tag, name, id) => {
        this._renamePerStreamParticipant(sessionId, channelId, tag, name, id);
      });
    } catch (error) {
      logger.error(`Error initializing ${protocol} server: ${error}`);
    }
  }

  // Lazily get-or-create the per-stream ASR for (session, channel, tag).
  // - Cost cap: at most MAX_CONCURRENT_ASR_PER_CHANNEL (default 6) distinct
  //   per-stream ASR per channel. Beyond the cap, excess tags collapse onto a
  //   single shared overflow ASR keyed `#255` (mixed fallback). An already-known
  //   tag is never re-capped.
  // - Key: `${ck}#${tag}`. The shared per-channel allocator gives monotonic,
  //   collision-free segmentIds across all the channel's sub-ASR.
  // Returns the ASR, or null if the channel context is unknown (defensive).
  _getOrCreatePerStreamAsr(server, sessionId, channelId, tag) {
    const ck = `${sessionId}_${channelId}`;
    const existing = this.ASRs.get(`${ck}#${tag}`);
    if (existing) return existing;

    const ctx = this.channels.get(ck);
    if (!ctx) {
      logger.warn(`Per-stream: no channel context for ${ck}, dropping frame (tag ${tag})`);
      return null;
    }
    // C4: the channel is tearing down (_stopAsr already snapshotted the sub-ASR
    // to flush and dispose). A sub-ASR created now would be invisible to that
    // snapshot: never flushed, never disposed — a leaked provider socket still
    // publishing captions AFTER the channel's end-of-stream marker. Refuse, and
    // warn once per teardown (this path runs at frame rate).
    if (ctx.stopping) {
      if (!ctx.stoppingWarned) {
        ctx.stoppingWarned = true;
        logger.warn(`Per-stream: ${ck} is stopping, dropping frames for tags with no live ASR (tag ${tag})`);
      }
      return null;
    }
    // Fast path for capped tags: a tag once collapsed onto the shared overflow
    // ASR stays there, so route it in O(1) instead of re-scanning every frame
    // (the scan below is the hot-path cost that only bites in large meetings).
    if (ctx.overflowTags && ctx.overflowTags.has(tag)) {
      return this.ASRs.get(`${ck}#${OVERFLOW_TAG}`) || null;
    }

    // Apply the per-channel cap: count this channel's existing DEDICATED sub-ASR.
    // Two keys are excluded because neither is a cap slot:
    //   - the recorder (`${ck}#rec`), which transcribes nothing (K2);
    //   - the shared overflow ASR (`${ck}#255`), which is the *destination* of
    //     the cap, not one of its slots. Counting it shrank the channel to
    //     cap-1 dedicated ASR for the rest of the call as soon as one overflow
    //     happened (a freed slot could then never be re-filled).
    const cap = this.maxAsrPerChannel;
    const overflowKey = `${ck}#${OVERFLOW_TAG}`;
    const subCount = [...this.ASRs.keys()]
      .filter(k => k.startsWith(`${ck}#`) && !k.endsWith(RECORDER_SUFFIX) && k !== overflowKey).length;
    let effTag = tag;
    if (subCount >= cap && tag !== OVERFLOW_TAG) {
      effTag = OVERFLOW_TAG; // collapse onto the shared overflow ASR
      const overflow = this.ASRs.get(`${ck}#${OVERFLOW_TAG}`);
      if (overflow) {
        (ctx.overflowTags ||= new Set()).add(tag); // memoize → O(1) next frame
        return overflow;
      }
      // First overflow tag: remember it so subsequent frames skip the scan too.
      (ctx.overflowTags ||= new Set()).add(tag);
    }
    const { session, channel } = ctx;
    // Only reached for tagged frames, which only happen after session-start
    // already proved getStreamParticipants exists (and ctx is non-null above).
    const participants = server.getStreamParticipants(sessionId, channelId);
    const p = (participants && participants.get(effTag)) || {};
    // The shared overflow bucket is an ACCEPTED degraded mode: exact per-speaker
    // separation beyond the cap is intentionally NOT provided (no slot-recycling
    // pool). Give it a stable, deterministic label so overflow captions are
    // always attributed consistently and never blank/garbled (#6).
    const isOverflow = effTag === OVERFLOW_TAG;
    const participantId = isOverflow ? 'overflow' : (p.id || null);
    const participantName = isOverflow
      ? (process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME || 'Participants')
      : (p.name || null);
    const asr = this._wireAsr(session, channel, {
      segmentAllocator: ctx.allocator,
      participantId,
      participantName,
      // K2: a participant sub-ASR NEVER writes the channel archive (see the
      // recorder ASR). Without this, N sub-ASR would open the same .pcm.
      record: false,
      // C2 routing rule: the overflow bucket is fed by EVERY capped participant
      // at once, so the meetingTimeMs of its frames interleaves and goes
      // backwards constantly. It must never build an audio->meeting map: the map
      // would be disabled on its second frame anyway, after logging a "bot
      // restart or u32 wrap" WARN that diagnoses a bot bug where the real cause
      // is this multiplexing. Identity timestamps for the shared bucket are part
      // of the accepted degraded mode; the WARN stays meaningful on a DEDICATED
      // sub-ASR, where a backwards clock really does mean a bot restart.
      sharedStream: isOverflow,
    }, `${ck}#${effTag}`, sessionId, channelId);
    // #8: a participant speaking for the first time DURING a pause must not leak
    // captions — pause the freshly-created ASR immediately (same mechanism as
    // _applyToSessionASRs). resumeSession re-enables it via the same path.
    if (ctx.paused) {
      asr.pause().catch(e => logger.error(`Error pausing lazily-created ASR ${ck}#${effTag}: ${e.message}`));
    }
    logger.info(`Lazy-created per-stream ASR ${ck}#${effTag} (participant=${participantId || 'overflow'}/${participantName || ''})`);
    return asr;
  }

  // K2: build the single per-channel recorder ASR. It owns the channel's .pcm
  // (record: true) and transcribes nothing (recordOnly -> FakeTranscriber), so
  // it is DELIBERATELY given no segmentAllocator and no initialSegmentId: it
  // emits no segment-bearing result and must not burn ids the sub-ASR share.
  // Its partial/final are not wired either — the channel's captions come from
  // the participant sub-ASR only.
  _createRecorderAsr(session, channel, ck) {
    const asr = new ASR(session, channel, { recordOnly: true, record: true });
    // No partial/final wiring (it produces no caption), but its 'error' — the
    // archive transcode is exactly what fails in production — must be logged.
    this._wireAsrErrors(asr, `${ck}${RECORDER_SUFFIX}`);
    this.ASRs.set(`${ck}${RECORDER_SUFFIX}`, asr);
    logger.info(`Created mixed-recording ASR ${ck}${RECORDER_SUFFIX} (archive owner, no transcription)`);
    return asr;
  }

  // Per-stream: tear down ONE participant's sub-ASR (on a `leave`) and free its
  // cap slot. Flush in-flight finals with listeners still attached so trailing
  // captions are published, then dispose WITHOUT emitting the channel end-of-
  // stream marker (that is reserved for channel stop, #9). After the map delete
  // the freed tag no longer counts toward the cap. No-op if no such ASR exists.
  async _disposePerStreamParticipant(sessionId, channelId, tag) {
    const ck = `${sessionId}_${channelId}`;
    const key = `${ck}#${tag}`;
    // K2: the recorder is not a participant. A bogus/hostile control message
    // carrying tag='rec' must never tear the channel's archive down mid-call.
    if (key.endsWith(RECORDER_SUFFIX)) {
      logger.warn(`Ignoring participant-leave for the reserved recorder key ${key}`);
      return false;
    }
    // K8: 255 is the SHARED overflow bucket, never a real participant. A leave
    // carrying it (a bot bug, or a hostile control frame) would flush and
    // dispose the ASR every capped participant is still speaking into — the
    // next frame silently recreates it, losing the in-flight audio buffer.
    if (key === `${ck}#${OVERFLOW_TAG}`) {
      logger.warn(`Ignoring participant-leave for the reserved overflow key ${key} (shared by every capped participant)`);
      return false;
    }
    // A tag can be recycled by the bot to a later joiner, so forget any overflow
    // routing memoized for it (else the new participant would be pinned to
    // overflow even with free slots).
    this.channels.get(ck)?.overflowTags?.delete(tag);
    const asr = this.ASRs.get(key);
    if (!asr) return false;
    this.ASRs.delete(key);
    // C9: the flush below publishes this participant's trailing finals. A
    // concurrent channel stop must not slip its end-of-stream marker in between,
    // so the teardown is registered as in-flight for the channel and awaited by
    // _stopAsr before the marker is emitted.
    const teardown = (async () => {
      await asr.flushFinals();
      asr.removeAllListeners();
      asr.dispose();
    })();
    this._trackPendingLeave(ck, teardown);
    await teardown;
    logger.info(`Disposed per-stream ASR ${key} on participant leave (cap slot freed)`);
    return true;
  }

  // C9: register an in-flight participant teardown for the channel. The entry
  // removes itself once settled, and the Set is dropped with its last member, so
  // the map can never grow past the teardowns actually running.
  _trackPendingLeave(ck, promise) {
    const pending = (this.pendingLeaves ||= new Map());
    let set = pending.get(ck);
    if (!set) {
      set = new Set();
      pending.set(ck, set);
    }
    set.add(promise);
    const done = () => {
      set.delete(promise);
      if (set.size === 0 && pending.get(ck) === set) pending.delete(ck);
    };
    promise.then(done, done);
  }

  // Per-stream: apply a participant identity update to the live sub-ASR so its
  // next captions carry it. Covers the mid-call rename (#7) and K6 — a `join`
  // whose control message lands AFTER the participant's first tagged frame
  // already created the sub-ASR with an empty participant (id AND name null),
  // which otherwise left every caption of that participant unattributed for the
  // whole call. No-op when the participant has no live ASR yet (the WS
  // participant map already holds the identity for lazy creation).
  _renamePerStreamParticipant(sessionId, channelId, tag, name, id) {
    const ck = `${sessionId}_${channelId}`;
    const key = `${ck}#${tag}`;
    // Neither reserved key is a participant: the recorder has no captions, and
    // re-keying the shared overflow ASR would relabel every capped speaker.
    if (key.endsWith(RECORDER_SUFFIX) || key === `${ck}#${OVERFLOW_TAG}`) {
      logger.warn(`Ignoring participant identity update for the reserved key ${key}`);
      return;
    }
    const asr = this.ASRs.get(key);
    if (asr && typeof asr.setParticipant === 'function') asr.setParticipant(name, id);
  }

  // Every ASR is created with an 'error' listener. ASR emits 'error' on an init
  // failure and on a dispose/saveAudio failure (a failed ffmpeg transcode of the
  // archive is the likeliest one, and K2 gives the channel a second,
  // transcode-owning ASR — the recorder — on this same path). The ASR class
  // extends eventemitter3, which returns false instead of throwing on an
  // unhandled 'error', so an unlistened emit is silently lost rather than fatal:
  // this listener exists to make the failure VISIBLE, named by its ASR key, and
  // to keep the semantics safe should the emitter ever become node:events.
  _wireAsrErrors(asr, key) {
    asr.on('error', (error) => {
      logger.error(`ASR ${key} error: ${error && error.message ? error.message : error}`);
    });
    return asr;
  }

  // Build an ASR and wire its partial/final listeners onto the component's
  // event bus, then register it under `key` in `this.ASRs`. The emit arguments
  // are passed through verbatim by each call site (session-start uses
  // session.id/channel.id; per-stream uses the raw sessionId/channelId).
  _wireAsr(session, channel, options, key, sessionId, channelId) {
    const asr = new ASR(session, channel, options);
    this._wireAsrErrors(asr, key);
    asr.on('partial', (transcription) => {
      this.emit('partial', transcription, sessionId, channelId, channel);
    });
    asr.on('final', (transcription) => {
      this.emit('final', transcription, sessionId, channelId, channel);
    });
    this.ASRs.set(key, asr);
    return asr;
  }


  // Tear down the ASR of a channel so the end-of-stream bot marker is provably
  // the LAST final published for the stream, and the deactivate (streamStatus
  // 'inactive') is published strictly after it:
  //   1. remove the ASR from the map synchronously (double session-stop guard)
  //   2. flush in-flight provider finals with listeners still attached
  //   3. publish the bot end-of-stream marker
  //   4. preserve the segment-id cursor (it now includes the flushed finals);
  //      a newer legacy stream of the channel waits for it to number its
  //      segments (a per-stream one shares the allocator instead, see K1)
  //   5. detach listeners and dispose; with kept audio, wait for the audio
  //      file to be saved (bounded, see _awaitKeptAudio): the legacy ASR's,
  //      or the per-stream recorder's
  //   6. emit 'session-stop' -> controllers -> deactivate published last, but
  //      ONLY when this stream is still the channel's latest one, running or
  //      being stopped (K1: a reconnect that superseded it during the stop
  //      must not have its successor deactivated, see _reportChannelStopped)
  // Returns false when no ASR was registered for the channel.
  async _stopAsr(session, channelId) {
    const ck = `${session.id}_${channelId}`;
    // Per-stream channels keep their ASR under `${ck}#${tag}`; legacy under `${ck}`.
    // Match both so a channel's every sub-ASR is torn down (0 orphans).
    const subKeys = [...this.ASRs.keys()].filter(k => k === ck || k.startsWith(`${ck}#`));

    if (subKeys.length === 0) {
      // D3a lazy hole: a per-stream channel that was marked at session-start but
      // never received a single tagged frame created 0 ASR. We must still emit
      // session-stop so the marker + deactivate (streamStatus inactive) are
      // published — otherwise the session stays stuck. Legacy (no per-stream
      // marker) returns false unchanged.
      const lazyCtx = this.channels.get(ck);
      if (lazyCtx && lazyCtx.allocator != null) {
        // K10: a stop for THIS VERY context is already in flight. It emptied
        // this.ASRs in its synchronous prefix and is parked on the flushes, so a
        // DUPLICATE stop for the same connection lands here with 0 sub-keys. The
        // in-flight stop owns the end-of-stream marker, the segment-id cursor
        // and the deactivate; letting the duplicate proceed deleted the context
        // out from under it, so its identity guard below failed, `lastSegmentIds`
        // was never written (the next connection then re-used ids the trailing
        // finals had just published) and the duplicate's deactivate was emitted
        // BEFORE the marker it is contractually supposed to follow. A genuine
        // successor is always a FRESH context object (session-start never reuses
        // one), so `stopping` here can only mean a duplicate of this same stop.
        if (lazyCtx.stopping) {
          logger.info(`Channel ${ck} is already stopping; ignoring the duplicate stop`);
          return false;
        }
        lazyCtx.stopping = true; // C4, same contract as the N-ASR branch below
        // C9: the channel's only participant may have just left and still be
        // flushing its trailing finals — the deactivate must not precede them.
        const lazyLeaves = [...(this.pendingLeaves?.get(ck) || [])];
        if (lazyLeaves.length > 0) await Promise.allSettled(lazyLeaves);
        // K1: drop the context this stop owns, never a successor's; the
        // deactivate is gated on the channel's latest stream (same rule as the
        // tail below).
        this._cleanupPerStream(ck, lazyCtx);
        this._reportChannelStopped(session, channelId, lazyCtx);
        logger.info(`Stopped per-stream channel ${ck} with 0 ASR (lazy hole closed)`);
        return true;
      }
      return false;
    }

    const ctx = this.channels.get(ck);
    // The teardown ordering is decided by the KEYS actually being torn down,
    // never by the channel context. `subKeys` matches the bare legacy `${ck}` as
    // well as `${ck}#*`, so a per-stream context that OUTLIVED its stream (a
    // stop superseded by a reconnect, a context still awaiting the K9 reaper —
    // which cannot collect it while the legacy ASR keeps _hasChannelAsr true)
    // would otherwise hijack a genuinely LEGACY channel stop: the legacy
    // ordering, and with it preserveSegmentId, would be skipped and the STALE
    // allocator's cursor written over the live ASR's own counter, so the next
    // stream on the channel resumes on segment ids whose captions are already
    // stored. The context is still the source of the shared allocator, but only
    // once this stop really is tearing per-stream sub-ASR down.
    // The `ctx != null` half of that condition was the MIRROR-image hole: with
    // sub-ASR registered but no context, the else-branch below ran the LEGACY
    // single-ASR ordering over every one of them — N end-of-stream markers (N
    // blank caption rows) instead of one, N sequential flushes instead of the
    // concurrent K3 ones, and preserveSegmentId once per sub-ASR, the last
    // iterated winning the channel cursor. Route on the keys ALONE and treat a
    // missing context as the already-handled "nothing to preserve" case.
    const perStreamKeys = subKeys.filter(k => k !== ck);
    const isPerStreamStop = perStreamKeys.length > 0;
    let legacyAsr;
    if (isPerStreamStop) {
      // Per-stream: a channel has N sub-ASR but ONE end-of-stream. Flush every
      // sub-ASR's in-flight finals (listeners attached so trailing captions are
      // published), then emit the bot end-of-stream marker EXACTLY ONCE via a
      // single designated sub-ASR (#9) — emitting streamStopped() on each would
      // store N blank caption rows. The marker is emitted AFTER every flush, so
      // it stays the provably-last final, and BEFORE any removeAllListeners so it
      // is still forwarded to the broker. Finally detach + dispose all.
      //
      // K2: the recorder (`${ck}#rec`) is NOT part of any of that. It has no
      // finals to flush (flushing it would only add ASR_STOP_SETTLE_MS to every
      // channel stop) and no marker to emit, and it is disposed LAST so its
      // saveAudio() runs once, after everything else is quiesced.
      //
      // C4: mark the context as STOPPING in this synchronous prefix, before any
      // await. _getOrCreatePerStreamAsr refuses to create a sub-ASR for a
      // stopping channel, so no ASR can appear behind the snapshot below and
      // outlive the teardown (leaked provider socket + captions published after
      // the marker).
      if (ctx) ctx.stopping = true;
      const asrs = [], recorders = [];
      for (const k of perStreamKeys) {
        const asr = this.ASRs.get(k);
        this.ASRs.delete(k);
        (k.endsWith(RECORDER_SUFFIX) ? recorders : asrs).push(asr);
      }
      // K3: the flushes are independent, each bounded by ASR_STOP_FLUSH_TIMEOUT_MS
      // + ASR_STOP_SETTLE_MS, so run them CONCURRENTLY — sequentially a channel
      // at the default cap took ~23 s to publish its marker and its deactivate
      // (streamStatus 'inactive') against ~3.3 s on the legacy path. The only
      // contractual ordering is "marker after every flush", which allSettled
      // preserves even when one provider's stop() rejects.
      // C9: a participant LEAVE already flushing its own trailing finals is
      // awaited here too, so the marker stays the provably-last final.
      const pendingLeaves = [...(this.pendingLeaves?.get(ck) || [])];
      const settled = await Promise.allSettled([
        ...asrs.map(asr => asr.flushFinals()),
        ...pendingLeaves,
      ]);
      for (const result of settled) {
        if (result.status === 'rejected') {
          logger.error(`Error flushing a sub-ASR of ${ck} on stop: ${result.reason}`);
        }
      }
      // Nobody ever spoke (only the recorder was created): emit NO marker, which
      // is exactly what a per-stream channel with 0 ASR does today (D3a) — a
      // marker here would store a new blank caption row.
      if (asrs.length > 0) {
        asrs[0].streamStopped();
      }
      for (const asr of asrs) {
        asr.removeAllListeners();
        asr.dispose();
      }
      // The recorder is NOT pre-detached, unlike the participant sub-ASR above
      // where detaching before dispose is load-bearing (it stops a late
      // 'partial'/'final' escaping after the end-of-stream marker). A recorder
      // has no partial/final wiring at all, and its dispose() -> saveAudio() is
      // the very path _wireAsrErrors exists for: a failed ffmpeg transcode of
      // the archive emits 'error', and detaching first threw away the only
      // ASR-key-qualified log line that names which channel's archive died.
      // ASR.dispose() removes the listeners itself on its way out.
      const recorderSaves = recorders.map(recorder => recorder.dispose());
      // K1: a RECONNECT can have re-registered a fresh context for this channel
      // while we were awaiting the flushes above — cleanupWebsocket emits
      // 'session-stop' SYNCHRONOUSLY from the new connection's handler, so the
      // successor's session-start lands inside that window. Everything below is
      // channel-keyed state that now belongs to the SUCCESSOR, so touch it only
      // while the entry is still the very object this stop owns.
      if (this.channels.get(ck) === ctx) {
        // C4 belt-and-braces: `stopping` closes the creation window today, but
        // re-scan for a straggler anyway. Detach BEFORE disposing so a straggler
        // can never publish after the marker.
        //
        // Per-stream SUB-KEYS only: the bare `${ck}` key is by construction never a
        // per-stream straggler — it can only have been created by the LEGACY
        // session-start branch, i.e. by a SUCCESSOR connection that landed
        // inside this stop's flush window and was not granted per-stream (a
        // plain WS client taking the channel over, or a keepAudio channel whose
        // new bot cannot mix and is DEMOTED). Sweeping it detached and disposed
        // the successor's freshly-created ASR, leaving the channel with no ASR
        // at all: every later frame hit "No ASR found" and zero captions were
        // produced for the rest of the session. The K1 identity guard does not
        // cover it, because such a successor registers no channel context.
        for (const k of [...this.ASRs.keys()]) {
          if (!k.startsWith(`${ck}#`)) continue;
          const straggler = this.ASRs.get(k);
          this.ASRs.delete(k);
          logger.warn(`Per-stream: disposing straggler ASR ${k} created while ${ck} was stopping`);
          straggler.removeAllListeners();
          straggler.dispose();
        }
        // Preserve the segmentId cursor at the CHANNEL level (never per-ASR) from
        // the shared allocator's next value. Guarded: with no context there is
        // no shared allocator and so nothing to preserve (the identity check
        // above holds for `ctx === undefined` only when the entry is genuinely
        // absent, which is exactly that case).
        if (ctx && ctx.allocator) {
          this.lastSegmentIds.set(ck, ctx.allocator.next);
        }
      }
      if (recorderSaves.length > 0) {
        await this._awaitKeptAudio(Promise.all(recorderSaves), session, channelId);
      }
    } else {
      legacyAsr = this.ASRs.get(ck);
      // Legacy single ASR: the original ordering (flush, streamStopped,
      // preserveSegmentId, removeAllListeners, dispose). A client that
      // reconnects at once starts a newer stream while this one flushes: its
      // first segment id waits for this stream's cursor (initialSegmentIdFor).
      for (const k of subKeys) {
        const asr = this.ASRs.get(k);
        this.ASRs.delete(k);
        let cursorFinal;
        const stopping = new Promise((resolve) => { cursorFinal = resolve; });
        this.stoppingStreams.set(ck, stopping);
        try {
          await asr.flushFinals();
          asr.streamStopped();
          // subKeys === [ck]; preserve the single ASR's own counter BEFORE dispose
          // (asr.segmentId is still valid here).
          this.preserveSegmentId(session.id, channelId, asr);
        } finally {
          if (this.stoppingStreams.get(ck) === stopping) this.stoppingStreams.delete(ck);
          cursorFinal();
        }
        asr.removeAllListeners();
        const disposed = asr.dispose();
        if (asr.channel.keepAudio) {
          await this._awaitKeptAudio(disposed, session, channelId);
        }
      }
    }

    // K1: drop the per-stream context this stop owns, never a successor's.
    this._cleanupPerStream(ck, ctx);
    this._reportChannelStopped(session, channelId, isPerStreamStop ? ctx : legacyAsr);
    logger.info(`Stopped ${isPerStreamStop ? perStreamKeys.length : subKeys.length} ASR for ${ck} (0 orphans)`);
    return true;
  }

  // Session-end drains (Scheduler, PUT /sessions/:id/stop?waitFinal=true) end
  // when the channel is reported inactive, and studio-api then reads the kept
  // audio file: it converts and deletes the WAV, and measures the MP3 once for
  // good. So the deactivation waits for the file to be complete, at most
  // ASR_STOP_AUDIO_SAVE_TIMEOUT_MS so a slow transcode cannot hold it forever.
  async _awaitKeptAudio(disposed, session, channelId) {
    const timeoutMs = parseInt(process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS, 10) || 5000;
    let timer;
    const saved = await Promise.race([
      disposed.catch(() => {}).then(() => true),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); }),
    ]);
    clearTimeout(timer);
    if (!saved) {
      logger.warn(`Session ${session.id}, channel ${channelId}: kept audio still being saved after ${timeoutMs}ms, reporting the channel inactive anyway (its audio file may be incomplete when read)`);
    }
  }

  // 'session-stop' is wired to BrokerClient.deactivate(), which publishes
  // streamStatus 'inactive' for the CHANNEL. A client that reconnects right away
  // (a bot reopening its WS to switch diarization mode, a demoted bot, the
  // native->web re-route, a plain WS client) starts a newer stream on the
  // channel while this one is being stopped: per-stream or legacy, its
  // activation is already published, and this deactivation, carrying the same
  // transcriberId, would mark the channel inactive under it (the Scheduler only
  // ignores another transcriber's stale deactivation), or before its captions
  // and audio are saved if it is being stopped too. So only the channel's LATEST stream,
  // running or being stopped (`latestStreams`: its legacy ASR or its per-stream
  // context), reports it inactive, after its own captions; an older stream's
  // stop never does. This replaces the evidence the stop used to look for (a
  // re-registered context, a bare-key ASR), which missed a newer stream that is
  // itself already being stopped.
  _reportChannelStopped(session, channelId, stream) {
    const ck = `${session.id}_${channelId}`;
    if (this.latestStreams.get(ck) !== stream) {
      logger.info(`Session ${session.id}, channel ${channelId}: a newer stream took over during the stop, channel kept active`);
      return false;
    }
    this.latestStreams.delete(ck);
    this.emit('session-stop', session, channelId);
    return true;
  }

  // K1: drop the channel context this stop owns. `ctx` is the identity captured
  // BEFORE the multi-second flush awaits: if a reconnect re-registered the
  // channel meanwhile, the map now holds the SUCCESSOR's context and deleting it
  // would strand the new connection — every tagged frame would then hit "no
  // channel context" and the channel would publish ZERO captions for the rest of
  // the session. Legacy passes ctx === undefined, which matches the absent entry
  // and keeps the original unconditional cleanup.
  _cleanupPerStream(ck, ctx) {
    if (this.channels.get(ck) !== ctx) {
      logger.info(`Channel ${ck} was re-registered while stopping; keeping the successor's context`);
      return false;
    }
    // K1: the shared allocator dies with the context (a per-stream successor
    // reuses the OBJECT, see session-start), so publish its cursor HERE — the
    // single place that destroys it — instead of only in the N-sub-ASR branch.
    // Otherwise a successor torn down through the lazy branch (it inherited the
    // allocator but never received a tagged frame) drops the cursor silently,
    // the predecessor's own write is then skipped by its identity guard, and the
    // next connection reseeds from `channel.lastSegmentId` in the retained
    // statuses broadcast — which the Scheduler republishes only on
    // activate/deactivate, never per stored caption, so it can be hundreds of
    // ids stale and the new stream overwrites captions already stored.
    // Monotonic: never regress a cursor a later connection already published.
    // Legacy passes ctx === undefined and writes nothing (preserveSegmentId
    // stays its only writer).
    if (ctx && ctx.allocator) {
      this.lastSegmentIds.set(ck, Math.max(this.lastSegmentIds.get(ck) || 0, ctx.allocator.next));
    }
    this.channels.delete(ck);
    // Let a later reconnect of the same channel warn again about a missing
    // recorder instead of silently dropping its mixed flow.
    this._noRecorderWarned?.delete(ck);
    return true;
  }

  // K9: reap channel contexts whose stream is long gone. `this.channels` is the
  // twin of the WS server's speakerTrackers/streamParticipants but had no
  // reaper: a channel whose 'session-stop' never fires (an init that failed
  // without an fd, a crashed emit path) kept its
  // {session, channel, allocator, overflowTags, ...} entry — and its iteration
  // cost in _setSessionPaused — for the process lifetime. Same interval
  // convention as WebsocketServer.reapOrphanTrackers. Safe to call repeatedly.
  //
  // A LIVE channel must NEVER be reaped, so an entry is dropped only when all of
  // these hold:
  //   - the channel has no registered ASR at all (any sub-ASR, or the recorder,
  //     proves it is streaming);
  //   - no streaming server still holds its per-stream participant map, which
  //     lives exactly as long as the connection (cleanupWebsocket drops it);
  //   - it was registered more than one reaper period ago, so a channel just
  //     marked at session-start that has not yet received its first tagged frame
  //     (the D3a lazy hole, which legitimately has 0 ASR) is never collected.
  reapOrphanChannels() {
    const now = Date.now();
    for (const [ck, ctx] of this.channels) {
      if (now - (ctx.registeredAt || 0) < this.channelReaperIntervalMs) continue;
      if (this._hasChannelAsr(ck)) continue;
      if (this._isChannelStreaming(ctx)) continue;
      logger.info(`Reaping orphan channel context ${ck} (no ASR, no live stream)`);
      this.channels.delete(ck);
      if (this.latestStreams.get(ck) === ctx) this.latestStreams.delete(ck);
      this._noRecorderWarned?.delete(ck);
    }
    this._reapNoRecorderWarned();
    // Nothing left to reap: disarm, the exact counterpart of the lazy arming
    // done by the first per-stream channel (session-start calls
    // startChannelReaper() unconditionally and idempotently, so the next
    // per-stream channel re-arms it). Without this the 60 s interval, armed by
    // one per-stream channel, iterated an empty Map for the process lifetime.
    if (this.channels.size === 0 && !(this._noRecorderWarned && this._noRecorderWarned.size > 0)) {
      this.stopChannelReaper();
    }
  }

  // The warn-once bookkeeping of the `record-data` handler is itself unbounded:
  // a mixed frame carrying a ck that has NO channel context (a stale bot still
  // shipping the 0x02 flow after its channel was torn down, a mismatched
  // session/channel id) adds an entry that neither _cleanupPerStream nor the
  // channel reaper above can ever remove — both are driven by `this.channels`,
  // which never held that ck. Drop every entry whose channel is gone for good:
  // no context, no ASR. The Set only throttles a log line, so the worst cost of
  // dropping an entry too eagerly is one more WARN.
  _reapNoRecorderWarned() {
    if (!this._noRecorderWarned) return;
    for (const ck of [...this._noRecorderWarned]) {
      if (this.channels.has(ck)) continue;
      if (this._hasChannelAsr(ck)) continue;
      this._noRecorderWarned.delete(ck);
    }
  }

  // True when any ASR of the channel is registered: the legacy `${ck}` key, a
  // per-stream sub-ASR `${ck}#${tag}`, or the recorder `${ck}#rec`. Same '#'
  // boundary as _stopAsr so "sess_chan1" never matches channel "sess_chan".
  _hasChannelAsr(ck) {
    for (const key of this.ASRs.keys()) {
      if (key === ck || key.startsWith(`${ck}#`)) return true;
    }
    return false;
  }

  // True while a streaming server still holds the channel's per-stream state.
  // Anything unknown (no id, no server list) is reported as streaming: the
  // reaper errs on the side of keeping a context alive.
  _isChannelStreaming(ctx) {
    const sessionId = ctx.session && ctx.session.id;
    const channelId = ctx.channel && ctx.channel.id;
    if (sessionId == null || channelId == null) return true;
    return (this.servers || []).some(server =>
      typeof server.getStreamParticipants === 'function'
      && server.getStreamParticipants(sessionId, channelId) != null);
  }

  startChannelReaper() {
    if (this.channelReaperInterval) return;
    this.channelReaperInterval = setInterval(() => this.reapOrphanChannels(), this.channelReaperIntervalMs);
    // Do not keep the event loop alive solely for the reaper.
    if (this.channelReaperInterval.unref) this.channelReaperInterval.unref();
  }

  stopChannelReaper() {
    if (this.channelReaperInterval) {
      clearInterval(this.channelReaperInterval);
      this.channelReaperInterval = null;
    }
  }

  async _applyToSessionASRs(sessionId, action) {
    const promises = [];
    for (const [key, asr] of this.ASRs) {
      if (key.startsWith(`${sessionId}_`)) {
        promises.push(
          asr[action]().catch(e => logger.error(`Error ${action}ing ASR ${key}: ${e.message}`))
        );
      }
    }
    if (promises.length === 0) {
      logger.debug(`${action}Session(${sessionId}): no active ASR`);
      return;
    }
    await Promise.allSettled(promises);
    const verb = action === 'pause' ? 'Paused' : 'Resumed';
    logger.info(`${verb} ${promises.length} ASR(s) for session ${sessionId}`);
  }

  // Record the paused state on every per-stream channel context of the session so
  // a sub-ASR created LAZILY during the pause window (a participant speaking for
  // the first time mid-pause) is paused on creation instead of leaking captions
  // through a fresh, non-paused ASR (#8). Legacy channels carry no context here
  // and are unaffected — their single ASR already exists and is (un)paused by
  // _applyToSessionASRs directly.
  _setSessionPaused(sessionId, paused) {
    for (const [ck, ctx] of this.channels) {
      if (ck.startsWith(`${sessionId}_`)) ctx.paused = paused;
    }
  }

  pauseSession(sessionId) {
    this._setSessionPaused(sessionId, true);
    return this._applyToSessionASRs(sessionId, 'pause');
  }

  resumeSession(sessionId) {
    this._setSessionPaused(sessionId, false);
    return this._applyToSessionASRs(sessionId, 'resume');
  }

  // Drop cached segment-id cursors for the given channels. The Session-API
  // has just reset channel.lastSegmentId to 0 in the DB; without purging this
  // map, a later ASR restart would resume from a stale in-memory cursor and
  // produce a discontinuous sequence. Any currently-running ASR keeps its
  // own counter and will continue from where it is — that's the best-effort
  // contract documented on the /clear endpoint.
  clearSession(sessionId, channelIds) {
    let purged = 0;
    for (const channelId of channelIds) {
      const key = `${sessionId}_${channelId}`;
      if (this.lastSegmentIds.delete(key)) purged += 1;
    }
    logger.info(`clearSession ${sessionId}: purged ${purged}/${channelIds.length} cached segmentId(s)`);
  }

  // First segment id of a new legacy stream on a channel. A client that
  // reconnects at once (e.g. a bot reopening its WS) starts the new stream while
  // the previous one is still being stopped on this instance, and that stream's
  // ASR may still publish finals (stop flush): the id is then a promise,
  // resolved once that stream's cursor is final, and the new ASR holds its
  // provider until then.
  initialSegmentIdFor(session, channel) {
    const stopping = this.stoppingStreams && this.stoppingStreams.get(`${session.id}_${channel.id}`);
    if (!stopping) {
      return this.resolveInitialSegmentId(session.id, channel.id, channel);
    }
    return stopping.then(() => this.resolveInitialSegmentId(session.id, channel.id, channel));
  }

  // Both sources are lower bounds of the next free segment id: the cursor of a
  // stream this instance stopped, and the last id the Scheduler stored as of
  // the latest statuses snapshot, ahead of the former when the channel streamed
  // on another instance since. Take the furthest.
  resolveInitialSegmentId(sessionId, channelId, channel) {
    const key = `${sessionId}_${channelId}`;
    const memorySegmentId = this.lastSegmentIds.get(key);
    this.lastSegmentIds.delete(key);
    const mqttSegmentId = channel.lastSegmentId;
    return Math.max(memorySegmentId || 1, mqttSegmentId ? mqttSegmentId + 1 : 1);
  }

  preserveSegmentId(sessionId, channelId, asr) {
    const key = `${sessionId}_${channelId}`;
    this.lastSegmentIds.set(key, asr.segmentId + 1);
  }

  async startServers() {
    for(const server of this.servers) {
      server.start();
    }
  }

  // called by controllers/BrokerClient.js uppon receiving system/out/sessions/statuses message
  setSessions(sessions) {
    for(const server of this.servers) {
      server.setSessions(sessions);
    }
  }

}


module.exports = app => new StreamingServer(app);
// Additive: expose the class for unit tests (the default export stays the
// factory used by the component loader). Not used at runtime.
module.exports.StreamingServer = StreamingServer;
