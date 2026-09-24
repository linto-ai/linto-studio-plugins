const eventEmitter = require('eventemitter3');
const path = require('path');
const fs = require('fs');
const { CircularBuffer } = require("live-srt-lib");
const logger = require('../logger')
const ffmpeg = require('fluent-ffmpeg');
const ASR_ERROR = require('./error.js');
const FakeTranscriber = require('./fake/index.js');
const { Security } = require("live-srt-lib");
const REDACTED = '[REDACTED]';


function loadAsr(provider) {
  const asrPath = path.join(__dirname, provider, 'index.js');
  if (!fs.existsSync(asrPath)) {
    throw new Error(`No ASR named '${provider}' in '${asrPath}'`);
  }
  const AsrClass = require(asrPath);
  return AsrClass;
}


class ASR extends eventEmitter {
  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error',
    CLOSED: 'closed',
    TRANSCRIBING: 'transcribing'
  };

  constructor(session, channel, options = {}) {
    super();
    this.session = session;
    this.channel = channel;
    this.logger = logger.getChannelLogger(this.session.id, this.channel.id);
    this.provider = null;
    this.state = ASR.states.CLOSED;
    // K2 recording split. In per-stream mode N sub-ASR share ONE channel, hence
    // ONE `${session}-${channel}.pcm` path: letting each of them own a write
    // stream interleaves their audio and races on transcode/unlink at dispose.
    // So recording becomes a dedicated responsibility:
    //   record     — false on every per-stream sub-ASR (they never touch the file)
    //   recordOnly — true on the single per-channel recorder ASR: it archives the
    //                bot's mixed flow and runs a FakeTranscriber (no ASR cost).
    // Both default to the legacy values, so a legacy ASR is bit-exact.
    this.record = options.record !== false;
    this.recordOnly = options.recordOnly === true;
    this.segmentId = options.initialSegmentId || 1;
    // Segment the most recent primary final/partial was assigned to. Used to
    // align dual-mode secondary (translation-only) results onto the same
    // segment as the primary that produced the source text. Before any primary
    // result, secondary results fall back to the current segmentId.
    this._lastPrimarySegmentId = this.segmentId;
    // Native diarization (bot streams): when a SpeakerTracker is provided, the
    // speaker label comes from the meeting (per-participant SFU tracks / Teams
    // page state) instead of the ASR provider. null for ordinary streams.
    this.speakerTracker = options.speakerTracker || null;
    this.diarizationMode = options.diarizationMode || 'asr';
    // Per-stream diarization: this ASR decodes a single participant's stream, so
    // the speaker IS that participant — no SpeakerTracker guessing. When set,
    // _applyNativeSpeaker short-circuits to participantName. null for legacy.
    this.participantId = options.participantId || null;
    this.participantName = options.participantName || null;
    // Shared per-channel segmentId allocator (perStream): all the sub-ASR of a
    // channel draw monotonic, collision-free ids from {next}. When null (legacy),
    // segmentId advances per-instance exactly as before (bit-exact).
    this.segmentAllocator = options.segmentAllocator || null;
    // Per-stream: seed this ASR's first segmentId from the shared allocator so
    // two sibling ASR never start on the same id (which would collide on the
    // first utterance). Subsequent advances also draw from it (_advanceSegmentId).
    if (this.segmentAllocator) {
      this.segmentId = this.segmentAllocator.next++;
      this._lastPrimarySegmentId = this.segmentId;
    }
    // Previous PRIMARY final's segment, cleared one final late so a lagging
    // dual-recognizer secondary (translation) can still read the segment's speaker.
    this._prevFinalSegmentId = null;
    this.paused = false;
    this._flushed = false;
    // C2 per-stream timeline map. In per-stream mode the bot only ships frames
    // while its participant speaks (VAD gate), so what the provider hears is
    // speech bursts spliced end to end and every timestamp it returns is
    // relative to that SPLICED audio clock, not to the meeting clock. The map
    // is built lazily from the per-frame meetingTimeMs the WS demux forwards to
    // transcribe(); it stays null for every legacy caller (3-arg emit, SRT,
    // RTMP), and with no map publication is byte-for-byte unchanged.
    //
    // What the map publishes is NOT a meeting-ABSOLUTE offset: it is seeded at
    // this ASR's FIRST frame (cumulativeGapMs starts at 0 and that frame's
    // absolute meetingTimeMs is deliberately discarded), so an offset stays
    // anchored on this ASR's own `astart`, exactly like every legacy caption —
    // the map only removes the VAD-elided silence from INSIDE this stream. The
    // meeting-wide anchoring is done downstream by Session-API's
    // `(astart - MIN(astart)) + start` rebase.
    this.timeline = null;
    // A SHARED sub-ASR (the per-channel overflow bucket) is fed by several
    // participants at once, so the meetingTimeMs of its incoming frames
    // interleaves and routinely goes backwards: no single audio->meeting map
    // exists for it. It must therefore never build one — otherwise every frame
    // looks like a bot restart / u32 wrap to _noteMeetingTime, which disables
    // the map and logs a misleading WARN at frame rate. Overflow attribution is
    // an accepted degraded mode (see StreamingServer._getOrCreatePerStreamAsr),
    // and so is its identity timeline.
    this.sharedStream = options.sharedStream === true;
    // C8: allocate the audio buffer HERE, not in the async init(). Per-stream
    // creates a sub-ASR and calls transcribe() on it in the SAME tick (the WS
    // 'data' handler lazily creates then feeds), while init() only runs on the
    // next microtask — so the very first frame of every participant hit
    // `this.audioBuffer.add()` with audioBuffer still undefined, threw, and was
    // swallowed by the handler's try/catch. Buffering it here loses nothing:
    // state stays CLOSED until init(), so transcribe() still forwards nothing to
    // a provider that does not exist yet, and the frame is forwarded with the
    // rest once the provider is READY. init() keeps the buffer it finds so those
    // early frames are never discarded.
    this.audioBuffer = new CircularBuffer();
    this._transitionLock = Promise.resolve();
    // Chain init() into the transition lock so any pause()/resume() queued
    // right after construction runs *after* init() has set up provider/state.
    this._chainTransition(() => this.init());
  }

  // Append `fn` to the serialized transition chain. The .catch(()=>{}) guard
  // ensures a previous transition's rejection (sync throw, missed error in fn)
  // never breaks the chain — every queued pause()/resume()/dispose() still runs.
  _chainTransition(fn) {
    this._transitionLock = this._transitionLock.catch(() => {}).then(fn);
    return this._transitionLock;
  }

  async pause() {
    return this._chainTransition(async () => {
      if (this.paused) return;
      this.paused = true;
      if (this.audioBuffer) {
        this.audioBuffer.flush();
      }
      // C2: the buffered-but-not-yet-forwarded audio is dropped by that flush,
      // so it must not count as audio the provider will ever hear. The
      // breakpoints recorded at `audioMs + pendingMs` inside that dropped window
      // are now unreachable positions; they are not patched here because resume()
      // drops the whole map anyway (see below), and a pause with no resume ends
      // in dispose().
      if (this.timeline) this.timeline.pendingMs = 0;
      if (this.provider && (this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING || this.state === ASR.states.CONNECTING)) {
        try {
          await this.provider.stop();
        } catch (e) {
          this.logger.warn(`ASR pause: provider.stop() error: ${e.message}`);
        }
      }
      // Set state synchronously after stop() so external readers don't see
      // state=READY during the (potentially long, on Amazon) interval between
      // provider.stop() returning and the asynchronous 'closed' event firing.
      // The provider's own 'closed' handler will still set state=CLOSED later;
      // this is a no-op convergence for the live path and a safety net for
      // providers whose stop() does not emit closed (or emits it racily).
      this.state = ASR.states.CLOSED;
      this.logger.info(`ASR paused for session=${this.session?.id} channel=${this.channel?.id}`);
    });
  }

  async resume() {
    return this._chainTransition(async () => {
      if (!this.paused) return;
      this.paused = false;
      if (this.audioBuffer) {
        this.audioBuffer.flush();
      }
      // C2: provider.start() below opens a NEW provider session — it resets
      // `startedAt` (every provider does, so the captions of the resumed stream
      // carry a fresh `astart`) and its result timestamps restart from 0 on a
      // fresh audio clock. The map is anchored on the PREVIOUS session's clock,
      // so keeping it would (a) make _gapAt() read positions of audio the new
      // provider session never heard and (b) charge the whole pause duration as
      // an elided gap to a caption whose astart has ALREADY moved past it —
      // double-counting the pause on every subsequent caption. Drop it: the next
      // frame reseeds a fresh map from this session's first meetingTimeMs,
      // exactly as at the sub-ASR's own start.
      this.timeline = null;
      this.state = ASR.states.CONNECTING;
      if (this.provider) {
        try {
          await this.provider.start();
        } catch (e) {
          this.logger.error(`ASR resume: provider.start() error: ${e.message}`);
          this.state = ASR.states.ERROR;
        }
      }
      this.logger.info(`ASR resumed for session=${this.session?.id} channel=${this.channel?.id}`);
    });
  }

  async init() {
    // identifies the transcriber profile for the channel channel.id in the session channels array
    try {
      const channel = this.channel

      // K2: only a recording-owning ASR opens the (single, per-channel) .pcm —
      // legacy ASR keep record=true so this is the original gate.
      if (channel.keepAudio && this.record) {
        const audioFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
        this.audioFile = fs.createWriteStream(audioFilePath);
      }
      // C8: keep the buffer allocated by the constructor (it may already hold
      // the first frames); only (re)allocate if something cleared it.
      if (!this.audioBuffer) {
        this.audioBuffer = new CircularBuffer();
      }

      // FakeTranscriber when this ASR only archives audio (K2 recorder), when
      // live transcripts are off, or when no profile is set (audio-only).
      const hasProfile = !!(channel.transcriberProfile && channel.transcriberProfile.config);
      if (this.recordOnly || !this.channel.enableLiveTranscripts || !hasProfile) {
        this.provider = new FakeTranscriber(this.session, channel);
        this.logger.info(this.recordOnly
          ? "ASR started with FakeTranscriber (mixed-recording only, no transcription)"
          : "ASR started with FakeTranscriber");
      }
      else {
        this.logger.info(`Starting ${channel.transcriberProfile.config.type} ASR`);
        const backend = loadAsr(channel.transcriberProfile.config.type);
        this.provider = new backend(this.session, this._providerChannel());
      }
      this.state = ASR.states.CONNECTING;
      this.handleASREvents();
      await this.provider.start();
    } catch (error) {
      this.logger.error(this._redactSecrets(error));
      this.state = ASR.states.ERROR;
      this.emit('error', error);
    }
  }

  // Whether the speaker label comes from the meeting rather than from the ASR
  // provider: mixed native diarization (bot-fed SpeakerTracker) or per-stream
  // (one sub-ASR per participant, identified by the shared segment allocator
  // and/or a known participant id/name — K6 can leave id and name null at
  // construction, the allocator is always there). In both cases
  // _applyNativeSpeaker overwrites the provider's locutor on every result.
  _speakerFromMeeting() {
    if (this.participantId || this.participantName || this.segmentAllocator) return true;
    return this.diarizationMode === 'native' && !!this.speakerTracker;
  }

  // Channel handed to the provider. When the speaker comes from the meeting,
  // provider-side diarization is pointless (its label is overwritten) and, on
  // Microsoft with translations, harmful: diarization + translation selects the
  // DUAL mode (ConversationTranscriber + TranslationRecognizer) whose two
  // recognizers segment the audio independently. On overlapping speech the
  // primary cuts per voice while the secondary keeps one A+B utterance, so its
  // translation lands on the last primary segment and bleeds into the next one
  // (duplicated translations). Forcing diarization off yields ONE recognizer
  // (a TranslationRecognizer when translations are set) whose results carry
  // the original text AND the translations together, hence one segmentId.
  // Shallow copy: the session/channel object itself is never mutated. Legacy
  // (non-bot) channels get the original object, byte-for-byte.
  _providerChannel() {
    const channel = this.channel;
    if (channel && channel.diarization && this._speakerFromMeeting()) {
      this.logger.info('Speaker comes from the meeting: provider diarization disabled (single recognizer)');
      return { ...channel, diarization: false };
    }
    return channel;
  }

  // Resolve the segmentId a result belongs to. Primary (or untagged) results
  // own the current segmentId and update _lastPrimarySegmentId so the dual-mode
  // secondary can rejoin them: a secondary (isPrimary===false) result is pinned
  // to the segment the latest primary produced, never the next one. This keeps
  // a translation aligned with its source even though the primary final
  // advances segmentId immediately after emitting.
  _segmentIdFor(transcription) {
    if (transcription.isPrimary === false) {
      return this._lastPrimarySegmentId;
    }
    this._lastPrimarySegmentId = this.segmentId;
    return this.segmentId;
  }

  // Advance to the next segmentId after a primary final/error. Per-stream draws
  // the next id from the SHARED per-channel allocator so ids stay globally
  // monotone and collision-free across the sibling ASR of the same channel
  // (each ASR's first id is seeded from the same allocator in the constructor).
  // _lastPrimarySegmentId stays PER INSTANCE (in _segmentIdFor) so a lagging
  // secondary (translation) of THIS ASR still pins the id THIS ASR produced even
  // if a sibling consumed the next id meanwhile. Drawing happens here (once per
  // utterance), NOT in _segmentIdFor, so the many partials of an utterance keep
  // the same id as its final. Legacy (allocator null) is the original `++`,
  // byte-for-byte.
  _advanceSegmentId() {
    if (this.segmentAllocator) {
      this.segmentId = this.segmentAllocator.next++;
    } else {
      this.segmentId++;
    }
  }

  // Native diarization: stamp the segment's speaker from the bot-fed
  // SpeakerTracker, overriding any provider-supplied locutor. The display name
  // is preferred (real meeting participant) and falls back to the id. No-op for
  // ordinary (non-bot) streams where speakerTracker is null.
  _applyNativeSpeaker(transcription, isFinal = false) {
    // Per-stream: this ASR decodes exactly one participant's stream, so the
    // speaker IS that participant — assign it directly and skip the
    // SpeakerTracker guessing path entirely. We may know the participant by id
    // and/or by name (a rename can create a name-only entry), so gate on EITHER:
    // a named-but-idless participant must still be attributed, not fall through
    // to the provider's guessing. This short-circuit runs before any tracker.
    if (this.participantId || this.participantName) {
      transcription.locutor = this.participantName || this.participantId;
      // Also expose the STABLE participant id (LiveKit identity for the native
      // visio bot) when known, so a downstream consumer can attribute the
      // caption without a display-name lookup (names can collide).
      if (this.participantId) transcription.participantId = this.participantId;
      return;
    }
    if (this.diarizationMode !== 'native' || !this.speakerTracker) return;
    // Only the canonical PRIMARY result owns the assignment; a dual-recognizer
    // secondary (isPrimary===false) reads it read-only so it inherits the
    // primary's speaker instead of re-deriving it from the (possibly changed)
    // current speaker. A primary partial opens/refreshes the segment (its label
    // follows the current speaker); a primary final closes it on the speaker
    // with the most speaking time during the segment.
    if (transcription.isPrimary !== false) {
      this.speakerTracker.assignSpeakerToSegment(transcription.segmentId);
      if (isFinal && typeof this.speakerTracker.finalizeSegment === 'function') {
        this.speakerTracker.finalizeSegment(transcription.segmentId);
      }
    }
    const speaker = this.speakerTracker.getSpeakerForSegment(transcription.segmentId);
    if (speaker) {
      transcription.locutor = speaker.name || speaker.id;
      // Mixed mode: the SpeakerTracker's `id` is the bot-fed participant id
      // (LiveKit identity for the native visio bot).
      if (speaker.id) transcription.participantId = speaker.id;
    }
  }

  // ---------------------------------------------------------------------------
  // C2 — per-stream audio-clock -> meeting-clock map.
  //
  // The VAD gate on the bot means a sub-ASR only ever receives speech bursts,
  // spliced end to end. Provider timestamps are relative to THAT audio, so the
  // second burst of a conversation is reported as if it started right after the
  // first, however long the silence between them was. We keep a piecewise map
  // built from the meetingTimeMs carried by every tagged frame: each elided
  // interval is recorded as a breakpoint {audioMs, gapMs} and, at publication
  // time, the cumulative gap in force at a result's audio position is added back
  // to its start/end. The map is per sub-ASR and only exists once a caller
  // passes a meetingTimeMs, so legacy publication is untouched.
  // ---------------------------------------------------------------------------

  // Duration in ms of `bytes` of the ingest PCM format (16 kHz mono s16le).
  _bytesToMs(bytes) {
    const sampleRate = parseInt(process.env.SAMPLE_RATE, 10) || 16000;
    const bytesPerSample = parseInt(process.env.BYTES_PER_SAMPLE, 10) || 2;
    return (bytes / (sampleRate * bytesPerSample)) * 1000;
  }

  // Account for one incoming frame: detect the silence the bot elided between
  // the previous frame and this one and record it as a breakpoint at the audio
  // position the frame will occupy. A backwards meetingTimeMs (bot restart, u32
  // wrap) can only produce a negative gap, so the map is abandoned in favour of
  // the identity mapping — once, with a loud WARN.
  _noteMeetingTime(meetingTimeMs, byteLength) {
    // The provider may have opened a NEW session behind the wrapper's back
    // (see _syncProviderEpoch): reseed before touching the map.
    this._syncProviderEpoch();
    const t = this.timeline || (this.timeline = {
      audioMs: 0,          // audio ACTUALLY forwarded to the provider
      pendingMs: 0,        // buffered, not yet forwarded (dropped on pause)
      lastMeetingMs: null,
      lastFrameMs: 0,
      cumulativeGapMs: 0,
      breaks: [],
      disabled: false,
      providerStartedAt: null,   // the provider session this map is anchored on
    });
    // Bind LATE: the first frame of a lazily-created sub-ASR is transcribed in
    // the SAME tick as construction (C8), before init() has given this ASR a
    // provider at all, so the epoch is only knowable from a later frame.
    if (t.providerStartedAt == null && this.provider && this.provider.startedAt) {
      t.providerStartedAt = this.provider.startedAt;
    }
    if (t.disabled) return;
    const frameMs = this._bytesToMs(byteLength);
    if (t.lastMeetingMs !== null) {
      const advance = meetingTimeMs - t.lastMeetingMs;
      if (advance < 0) {
        t.disabled = true;
        this.logger.warn(`Per-stream timeline: meetingTimeMs went backwards (${t.lastMeetingMs} -> ${meetingTimeMs}), bot restart or u32 wrap; falling back to identity timestamps`);
        return;
      }
      // Consecutive frames advance the meeting clock by exactly the previous
      // frame's duration; anything beyond that is VAD-elided silence.
      const gap = advance - t.lastFrameMs;
      if (gap > 0) {
        t.cumulativeGapMs += gap;
        t.breaks.push({ audioMs: t.audioMs + t.pendingMs, gapMs: t.cumulativeGapMs });
      }
    }
    t.lastMeetingMs = meetingTimeMs;
    t.lastFrameMs = frameMs;
    t.pendingMs += frameMs;
  }

  // Bind the map to the provider SESSION, and reseed it whenever that session
  // changes. resume() is NOT the only thing that opens a new provider session:
  // two first-party providers re-enter their OWN start() without the wrapper
  // ever knowing — ASR/linto reconnects RECONNECT_DELAY_MS after every WS error
  // (ASR/linto/index.js), and ASR/openai_streaming re-sessions on a Realtime
  // session cap, on a blank-run abort and on its startup watchdog
  // (ASR/openai_streaming/index.js). Both reset `startedAt` (so `astart` moves
  // forward) AND restart their reported clock at 0. A surviving map would then
  // look the small post-restart offsets up against the PREVIOUS session's
  // breakpoints and add the whole previously-elided silence on top of an
  // `astart` that has already moved past it — the exact double-count resume()
  // drops the map to avoid, just arriving from a different direction. Any
  // change of the epoch therefore reseeds, wherever the restart came from; the
  // next frame rebuilds a fresh map from this session's first meetingTimeMs.
  //
  // No provider yet (or a provider that never stamps `startedAt`) leaves the map
  // unbound and behaves exactly as before.
  _syncProviderEpoch() {
    const t = this.timeline;
    if (!t) return;
    const epoch = this.provider ? this.provider.startedAt : null;
    if (!epoch) return;
    if (t.providerStartedAt == null) {
      t.providerStartedAt = epoch;
      return;
    }
    if (t.providerStartedAt !== epoch) this.timeline = null;
  }

  // Cumulative elided silence in force at `audioMs` on the spliced audio clock.
  // Breakpoints are appended in increasing audioMs, so a binary search keeps
  // publication O(log n) whatever the meeting's length.
  _gapAt(audioMs) {
    const breaks = this.timeline ? this.timeline.breaks : null;
    if (!breaks || breaks.length === 0) return 0;
    let lo = 0, hi = breaks.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid].audioMs <= audioMs) { found = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return found === -1 ? 0 : breaks[found].gapMs;
  }

  // Rebase a result's provider timestamps (SECONDS, audio-relative) onto the
  // meeting clock. No-op without a map (legacy) or once the map was abandoned.
  _applyTimeline(transcription) {
    // A provider that restarted itself (see _syncProviderEpoch) publishes on a
    // clock the map knows nothing about: reseed here too, so the results of the
    // new session are identity-mapped until the next frame rebuilds the map.
    this._syncProviderEpoch();
    const t = this.timeline;
    if (!t || t.disabled) return;
    const s = transcription.start;
    const e = transcription.end;
    const sOk = typeof s === 'number' && Number.isFinite(s);
    const eOk = typeof e === 'number' && Number.isFinite(e);
    if (!sOk && !eOk) return;
    // ONE gap for the WHOLE segment, resolved from the position it ENDS at.
    // Resolving start and end independently corrupted the DURATION of any
    // segment straddling a breakpoint: a breakpoint sits at `audioMs +
    // pendingMs`, i.e. at the end of all pre-gap audio (the bot's VAD hangover
    // tail included), and the providers that report `start` as the PREVIOUS
    // final's end (ASR/linto, ASR/openai_streaming) therefore land BEFORE the
    // breakpoint while their `end` lands after it. The gap was then added to
    // `end` only, publishing the caption minutes too early AND inflating a
    // 30 s utterance into a 25-minute one. A segment belongs to the speech
    // burst it ends in, so both ends move by the same amount.
    const gap = this._gapAt((eOk ? e : s) * 1000) / 1000;
    if (sOk) transcription.start = s + gap;
    if (eOk) transcription.end = e + gap;
  }

  // Build the set of secret values that must never reach the logs: the channel's
  // configured provider key/credentials AS STORED (possibly encrypted) and their
  // DECRYPTED form (what a provider SDK actually uses and can leak into an error
  // message). Fail-soft: any decrypt error is swallowed and the at-rest value is
  // still redacted. Cached after first build.
  _secretValues() {
    if (this._secrets) return this._secrets;
    const secrets = new Set();
    try {
      const cfg = this.channel && this.channel.transcriberProfile && this.channel.transcriberProfile.config;
      if (cfg) {
        const candidates = [cfg.key, cfg.apiKey, cfg.credentials, cfg.password, cfg.token];
        const security = new Security();
        for (const raw of candidates) {
          if (typeof raw !== 'string' || raw.length === 0) continue;
          secrets.add(raw);
          try {
            const dec = security.safeDecrypt(raw);
            if (typeof dec === 'string' && dec.length > 0) secrets.add(dec);
          } catch (e) { /* fail-soft: keep the at-rest value redacted */ }
        }
      }
    } catch (e) { /* never let redaction setup break error logging */ }
    this._secrets = secrets;
    return secrets;
  }

  // Redact any known secret value from a loggable string. Only redacts non-trivial
  // tokens (length >= 6) to avoid scrubbing incidental short substrings.
  _redactSecrets(value) {
    let str = value && value.message ? value.message : value;
    if (typeof str !== 'string') {
      try { str = String(str); } catch (e) { return value; }
    }
    for (const secret of this._secretValues()) {
      if (secret.length < 6) continue;
      if (str.includes(secret)) str = str.split(secret).join(REDACTED);
    }
    return str;
  }

  handleASREvents() {
    this.provider.on('connecting', () => {
      this.state = ASR.states.CONNECTING;
    });
    this.provider.on('ready', () => {
      this.state = ASR.states.READY;
    });
    this.provider.on('error', error => {
      // A decrypted provider key can surface in error.message (SDK auth errors
      // echo the credential). Redact it before it reaches the logs.
      this.logger.error(this._redactSecrets(error));
      const msg = ASR_ERROR[error] || ASR_ERROR['RUNTIME_ERROR'];
      const final = {
        "segmentId": this.segmentId,
        "astart": this.provider.startedAt,
        "text": msg,
        "start": 0,
        "end": 0,
        "lang": 'EN-en',
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
      this._advanceSegmentId();
      this.logger.error(msg);
      this.state = ASR.states.ERROR
    })
    this.provider.on('closed', (code, reason) => {
      let msg = 'ASR connexion closed';
      if (code) {
        msg = `${msg} - Code: ${code}`;
      }
      if (reason) {
        msg = `${msg} - Reason: ${reason}`;
      }
      this.logger.info(msg);
      this.state = ASR.states.CLOSED;
    });
    this.provider.on('transcribing', (transcription) => {
      this.state = ASR.states.TRANSCRIBING;
      if (transcription.text.trim().length > 0) {
        transcription.segmentId = this._segmentIdFor(transcription);
        this._applyNativeSpeaker(transcription);
        this._applyTimeline(transcription);
        this.emit('partial', transcription);
      }
    });
    this.provider.on('transcribed', (transcription) => {
      if (transcription.text.trim().length > 0) {
        transcription.segmentId = this._segmentIdFor(transcription);
        this._applyNativeSpeaker(transcription, true);
        this._applyTimeline(transcription);
        this.emit('final', transcription);
        // Origin-tagging for the Microsoft dual recognizer (diarization +
        // translation). The primary (ConversationTranscriber) is the canonical
        // source of segments and speaker; only its finals advance segmentId.
        // The secondary (TranslationRecognizer, isPrimary===false) only carries
        // translations attached to the segment the primary just produced
        // (_lastPrimarySegmentId, set by _segmentIdFor) and must NOT advance
        // segmentId nor create a second canonical caption line (ASREvents.js
        // drops its canonical `final`). Any provider that does not tag isPrimary
        // (amazon, linto, openai, fake, and every single-recognizer Microsoft
        // mode) is treated as primary, so their behaviour is unchanged.
        if (transcription.isPrimary !== false) {
          // Native diarization: free the PREVIOUS segment now (bounded memory)
          // while keeping the just-emitted one available for a lagging secondary.
          if (this.speakerTracker && this._prevFinalSegmentId != null) {
            this.speakerTracker.clearSegment(this._prevFinalSegmentId);
          }
          this._prevFinalSegmentId = transcription.segmentId;
          this._advanceSegmentId();
        }
      }
    });
  }

  // Stop the provider WITH listeners still attached so any finals it flushes
  // during stop() (e.g. Azure stopContinuousRecognitionAsync delivering the
  // pending recognized result) are still emitted as 'final' and published to
  // the broker BEFORE the end-of-stream bot marker (streamStopped). Chained on
  // the transition lock so it never interleaves with pause()/resume(), and
  // bounded so a hung provider can never delay the marker indefinitely.
  async flushFinals() {
    return this._chainTransition(async () => {
      if (this._flushed || !this.provider || this.paused) return;
      this._flushed = true;
      const flushTimeoutMs = parseInt(process.env.ASR_STOP_FLUSH_TIMEOUT_MS, 10) || 3000;
      let flushTimer;
      try {
        await Promise.race([
          this.provider.stop(),
          new Promise((resolve) => { flushTimer = setTimeout(resolve, flushTimeoutMs); }),
        ]);
      } catch (error) {
        this.logger.warn(`flushFinals: provider.stop() error: ${error.message}`);
      } finally {
        clearTimeout(flushTimer);
      }
      // Some SDKs keep delivering callbacks shortly after stop() acks (see the
      // epoch comment in ASR/microsoft/index.js). Give stragglers a beat
      // before the end-of-stream marker is emitted.
      const settleMs = parseInt(process.env.ASR_STOP_SETTLE_MS, 10) || 300;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      this.state = ASR.states.CLOSED;
    });
  }

  // Per-stream participant identity update: a mid-call rename (#7) or a late
  // `join` whose control message lost the race against the participant's first
  // tagged frame (K6 — the sub-ASR was then built with id AND name null, so
  // every caption of that participant carried locutor null). _applyNativeSpeaker
  // reads both fields on every result, so subsequent captions immediately carry
  // the identity with no reconnection. The id is only overwritten when the
  // update actually carries one (a rename may only carry a name). No-op for
  // legacy (the WS handler only calls this for a live per-stream sub-ASR).
  setParticipant(name, id) {
    if (name !== undefined) this.participantName = name;
    if (id !== undefined && id !== null) this.participantId = id;
  }

  streamStopped() {
      if (!this.provider) {
        this.logger.warn('streamStopped called but provider is null');
        return;
      }
      const final = {
        "astart": this.provider.startedAt,
        "aend": new Date().toISOString(),
        "text": "",
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
  }

  async transcodeToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
        .inputOptions(['-ar 16000', '-ac 1'])
        .audioCodec('libmp3lame')
        .audioBitrate('64k')
        .on('end', () => {
          this.logger.info(`Transcoding to MP3 completed: ${outputPath}`);
          resolve();
        })
        .on('error', (err) => {
          this.logger.error(`Error during transcoding: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  async transcodeToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
        .inputOptions(["-ar 16000", "-ac 1"])
        .audioCodec("pcm_s16le")
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => {
          this.logger.error(`Error transcoding to WAV: ${err.message}`);
          reject(err);
        })
        .run();
    });
  }

  async concatAudioFiles(input1, input2, output) {
    return new Promise((resolve, reject) => {
      ffmpeg(input1)
        .input(input2)
        .on('end', () => {
          this.logger.info(`Concat completed: ${output}`);
          resolve()
        })
        .on('error', (err) => {
          this.logger.error(`Error during concat: ${err.message}`)
          reject(err)
        })
        .mergeToFile(output, '/tmp');
    });
  }

  async saveAudio() {
    const fileExtension = this.channel.compressAudio ? '.mp3' : '.wav';
    const transcodeFn = this.channel.compressAudio ? this.transcodeToMp3.bind(this) : this.transcodeToWav.bind(this);
    const pcmFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
    let outFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}`) + fileExtension;

    if (fs.existsSync(outFilePath)) {
      const tempOutFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-temp`) + fileExtension;
      const tempOutputFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-output`) + fileExtension;
      await transcodeFn(pcmFilePath, tempOutFilePath);
      await this.concatAudioFiles(outFilePath, tempOutFilePath, tempOutputFilePath);
      fs.unlinkSync(tempOutFilePath);
      fs.renameSync(tempOutputFilePath, outFilePath);
    } else {
      await transcodeFn(pcmFilePath, outFilePath);
    }

    this.logger.info(`Audio file saved as ${outFilePath}`);
    fs.unlinkSync(pcmFilePath);
  }

  async dispose() {
    try {
      await this._transitionLock;
      if (this.audioFile) {
        if (this.recordOnly) {
          // K2 (ii): end() flushes AND waits for the OS write to land, so ffmpeg
          // can never read a short file (close() + immediate saveAudio() races).
          // Legacy keeps its exact close-then-save ordering below.
          // Node documents writable.end(cb) as "if an error occurs, the callback
          // MAY OR MAY NOT be called": on a stream that errored (ENOSPC, EACCES
          // on AUDIO_STORAGE_PATH) that promise can never settle and dispose()
          // then hangs forever, leaking this ASR, its provider and its listeners
          // for the process lifetime. Race the finish against the stream's own
          // 'error' so the teardown always completes; a failed write is then
          // reported by saveAudio()/ffmpeg below, as for any unreadable file.
          // The 'error' listener is deliberately left attached: removing it
          // would make a later error on the same stream unhandled, which a Node
          // stream turns into an uncaught exception.
          await new Promise(resolve => {
            this.audioFile.once('error', resolve);
            this.audioFile.end(resolve);
          });
          // K2 (i): nobody ever spoke on this channel -> a 0-byte .pcm. ffmpeg
          // fails on an empty input, so drop the file and skip saveAudio()
          // entirely; any pre-existing .wav/.mp3 of the channel is left alone.
          if (this.audioFile.bytesWritten > 0) {
            await this.saveAudio();
          } else {
            const pcmFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
            try {
              fs.unlinkSync(pcmFilePath);
            } catch (error) {
              this.logger.warn(`Could not remove the empty recording ${pcmFilePath}: ${error.message}`);
            }
            this.logger.info(`Mixed recording is empty (no audio received), skipping transcode for session=${this.session.id} channel=${this.channel.id}`);
          }
        } else {
          this.audioFile.close();
          await this.saveAudio();
        }
      }
      if (this.provider) {
        this.provider.removeAllListeners();
        // flushFinals() already stopped the provider (with listeners attached,
        // so its in-flight finals were published); skip the redundant stop.
        if (!this._flushed) {
          await this.provider.stop();
        }
      }
    } catch (error) {
      this.logger.error(`Error when saving the audio file: ${error}`)
      this.emit('error', error);
      return false;
    }
    this.audioBuffer = null;
    this.provider = null;
    this.removeAllListeners();
    return true;
  }

  // `meetingTimeMs` is only supplied by the per-stream WS demux (C2); every
  // legacy caller (SRT/RTMP/mixed WS) calls transcribe(buffer) as before and
  // never builds a timeline map.
  transcribe(buffer, meetingTimeMs) {
    // While paused, drop audio synchronously so the GStreamer pipeline keeps flowing.
    // The buffer was already flushed by pause(), no need to flush again per packet.
    // A dropped frame must NOT advance the audio clock, hence the early return
    // before _noteMeetingTime().
    if (this.paused) return;
    // A shared (overflow) sub-ASR never builds a timeline: its meetingTimeMs
    // comes from several participants interleaved. See `sharedStream` above.
    if (!this.sharedStream && typeof meetingTimeMs === 'number' && Number.isFinite(meetingTimeMs)) {
      this._noteMeetingTime(meetingTimeMs, buffer.length);
    }
    this.audioBuffer.add(buffer);
    if (!(this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING)) return;
    const audioBuffer = this.audioBuffer.getAudioBuffer();
    if (audioBuffer.length >= Math.floor(process.env.MIN_AUDIO_BUFFER / 1000 * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE)) {
      if (this.channel.keepAudio && this.record) {
        this.audioFile.write(audioBuffer);
      }
      this.provider.transcribe(audioBuffer);
      if (this.timeline) {
        // Only audio the provider actually heard advances its clock.
        const forwardedMs = this._bytesToMs(audioBuffer.length);
        this.timeline.audioMs += forwardedMs;
        this.timeline.pendingMs = Math.max(0, this.timeline.pendingMs - forwardedMs);
      }
      this.audioBuffer.flush();
    }
  }
}

module.exports = ASR;
