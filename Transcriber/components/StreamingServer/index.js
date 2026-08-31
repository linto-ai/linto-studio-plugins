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
    this.servers = [];
    this.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
    // Per-stream diarization (one ASR per participant). All keyed by the channel
    // key `${sessionId}_${channelId}` (ck); the sub-ASR live in `this.ASRs`
    // under `${ck}#${tag}` (the '#' guarantees no startsWith collision with the
    // legacy `${ck}` key, e.g. "s_10".startsWith("s_1#") === false). Per-stream
    // channels are exactly those whose context carries an `allocator` (the shared
    // per-channel segmentId source for the channel's sub-ASR).
    this.channels = new Map();           // ck -> { session, channel, allocator? } for lazy ASR creation
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
            const allocator = { next: this.resolveInitialSegmentId(session.id, channel.id, channel) };
            this.channels.set(ck, { session, channel, allocator });
            this.emit('session-start', session, channel);
            logger.info(`Session ${session.id}, channel ${channel.id} started (per-stream diarization, lazy ASR)`);
            return;
          }
          const initialSegmentId = this.resolveInitialSegmentId(session.id, channel.id, channel);
          // Native diarization: bot WS streams register a SpeakerTracker on the
          // WS server at init. Non-bot sources (SRT/RTMP/non-native WS) have none.
          const speakerTracker = typeof server.getSpeakerTracker === 'function'
            ? server.getSpeakerTracker(session.id, channel.id)
            : null;
          const diarizationMode = speakerTracker ? 'native' : 'asr';
          this._wireAsr(session, channel, { initialSegmentId, speakerTracker, diarizationMode },
            `${session.id}_${channel.id}`, session.id, channel.id);
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

      server.on('data', (audio, sessionId, channelId, tag) => {
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
          // lazily creating it on the first frame of each tag.
          const asr = this._getOrCreatePerStreamAsr(server, sessionId, channelId, tag);
          if (asr) asr.transcribe(buffer);
        } catch (error) {
          logger.error(`Error processing data for session ${sessionId}, channel ${channelId}: ${error}`);
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

      // Per-stream: a participant was renamed mid-call. Update the live sub-ASR's
      // display name so subsequent captions carry it (the WS server already
      // updated its participant map).
      server.on('participant-rename', (sessionId, channelId, tag, name) => {
        this._renamePerStreamParticipant(sessionId, channelId, tag, name);
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
    // Fast path for capped tags: a tag once collapsed onto the shared overflow
    // ASR stays there, so route it in O(1) instead of re-scanning every frame
    // (the scan below is the hot-path cost that only bites in large meetings).
    if (ctx.overflowTags && ctx.overflowTags.has(tag)) {
      return this.ASRs.get(`${ck}#${OVERFLOW_TAG}`) || null;
    }

    // Apply the per-channel cap: count this channel's existing sub-ASR.
    const cap = this.maxAsrPerChannel;
    const subCount = [...this.ASRs.keys()].filter(k => k.startsWith(`${ck}#`)).length;
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

  // Per-stream: tear down ONE participant's sub-ASR (on a `leave`) and free its
  // cap slot. Flush in-flight finals with listeners still attached so trailing
  // captions are published, then dispose WITHOUT emitting the channel end-of-
  // stream marker (that is reserved for channel stop, #9). After the map delete
  // the freed tag no longer counts toward the cap. No-op if no such ASR exists.
  async _disposePerStreamParticipant(sessionId, channelId, tag) {
    const ck = `${sessionId}_${channelId}`;
    // A tag can be recycled by the bot to a later joiner, so forget any overflow
    // routing memoized for it (else the new participant would be pinned to
    // overflow even with free slots).
    this.channels.get(ck)?.overflowTags?.delete(tag);
    const key = `${ck}#${tag}`;
    const asr = this.ASRs.get(key);
    if (!asr) return false;
    this.ASRs.delete(key);
    await asr.flushFinals();
    asr.removeAllListeners();
    asr.dispose();
    logger.info(`Disposed per-stream ASR ${key} on participant leave (cap slot freed)`);
    return true;
  }

  // Per-stream: apply a mid-call rename to the live sub-ASR so its next captions
  // carry the new name. No-op when the participant has no live ASR yet (the WS
  // participant map already holds the new name for lazy creation).
  _renamePerStreamParticipant(sessionId, channelId, tag, name) {
    const asr = this.ASRs.get(`${sessionId}_${channelId}#${tag}`);
    if (asr && typeof asr.setParticipant === 'function') asr.setParticipant(name);
  }

  // Build an ASR and wire its partial/final listeners onto the component's
  // event bus, then register it under `key` in `this.ASRs`. The emit arguments
  // are passed through verbatim by each call site (session-start uses
  // session.id/channel.id; per-stream uses the raw sessionId/channelId).
  _wireAsr(session, channel, options, key, sessionId, channelId) {
    const asr = new ASR(session, channel, options);
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
  //   4. preserve the segment-id cursor (it now includes the flushed finals)
  //   5. detach listeners and dispose (audio save stays fire-and-forget)
  //   6. emit 'session-stop' -> controllers -> deactivate published last
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
      if (this.channels.has(ck) && this.channels.get(ck).allocator != null) {
        this._cleanupPerStream(ck);
        this.emit('session-stop', session, channelId);
        logger.info(`Stopped per-stream channel ${ck} with 0 ASR (lazy hole closed)`);
        return true;
      }
      return false;
    }

    const ctx = this.channels.get(ck);
    const hasAllocator = ctx != null && ctx.allocator != null;
    if (hasAllocator) {
      // Per-stream: a channel has N sub-ASR but ONE end-of-stream. Flush every
      // sub-ASR's in-flight finals (listeners attached so trailing captions are
      // published), then emit the bot end-of-stream marker EXACTLY ONCE via a
      // single designated sub-ASR (#9) — emitting streamStopped() on each would
      // store N blank caption rows. The marker is emitted AFTER every flush, so
      // it stays the provably-last final, and BEFORE any removeAllListeners so it
      // is still forwarded to the broker. Finally detach + dispose all.
      const asrs = subKeys.map(k => {
        const asr = this.ASRs.get(k);
        this.ASRs.delete(k);
        return asr;
      });
      for (const asr of asrs) {
        await asr.flushFinals();
      }
      asrs[0].streamStopped();
      for (const asr of asrs) {
        asr.removeAllListeners();
        asr.dispose();
      }
      // Preserve the segmentId cursor at the CHANNEL level (never per-ASR) from
      // the shared allocator's next value.
      this.lastSegmentIds.set(ck, ctx.allocator.next);
    } else {
      // Legacy single ASR: byte-for-byte the original ordering (flush,
      // streamStopped, preserveSegmentId, removeAllListeners, dispose).
      for (const k of subKeys) {
        const asr = this.ASRs.get(k);
        this.ASRs.delete(k);
        await asr.flushFinals();
        asr.streamStopped();
        // subKeys === [ck]; preserve the single ASR's own counter BEFORE dispose
        // (asr.segmentId is still valid here).
        this.preserveSegmentId(session.id, channelId, asr);
        asr.removeAllListeners();
        asr.dispose();
      }
    }

    this._cleanupPerStream(ck);
    this.emit('session-stop', session, channelId);
    logger.info(`Stopped ${subKeys.length} ASR for ${ck} (0 orphans)`);
    return true;
  }

  _cleanupPerStream(ck) {
    this.channels.delete(ck);
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

  resolveInitialSegmentId(sessionId, channelId, channel) {
    const key = `${sessionId}_${channelId}`;
    const memorySegmentId = this.lastSegmentIds.get(key);
    this.lastSegmentIds.delete(key);
    const mqttSegmentId = channel.lastSegmentId;
    return memorySegmentId || (mqttSegmentId ? mqttSegmentId + 1 : 1);
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
