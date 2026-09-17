const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const path = require('path');
const WebSocket = require('ws');
const logger = require('../../../logger')
const { parseStreamId, findSessionByPrivateId } = require('../streamId');
const SpeakerTracker = require('../SpeakerTracker');

const {
    STREAMING_HOST,
    STREAMING_WS_TCP_PORT,
    STREAMING_WS_ENDPOINT
} = process.env;

// Tagged binary frame magics (byte 0). Neither can collide with a JSON control
// frame, which always starts with 0x7B ('{'). See _parseTaggedFrame /
// _parseMixedFrame for the shared 8-byte header layout.
const MAGIC_TAGGED = 0x01;  // per-participant PCM (byte 1 = participant tag)
const MAGIC_MIXED = 0x02;   // mixed recording PCM (byte 1 always 0, ignored)

// WebSocket runs over TCP. Unlike SRT (UDP) there is no inactivity sentinel:
// the connection lifetime is governed by the TCP socket alone. ws.on('close')
// fires when the peer sends FIN or the OS detects an RST; ws.on('error') for
// all other faults. Until then the channel is considered live, even if the
// client has gone silent. For pause/resume this means:
//   - WS pause + sender keeps the socket open and silent → ASR stays alive
//     (just paused), resume is immediate on the same provider.
//   - WS pause + sender closes the socket → ws.on('close') triggers cleanup,
//     emits session-stop, ASR is disposed. A subsequent PUT /resume finds
//     no ASR. Streaming has to start over.
// See doc/streaming-protocols.md for the cross-protocol comparison.
class MultiplexedWebsocketServer extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.wss = null;
    this.workers = [];
    this.runningSessions = {}
    this.runningChannels = {};
    this.pendingChannels = new Set();
    this.isRunning = false;
    // Native diarization: per-channel SpeakerTracker, created on `init` when a
    // bot announces diarizationMode='native'. Keyed by `${sessionId}_${channelId}`.
    this.speakerTrackers = new Map();
    // Per-stream diarization (one ASR per participant): created on `init` when a
    // bot announces perStream:true AND the env flag is on. Maps participantTag
    // (u8) -> {id, name, tag}. Keyed by `${sessionId}_${channelId}`. Twin of
    // speakerTrackers; null/absent when perStream is off (legacy bit-exact).
    this.streamParticipants = new Map();
    // Periodic reaper: drops trackers whose channel is no longer running (orphans
    // that escaped cleanupWebsocket). Held so stop()/tests can clear it.
    this.reaperInterval = null;
    this.reaperIntervalMs = 60000;
  }

  // Drop trackers whose channel is no longer in runningChannels. A live tracker
  // is only valid while its channel streams; an entry for a channel that is gone
  // is an orphan that cleanupWebsocket missed (e.g. an init that failed without
  // an fd). Safe to call repeatedly.
  reapOrphanTrackers() {
    for (const key of this.speakerTrackers.keys()) {
      // key is `${sessionId}_${channelId}`; channelId is the last segment.
      const channelId = key.slice(key.lastIndexOf('_') + 1);
      if (!this.runningChannels[channelId]) {
        logger.info(`Reaping orphan speaker tracker for channel ${channelId} (key ${key})`);
        this.speakerTrackers.delete(key);
      }
    }
    for (const key of this.streamParticipants.keys()) {
      const channelId = key.slice(key.lastIndexOf('_') + 1);
      if (!this.runningChannels[channelId]) {
        logger.info(`Reaping orphan per-stream participant map for channel ${channelId} (key ${key})`);
        this.streamParticipants.delete(key);
      }
    }
  }

  startReaper() {
    if (this.reaperInterval) return;
    this.reaperInterval = setInterval(() => this.reapOrphanTrackers(), this.reaperIntervalMs);
    // Do not keep the event loop alive solely for the reaper.
    if (this.reaperInterval.unref) this.reaperInterval.unref();
  }

  stopReaper() {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }

  // To verify incoming streamId and other details, controlled by streaming server forwarding from broker
  setSessions(sessions) {
      const prevSessions = this.sessions;
      this.sessions = sessions;

      if (prevSessions) {
          // force stop running sessions
          const deletedSessions = prevSessions.filter(currentSession =>
              !sessions.some(newSession => newSession.id === currentSession.id)
          );
          const sessionsToStop = deletedSessions.filter(deletedSession =>
              this.runningSessions.hasOwnProperty(deletedSession.id)
          );

          if (sessionsToStop.length > 0) {
              logger.info(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
          }
          sessionsToStop.forEach(session => this.stopRunningSession(session));
      }
  }

  async start() {
      if (this.isRunning) {
          logger.info(`WS server already running on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}, skipping start`);
          return;
      }
      try {
          this.wss = new WebSocket.Server({ port: parseInt(STREAMING_WS_TCP_PORT), host: STREAMING_HOST});
          this.wss.on("connection", (ws, req) => {
              this.onConnection(ws, req);
          });
          this.isRunning = true;
          this.startReaper();
          logger.info(`WS server started on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}`);
      } catch (error) {
          logger.error("Error starting WS server", error);
      }
  }

  async stop() {
      this.stopReaper();
      if (this.wss) {
          this.wss.close();
          this.wss = null;
      }
      this.isRunning = false;
      logger.info("WS server stopped");
  }

  stripStreamPrefix(streamId) {
      const prefix = `${STREAMING_WS_ENDPOINT}/`;

      if (streamId.startsWith(prefix)) {
          return streamId.slice(prefix.length);
      }
      return streamId;
  }

  addRunningSession(session, ws, fd, worker) {
    if (!this.runningSessions[session.id]) {
      this.runningSessions[session.id] = [];
    }

    this.runningSessions[session.id].push({ ws, fd, worker });
    this.runningChannels[fd.channel.id] = { ws, fd, worker };
  }

  stopRunningSession(session) {
    while (this.runningSessions[session.id] && this.runningSessions[session.id].length > 0) {
      const { ws, fd, worker } = this.runningSessions[session.id][0];
      this.cleanupWebsocket(ws, fd, worker);
    }
  }

  async validateStream(req) {
    const streamId = this.stripStreamPrefix(req.url.substring(1))
    logger.info(`Connection: ${req.url} --> Validating streamId ${streamId}`);

      // Extract the session PRIVATE id and channel index from streamId (see ../streamId.js)
      const parsed = parseStreamId(streamId);
      if (!parsed) {
          logger.warn(`Connection: ${req.url} --> malformed streamId ${streamId}, expected <privateId>,<channelIndex>. Rejecting.`);
          return { isValid: false };
      }
      const { privateId, channelIndex } = parsed;
      const session = findSessionByPrivateId(this.sessions, privateId);
      if (!session) {
          logger.warn(`Connection: ${req.url} --> no session with this private id.`);
          return { isValid: false };
      }
      const sessionId = session.id;
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
      const channel = sortedChannels[channelIndex];
      if (!channel) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
          return { isValid: false };
      }
      const channelId = channel.id;

      // Guard against concurrent connection setup for same channel
      if (this.pendingChannels.has(channelId)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} connection already pending. Skipping.`);
          return { isValid: false };
      }

      // Check local state (reliable) instead of cached global state (stale)
      let needsLocalCleanup = false;
      if (this.runningChannels[channelId]) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} already running locally. Will replace existing connection.`);
          needsLocalCleanup = true;
      } else if (channel.streamStatus === 'active') {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} marked active elsewhere (stale cache). Accepting reconnection.`);
      }
      // Check scheduleOn is after now
      const now = new Date();
      if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
          return { isValid: false };
      }
      // Check endOn is before now
      if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
          return { isValid: false };
      }

      logger.info(`Connection: ${req.url} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, session, channel, needsLocalCleanup };
  }

  async onConnection(ws, req) {
      logger.info("Got new connection:", req.url);
      const validation = await this.validateStream(req);
      if (!validation.isValid) {
          logger.warn(`Invalid stream: ${req.url}, voiding connection.`);
          this.cleanupWebsocket(ws, null, null);
          return;
      }

      const { channel, session, needsLocalCleanup } = validation;

      this.pendingChannels.add(channel.id);
      try {
          if (needsLocalCleanup) {
              const existing = this.runningChannels[channel.id];
              if (existing) {
                  logger.warn(`Replacing existing connection for channel ${channel.id}`, {sessionId: session.id, channelId: channel.id});
                  this.cleanupWebsocket(existing.ws, existing.fd, existing.worker);
              }
          }

          const fd = { channel, session };
          let messageCallback = null;

          ws.on("message", (message) => {
              if (!messageCallback) {
                  messageCallback = this.handleInitMessage(ws, message, fd);
                  if (!messageCallback) {
                      this.cleanupWebsocket(ws);
                  }
              } else {
                  messageCallback(message);
              }
          });
      } finally {
          this.pendingChannels.delete(channel.id);
      }
  }

  handleInitMessage(ws, message, fd) {
    let initMessage;
    try {
        initMessage = JSON.parse(message);
    } catch (error) {
        logger.warn('Invalid JSON init message', error);
        ws.send(JSON.stringify({ type: 'error', message: `Invalid JSON init message: ${error}.` }));
        return null;
    }

    if (initMessage.type === 'init') {
        logger.info(`Received configuration: sampleRate=${initMessage.sampleRate}, encoding=${initMessage.encoding}, diarizationMode=${initMessage.diarizationMode || 'asr'}`);

        if(initMessage.encoding == 'pcm' && initMessage.sampleRate != 16000) {
            logger.warn(`Invalid sample rate: ${initMessage.sampleRate}`);
            ws.send(JSON.stringify({ type: 'error', message: `Invalid sample rate: ${initMessage.sampleRate}. Only 16000 is accepted.` }));
            return null
        }

        // Native diarization (bot streams): set up the SpeakerTracker BEFORE
        // initPcm() emits 'session-start', so the StreamingServer can hand it to
        // the ASR as it is created. Must run before the callback is built.
        fd.diarizationMode = initMessage.diarizationMode || 'asr';
        const trackerKey = `${fd.session.id}_${fd.channel.id}`;
        // Per-stream diarization is negotiated: the bot REQUESTS it (init.perStream)
        // and the Transcriber ACCEPTS only when its env flag is on. The bot honors
        // the ACK, so off-by-either-side falls back to the legacy mixed path
        // bit-exact. In perStream mode we do NOT build the legacy SpeakerTracker:
        // the speaker IS the participant identity carried by the tagged frames.
        // K2 fail-closed: a channel that must be archived (keepAudio) can only go
        // per-stream when the bot also ships the MIXED recording flow (magic
        // 0x02) — N sub-ASR cannot each own the single per-channel .pcm. An older
        // bot that cannot mix is DEMOTED to the legacy mixed path (correct
        // archive, degraded speaker attribution) rather than handed a corrupted
        // one. The WARN below is deliberately loud: without it the demotion is
        // diagnosed as "per-stream broke".
        // K10 fail-closed on the TRANSPORT too: the tagged demux (0x01 frames ->
        // the 5-arg 'data', 0x02 -> 'record-data') exists ONLY on the initPcm
        // callback below. A non-pcm init goes through initWorker, whose GStreamer
        // worker emits the legacy 3-arg 'data' — so granting per-stream there
        // ACKed `perStream:true`, made getStreamParticipants() non-null and sent
        // the StreamingServer down its per-stream session-start branch (which
        // creates NO ASR), while every transcoded frame arrived untagged and hit
        // "No ASR found": zero captions for the whole session. Demote instead,
        // exactly like the keepAudio gate below.
        const perStreamReq = initMessage.perStream === true;
        const perStreamEnabled = process.env.TRANSCRIBER_PERSTREAM_DIARIZATION === 'true';
        const pcmIngest = initMessage.encoding === 'pcm';
        const needsRecording = !!fd.channel.keepAudio;   // exactly ASR.init()'s own gate
        const botCanMix = initMessage.mixedRecording === true;
        fd.perStream = perStreamReq && perStreamEnabled && pcmIngest && (!needsRecording || botCanMix);
        fd.mixedRecording = fd.perStream && needsRecording;
        if (perStreamReq && perStreamEnabled && !pcmIngest) {
            logger.warn(`Per-stream diarization DEMOTED to the legacy mixed path for session ${fd.session.id}, channel ${fd.channel.id}: per-stream framing requires encoding='pcm' (got '${initMessage.encoding}'), the transcoding worker path cannot carry tagged frames.`);
        }
        if (perStreamReq && perStreamEnabled && pcmIngest && needsRecording && !botCanMix) {
            logger.warn(`Per-stream diarization DEMOTED to the legacy mixed path for session ${fd.session.id}, channel ${fd.channel.id}: the channel keeps its audio (keepAudio) but the bot does not advertise mixedRecording. Upgrade the bot to restore per-participant speaker attribution.`);
        }
        if (fd.perStream) {
            const m = new Map();
            for (const p of (initMessage.participants || [])) {
                if (p.tag !== undefined) m.set(p.tag, p);
            }
            this.streamParticipants.set(trackerKey, m);
            logger.info(`Per-stream diarization enabled for session ${fd.session.id}, channel ${fd.channel.id} (${m.size} initial participants: ${[...m.values()].map(p => `${p.tag}=${p.name || p.id}`).join(', ')}, mixedRecording=${fd.mixedRecording})`);
        } else if (fd.diarizationMode === 'native') {
            const tracker = new SpeakerTracker();
            for (const participant of (initMessage.participants || [])) {
                tracker.updateParticipant({ action: 'join', participant });
            }
            this.speakerTrackers.set(trackerKey, tracker);
            logger.info(`Native diarization enabled for session ${fd.session.id}, channel ${fd.channel.id} (${(initMessage.participants || []).length} initial participants)`);
        }

        // Any failure AFTER the tracker is registered must drop it, otherwise the
        // entry leaks: cleanupWebsocket only runs for callbacks it was given an
        // fd for, and the null-return path in onConnection calls it without fd.
        let callback;
        try {
            callback = initMessage.encoding == 'pcm' ? this.initPcm(ws, fd) : this.initWorker(ws, fd);
        } catch (error) {
            logger.error(`Init failed for session ${fd.session.id}, channel ${fd.channel.id}`, error);
            this.speakerTrackers.delete(trackerKey);
            this.streamParticipants.delete(trackerKey);
            ws.send(JSON.stringify({ type: 'error', message: `Init failed: ${error}.` }));
            return null;
        }
        if (!callback) {
            this.speakerTrackers.delete(trackerKey);
            this.streamParticipants.delete(trackerKey);
            return null;
        }

        // Negotiated ACK: the bot honours the GRANT, never its own request. It
        // reads `perStream` to decide whether to tag its frames and
        // `mixedRecording` to decide whether to ALSO ship the 0x02 mixed flow.
        // fd.perStream is false unless BOTH the bot requested it AND the env flag
        // is on (AND the archive can be produced), so a default-off deployment
        // ACKs perStream:false and the bot keeps mixing (legacy bit-exact).
        ws.send(JSON.stringify({
            type: 'ack',
            message: 'Init done',
            perStream: fd.perStream,
            mixedRecording: fd.mixedRecording,
        }));

        return callback;
    } else {
        logger.warn('Invalid init message type');
        ws.send(JSON.stringify({ type: 'error', message: `Invalid init message type: ${initMessage.type}. It must be 'init'` }));
        return null;
    }
  }

  initPcm(ws, fd) {
      this.emit('session-start', fd.session, fd.channel);
      this.addRunningSession(fd.session, ws, fd, null);
      ws.on("close", () => {
          logger.info(`Connection: ${ws} --> closed`);
          this.cleanupWebsocket(ws, fd);
      });
      ws.on("error", () => {
          logger.error(`Connection: ${ws} --> error`);
          this.cleanupWebsocket(ws, fd);
      });
      return (message) => {
          // A bot stream interleaves binary PCM with JSON control messages
          // (speakerChanged / participant) for native diarization. Distinguish
          // them robustly: only treat a frame as control if it both *looks* like
          // JSON ({") and parses to a recognized control type; otherwise it is
          // PCM (a PCM sample can coincidentally start with 0x7B 0x22, so a parse
          // failure must fall through to audio rather than drop the frame).
          if (this.handleControlMessage(fd, message)) return;
          if (fd.perStream) {
              // Per-stream mode: audio arrives as tagged binary frames
              // (0x01 | tag | reserved | meetingTimeMs | PCM). Demux to a
              // 5-arg 'data' carrying the participant tag and the meeting clock.
              // The bot's MIXED recording flow (0x02) is a separate stream that
              // must never reach the tag/cap/lazy-create logic: it goes to
              // 'record-data' and is only ever written to the channel archive.
              if (Buffer.isBuffer(message) && message[0] === MAGIC_MIXED) {
                  const mixed = this._parseMixedFrame(message);
                  if (!mixed) return; // short/invalid frame -> drop
                  this.emit('record-data', mixed.pcm, fd.session.id, fd.channel.id);
                  return;
              }
              const parsed = this._parseTaggedFrame(message);
              if (!parsed) return; // short/invalid frame -> drop
              this.emit('data', parsed.pcm, fd.session.id, fd.channel.id, parsed.tag, parsed.tMs);
              return;
          }
          this.emit('data', message, fd.session.id, fd.channel.id); // legacy 3 args, unchanged
      };
  }

  // Parse a per-stream tagged audio frame. Layout (little-endian):
  //   off0  u8  MAGIC = 0x01  (never 0x7B '{', so it cannot collide with a JSON
  //                            control message)
  //   off1  u8  participantTag 0..254 (255 = mixed/overflow fallback)
  //   off2  u16 reserved = 0  (keeps the PCM 16-bit aligned)
  //   off4  u32 meetingTimeMs (bot-relative clock)
  //   off8  N   PCM s16le mono 16k
  // Returns {tag, tMs, pcm} or null when the frame is not a valid tagged frame.
  // `tMs` IS consumed (C2): the bot VAD-gates a participant's stream, so what a
  // sub-ASR hears is speech bursts spliced end to end and every provider offset
  // is relative to that spliced clock. The ASR builds a piecewise audio->meeting
  // map out of these per-frame stamps and rebases start/end at publication.
  _parseTaggedFrame(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 8 || buf[0] !== MAGIC_TAGGED) return null;
      return { tag: buf[1], tMs: buf.readUInt32LE(4), pcm: buf.subarray(8) };
  }

  // Parse a mixed-recording frame (K2). Same 8-byte header as the tagged frame
  // with MAGIC = 0x02 and byte 1 always 0 (no participant: this IS the mix), so
  // a single decoder shape covers both. Returns {tMs, pcm} or null.
  _parseMixedFrame(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 8 || buf[0] !== MAGIC_MIXED) return null;
      return { tMs: buf.readUInt32LE(4), pcm: buf.subarray(8) };
  }

  // Returns true if the message was consumed as a native-diarization control
  // message, false if it should be treated as audio data.
  handleControlMessage(fd, message) {
      if (!fd.perStream && fd.diarizationMode !== 'native') return false;
      if (!Buffer.isBuffer(message) || message.length < 2) return false;
      if (message[0] !== 0x7B || message[1] !== 0x22) return false; // not '{"'
      let data;
      try {
          data = JSON.parse(message.toString());
      } catch (e) {
          // PCM that merely started with 0x7B22. Logged at debug only: this fires
          // legitimately on audio whose first sample coincides with '{"', so it is
          // not necessarily an error — but it is useful when localizing why a
          // control message went missing.
          logger.debug(`Native diarization: '{\"'-prefixed frame failed to parse as JSON, treating as PCM (session ${fd.session.id}, channel ${fd.channel.id})`);
          return false; // PCM that merely started with 0x7B22
      }
      // Per-stream (D3b late-joiner): route participant join/leave into the
      // tag->participant map so a guest who arrives after `init` still gets a
      // tag->{id,name} mapping; otherwise their lazily-created ASR would carry
      // participantId=null -> locutor=null. Never fall back to the SpeakerTracker.
      if (fd.perStream) {
          const m = this.streamParticipants.get(`${fd.session.id}_${fd.channel.id}`);
          if (!m) {
              logger.warn(`Per-stream: dropping control message type '${data.type}' — no participant map for session ${fd.session.id}, channel ${fd.channel.id}`);
              return false;
          }
          if (data.type === 'participant') {
              // The bot nests the participant under `participant` for join/leave
              // but the rename control carries id/name/tag at the top level; read
              // both shapes so either form works.
              const p = data.participant || {};
              const tag = (p.tag !== undefined) ? p.tag : data.tag;
              if (tag !== undefined) {
                  if (data.action === 'leave') {
                      const existing = m.get(tag);
                      if (existing) existing.active = false; // mark inactive, keep mapping for trailing finals
                      // Free the participant's ASR cap slot (#5): a dead sub-ASR
                      // would otherwise keep counting and push present speakers
                      // into overflow. StreamingServer tears it down.
                      this.emit('participant-leave', fd.session.id, fd.channel.id, tag);
                  } else if (data.action === 'rename') {
                      // Mid-call rename (#7): update the stored identity (used for
                      // any not-yet-created ASR) and signal StreamingServer to
                      // update the live sub-ASR so its next captions carry it.
                      const name = (p.name !== undefined) ? p.name : data.name;
                      const id = (p.id !== undefined) ? p.id : data.id;
                      const existing = m.get(tag);
                      if (existing) {
                          existing.name = name;
                          if (id !== undefined) existing.id = id;
                      } else {
                          m.set(tag, { ...p, tag, name, ...(id !== undefined ? { id } : {}) });
                      }
                      this.emit('participant-rename', fd.session.id, fd.channel.id, tag, name, id);
                  } else {
                      const joined = (p.tag !== undefined) ? p : { ...data };
                      m.set(tag, joined);
                      // K6: a `join` can land AFTER the participant's first tagged
                      // frame already lazily created their sub-ASR — which was then
                      // built with an EMPTY participant (id and name null), leaving
                      // every one of their captions unattributed for the whole call.
                      // Updating the map alone never re-keys that live ASR, so emit
                      // the same identity-update signal as a rename (a no-op when
                      // no sub-ASR exists yet: the map above already carries the
                      // identity for lazy creation).
                      this.emit('participant-rename', fd.session.id, fd.channel.id, tag, joined.name, joined.id);
                  }
              }
              return true;
          }
          // speakerChanged is meaningless per-stream (the identity IS the stream); consume it.
          if (data.type === 'speakerChanged') return true;
          logger.warn(`Per-stream: dropping control message with unknown type '${data.type}' (session ${fd.session.id}, channel ${fd.channel.id})`);
          return false;
      }
      // Past this point the frame is a well-formed JSON control message; dropping
      // it silently would hide a real diarization problem, so warn.
      const tracker = this.speakerTrackers.get(`${fd.session.id}_${fd.channel.id}`);
      if (!tracker) {
          logger.warn(`Native diarization: dropping control message type '${data.type}' — no SpeakerTracker for session ${fd.session.id}, channel ${fd.channel.id}`);
          return false;
      }
      if (data.type === 'speakerChanged') {
          tracker.addSpeakerChange(data);
          return true;
      }
      if (data.type === 'participant') {
          tracker.updateParticipant(data);
          return true;
      }
      logger.warn(`Native diarization: dropping control message with unknown type '${data.type}' (session ${fd.session.id}, channel ${fd.channel.id})`);
      return false;
  }

  getSpeakerTracker(sessionId, channelId) {
      return this.speakerTrackers.get(`${sessionId}_${channelId}`) || null;
  }

  // Per-stream twin of getSpeakerTracker: the StreamingServer reads this on
  // session-start to detect per-stream mode and to resolve a tag -> {id,name}
  // when it lazily creates a sub-ASR. null/absent for legacy streams.
  getStreamParticipants(sessionId, channelId) {
      return this.streamParticipants.get(`${sessionId}_${channelId}`) || null;
  }

  initWorker(ws, fd) {
      // Start a new worker for this connection
      const worker = fork(path.join(__dirname, '../GstreamerWorker.js'), [], {
      });
      this.workers.push(worker);
      // Start gstreamer pipeline
      worker.send({ type: 'init' });


      // handle events
      this.handleWorkerEvents(ws, fd, worker);

      ws.on("close", () => {
          logger.info(`Connection: ${ws} --> closed`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });
      ws.on("error", () => {
          logger.error(`Connection: ${ws} --> error`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });

      // Acknowledge session for streaming server controller to handle further processing
      // - call scheduler to update session status to active
      // - start buffering audio in circular buffer
      // - start transcription
      this.emit('session-start', fd.session, fd.channel);
      this.addRunningSession(fd.session, ws, fd, worker);

      return (message) => {
          worker.send({ type: 'buffer', chunks: Buffer.from(new Int16Array(message))});
      };
  }

  // Events sent by the worker
  handleWorkerEvents(ws, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', message.buf, fd.session.id, fd.channel.id);
          }
          if (message.type === 'error') {
              logger.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupWebsocket(ws, fd, worker);
          }
          if (message.type === 'playing') {
              logger.info(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channel.id}`);
          }
      });

      worker.on('error', (err) => {
          logger.error(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupWebsocket(ws, fd, worker);
      });

      worker.on('exit', (code, signal) => {
          logger.info(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channel.id}`);
          this.cleanupWebsocket(ws, fd, worker);
      });
  }

  // S1: cleanup is keyed on the CONNECTION, not only on the channel id. A
  // replaced connection (see "Will replace existing connection" in
  // validateStream) is closed synchronously by onConnection, but its OWN
  // ws.on('close') fires later — by then the successor has already re-registered
  // the channel. Running the channel-keyed cleanup for that stale connection
  // would emit a spurious 'session-stop' (tearing the SUCCESSOR's ASR down) and
  // delete the successor's runningChannels / speakerTracker / participant-map
  // entries, leaving a live socket whose frames find no state at all. So only
  // the connection that currently OWNS the channel may touch channel-keyed
  // state. Every connection still removes its own runningSessions entry, matched
  // BY IDENTITY — which also keeps stopRunningSession's while-loop finite when
  // two entries share a channel id.
  cleanupWebsocket(ws, fd, worker) {
      // Captured before the `ws = null` below, which would otherwise erase the
      // identity we compare against.
      const conn = ws;
      const owner = fd ? this.runningChannels[fd.channel.id] : null;
      const superseded = !!(owner && conn && owner.ws !== conn);
      if (superseded) {
        logger.warn(`Connection for channel ${fd.channel.id} was replaced; skipping channel-keyed cleanup (the successor owns it now)`);
      }

      // K10: teardown is IDEMPOTENT PER CONNECTION. `fd` is minted once per
      // connection in onConnection and is never shared with a successor, so it
      // is the only teardown identity there is — 'session-stop' is a CHANNEL
      // event, and _stopAsr, which receives just (session, channelId), cannot
      // tell a duplicate stop from a legitimate successor stop.
      // One connection reaches this function several times:
      //   - an abnormal socket close fires 'error' AND 'close', both wired to
      //     cleanupWebsocket (initPcm/initWorker);
      //   - the transcoding path adds the worker's own 'error'/'exit';
      //   - a REPLACED connection is cleaned by onConnection and again by its
      //     own late 'close'.
      // `superseded` cannot catch any of those: it is read from runningChannels,
      // which the FIRST pass already deleted, so the second pass saw no owner,
      // concluded it was not superseded and emitted a SECOND 'session-stop' —
      // this time against the SUCCESSOR's state. On a per-stream channel that
      // second stop lands inside the first one's multi-second flush window and
      // is destructive: it deletes the successor's channel context (every later
      // tagged frame then hits "no channel context"), or tears the successor's
      // legacy ASR down, and it steals the outgoing stop's end-of-stream marker,
      // deactivate and segment-id cursor.
      // The latch is set on EVERY pass that owns an fd, superseded or not: once
      // a connection has been cleaned up it is dead, and it must never publish a
      // stop for a channel somebody else may already own.
      // Armed BEFORE the emit, never after: a listener that throws synchronously
      // would otherwise unwind past the assignment and leave the connection free
      // to emit a second stop on its next cleanup pass — the exact duplicate
      // this latch exists to prevent.
      if (fd && !superseded && !fd.stopEmitted) {
        fd.stopEmitted = true;
        this.emit('session-stop', fd.session, fd.channel.id)
      }
      if (fd) fd.stopEmitted = true;

      logger.info(`Connection: ${ws} --> cleaning up.`);
      if (ws) {
        if (ws.clients) {
          ws.clients.forEach(client => client.close());
        }
          ws.close();
          ws = null;
      }
      if (worker) {
          worker.kill();
          const workerIndex = this.workers.indexOf(worker);
          if (workerIndex > -1) {
              this.workers.splice(workerIndex, 1);
          }
      }

      if (fd && this.runningSessions[fd.session.id]) {
          // Identity-keyed (S1): drop THIS connection's entry only. With the
          // normal one-connection-per-channel case this is exactly the former
          // channel-id filter; during a replace it leaves the successor's entry
          // alone. `conn` is falsy only for callers that pass no socket, which
          // then fall back to the original channel-id match.
          const isSelf = conn
            ? (item => item.ws === conn)
            : (item => item.fd.channel.id === fd.channel.id);
          this.runningSessions[fd.session.id] = this.runningSessions[fd.session.id].filter(item => !isSelf(item));
          if (this.runningSessions[fd.session.id].length === 0) {
              delete this.runningSessions[fd.session.id];
          }
      }
      if (fd && !superseded && this.runningChannels[fd.channel.id]) {
          delete this.runningChannels[fd.channel.id];
      }
      if (fd && !superseded) {
          // Drop the map reference (a reconnect gets a fresh tracker) but do NOT
          // clear() it synchronously: session-stop triggers an async ASR flush
          // (flushFinals) whose trailing finals still read this tracker to stamp
          // their speaker. The ASR holds the reference; GC reclaims it after dispose.
          this.speakerTrackers.delete(`${fd.session.id}_${fd.channel.id}`);
          // Symmetric cleanup of the per-stream participant map (twin of above).
          this.streamParticipants.delete(`${fd.session.id}_${fd.channel.id}`);
      }
  }
}


module.exports = MultiplexedWebsocketServer;
