const WebSocket = require('ws');
const { Security } = require('live-srt-lib');
const logger = require('../../logger');
const EventEmitter = require('eventemitter3');
const { loadProtocol } = require('./protocols');
const { createLangDetector } = require('../lang-detect');

// Sentence-ending punctuation (multilingual)
const SENTENCE_ENDING_PUNCT = /[.!?。！？]$/;

// Segmentation check interval
const SEGMENTATION_CHECK_MS = 250;

// Segmentation defaults
const DEFAULT_SILENCE_MS = 1000;
const DEFAULT_PUNCT_SILENCE_MS = 500;
const DEFAULT_HARD_SILENCE_MS = 2500;
const DEFAULT_MIN_WORDS = 3;
const DEFAULT_SOFT_MAX_WORDS = 80;
const DEFAULT_HARD_MAX_WORDS = 150;

// Internal sentence boundary: sentence-ending punct followed by space+uppercase
// Matches: ". Le", "! On", "? Est", "。「" etc.
const INTERNAL_SENTENCE_BOUNDARY = /[.!?。！？]\s+(?=[A-ZÀ-ÖØ-ÞÉÈÊËÎÏÔÙÛÜŸŒÆ])/;

// Grace period on hard silence: wait briefly for any late trailing tokens
// (e.g. Voxtral's delayed punctuation) before emitting the segment.
const DRAIN_GRACE_MS = 750;

// Reconnection delay after WebSocket error (ms)
const RECONNECT_DELAY_MS = 2000;

// --- Startup handshake hardening ---
// Audio received before the session is armed is retained in a bounded FIFO
// (oldest chunks dropped) instead of being discarded, then flushed on arming.
// Sized in ms of PCM 16 kHz mono 16-bit (32 bytes/ms).
const PRE_ARM_BUFFER_MAX_MS = parseInt(process.env.ASR_PRE_ARM_BUFFER_MAX_MS || '10000', 10);
const PCM_BYTES_PER_MS = 32;
const PRE_ARM_BUFFER_MAX_BYTES = PRE_ARM_BUFFER_MAX_MS * PCM_BYTES_PER_MS;

// Watchdog (vLLM protocol): the session is armed and audio is flowing, but
// the server never produced a transcription event. The server-side session is
// silently broken; reconnect instead of staying mute forever. After
// WATCHDOG_MAX_RETRIES consecutive failures the error is surfaced to the
// session (SERVICE_TIMEOUT) and retries continue at a slower cadence — a
// stream that legitimately starts with a long silence keeps its session alive
// through these reconnects (the pre-arm buffer carries the audio across).
const WATCHDOG_NO_RESULT_MS = parseInt(process.env.ASR_WATCHDOG_NO_RESULT_MS || '10000', 10);
const WATCHDOG_MAX_RETRIES = parseInt(process.env.ASR_WATCHDOG_MAX_RETRIES || '3', 10);
const WATCHDOG_SLOW_RETRY_MS = parseInt(process.env.ASR_WATCHDOG_SLOW_RETRY_MS || '30000', 10);

// Mute watchdog (vLLM protocol): guards against the realtime "silent
// collapse", where the server keeps streaming EMPTY deltas at frame rate
// while real speech is flowing (greedy silence rut, self-sustained for
// minutes). Neither the startup watchdog (any delta, even empty, disarms it)
// nor a wall-clock timer (indistinguishable from legitimate silence) can
// catch it. Instead we count milliseconds of VOICED audio -- chunks whose
// RMS exceeds ASR_MUTE_RMS_DBFS -- since the last non-empty delta: real
// silence never accumulates, sustained speech with no text does. On trigger
// the session is restarted (a fresh server-side session unblocks
// immediately; the pre-arm buffer carries the last seconds of audio across).
// Long music passages may cause periodic harmless resessions (accepted).
// ASR_MUTE_WATCHDOG_SPEECH_MS=0 disables.
const MUTE_WATCHDOG_SPEECH_MS = parseInt(process.env.ASR_MUTE_WATCHDOG_SPEECH_MS || '25000', 10);
const MUTE_RMS_DBFS = parseFloat(process.env.ASR_MUTE_RMS_DBFS || '-45');

// --- Silence-fill pacing (vLLM realtime) ---
// The realtime server transcribes CONTINUOUSLY after the arming commit and
// takes no mid-session commit, so it needs an uninterrupted audio stream. SRT
// provides one by construction: GStreamer decodes the transport at 1x and emits
// silent PCM through speech gaps, so transcribe() is called at a steady rate.
// The WebSocket path has no such floor -- audio reaches the ASR only when the
// client sends it, so a silent or bursty WS client starves the server and the
// realtime generation stalls or wedges. This pump keeps the audio timeline at
// wall-clock pace by appending digital silence whenever the real audio falls
// more than ASR_SILENCE_KEEPALIVE_MS behind. When audio already flows at
// real-time (SRT) the lag never crosses the threshold, so in steady state the
// pump emits nothing and the SRT path is unchanged. 0 disables it.
const SILENCE_KEEPALIVE_MS = parseInt(process.env.ASR_SILENCE_KEEPALIVE_MS || '200', 10);
const PACING_INTERVAL_MS = 100;
const SILENCE_FILL_MAX_MS = 2000; // cap one fill (bounds a stalled timer / very long gap)

class OpenAIStreamingTranscriber extends EventEmitter {
    static ERROR_MAP = {
        0: 'NO_ERROR',
        1: 'AUTHENTICATION_FAILURE',
        2: 'BAD_REQUEST_PARAMETERS',
        3: 'TOO_MANY_REQUESTS',
        4: 'CONNECTION_FAILURE',
        5: 'SERVICE_TIMEOUT',
        6: 'SERVICE_ERROR',
        7: 'RUNTIME_ERROR',
        8: 'FORBIDDEN',
    };

    static CRITICAL_FAILURES = new Set([
        'DEPTH_ZERO_SELF_SIGNED_CERT'
    ]);

    constructor(session, channel) {
        super();
        this.channel = channel;
        this.logger = logger.getChannelLogger(session.id, channel.id);
        this.ws = null;
        this.accumulatedText = '';
        this.lastDeltaTime = 0;
        this.segmentationTimer = null;
        this.startTime = null;
        this.lastEndTime = 0;
        this.startedAt = null;
        this._sessionReady = false;
        this._draining = false;
        this._drainStartTime = 0;
        this._setupTimers = [];
        this._connGeneration = 0;

        // Startup handshake state.
        // The pre-arm buffer deliberately survives reconnects: it carries the
        // last seconds of audio across a watchdog-triggered restart.
        this._preArmBuffer = [];
        this._preArmBufferBytes = 0;
        this._armed = false;
        this._updateSent = false;
        this._watchdogTimer = null;
        this._watchdogRetries = 0;

        // Mute watchdog state (see constant block above): voiced-audio ms
        // accumulated since the last non-empty delta, and how many times a
        // mute session was force-restarted (separate from _watchdogRetries).
        this._speechMsSinceLastText = 0;
        this._muteResessions = 0;

        // Silence-fill pacing state (see constant block). `_streamStartWall` is
        // the wall-clock anchor set on the first real audio append; from then on
        // `_audioMsAppended` (real audio + injected silence) is kept level with
        // wall-clock. Null until the stream's first audio, so a session that
        // never receives any audio injects nothing.
        this._streamStartWall = null;
        this._audioMsAppended = 0;
        this._pacingTimer = null;
        this._silenceKeepaliveMs = SILENCE_KEEPALIVE_MS;

        const config = channel.transcriberProfile.config;

        // Segmentation thresholds (configurable via profile, with sensible defaults)
        this.silenceMs = config.silenceThreshold || DEFAULT_SILENCE_MS;
        this.punctSilenceMs = config.punctSilenceThreshold || DEFAULT_PUNCT_SILENCE_MS;
        this.hardSilenceMs = config.hardSilenceThreshold || DEFAULT_HARD_SILENCE_MS;
        this.minWords = config.minWords || DEFAULT_MIN_WORDS;
        this.softMaxWords = config.softMaxWords || DEFAULT_SOFT_MAX_WORDS;
        this.hardMaxWords = config.hardMaxWords || DEFAULT_HARD_MAX_WORDS;

        // Initialize protocol adapter
        const protocolName = config.protocol || 'vllm';
        const ProtocolClass = loadProtocol(protocolName);
        this.protocolName = protocolName;

        // Language detection via shared module
        const candidates = (config.languages || []).map(l => l.candidate);
        this._langDetector = createLangDetector(candidates);

        // Protocol will be fully initialized in start() after apiKey decryption
        this._config = config;
        this._ProtocolClass = ProtocolClass;
        this.protocol = null;

        this.emit('closed');
    }

    detectLanguage(text, force = false) {
        return this._langDetector.detectLanguage(text, force);
    }

    /**
     * Called when the server sends session.created. Now safe to configure the session.
     */
    _onSessionCreated(config) {
        // Send session configuration
        const sessionUpdate = this.protocol.buildSessionUpdate(config.model);
        this.ws.send(JSON.stringify(sessionUpdate));
        this._updateSent = true;
        this.logger.debug(`Sent session update: ${JSON.stringify(sessionUpdate)}`);

        if (this.protocolName === 'vllm') {
            // The server processes WebSocket events sequentially, so the
            // session.update -> commit -> append ordering is guaranteed by the
            // connection itself: no fixed delays are needed. Arming (the
            // initial commit that starts the server-side generation) is
            // deferred until the first real audio chunk is available, so the
            // server never starts a generation over an empty audio queue. A
            // connection cut before any audio therefore leaves nothing
            // running server-side.
            this._tryArm();
        } else {
            this._sessionReady = true;
            this._flushPreArmBuffer();
            this.emit('ready');
        }
    }

    /**
     * vLLM arming: send the initial commit as soon as the session is
     * configured (session.update acked), then flush any audio buffered during
     * the handshake. We do NOT wait for buffered audio before committing: the
     * server defers the actual generation start to the first audio append
     * (defer-arm), so an empty queue at commit time is safe. Gating the commit
     * on buffered audio broke arming on the real SRT/GStreamer path (audio is
     * not buffered at the instant _tryArm runs), leaving the server idle.
     * Called from _onSessionCreated (normal case) and transcribe() (audio
     * arrived before the session was configured).
     */
    _tryArm() {
        if (this._armed || !this._updateSent) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const commit = this.protocol.buildCommit(false);
        this.ws.send(JSON.stringify(commit));
        this.logger.debug('Sent initial commit (vLLM), armed');
        this._armed = true;
        this._sessionReady = true;
        this._flushPreArmBuffer();
        this.emit('ready');
        this.startSegmentationTimer();
        this._startWatchdog();
        this._startPacing();
    }

    _flushPreArmBuffer() {
        if (this._preArmBuffer.length === 0) return;
        const buffered = this._preArmBuffer;
        this._preArmBuffer = [];
        this._preArmBufferBytes = 0;
        for (const buf of buffered) this._sendAudio(buf);
    }

    _startWatchdog() {
        this._clearWatchdog();
        const gen = this._connGeneration;
        const delay = this._watchdogRetries >= WATCHDOG_MAX_RETRIES
            ? WATCHDOG_SLOW_RETRY_MS : WATCHDOG_NO_RESULT_MS;
        this._watchdogTimer = setTimeout(() => {
            if (gen !== this._connGeneration) return;
            this._onWatchdogTimeout(delay);
        }, delay);
    }

    _clearWatchdog() {
        if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    /**
     * Armed session with audio flowing produced no transcription event within
     * the window: the server-side session is silently broken. Reconnect; the
     * pre-arm buffer carries the last seconds of audio so the restart has no
     * gap.
     */
    _onWatchdogTimeout(waitedMs) {
        this._watchdogRetries++;
        this.logger.warn(`No transcription ${waitedMs}ms after audio started, reconnecting (attempt ${this._watchdogRetries})`);
        if (this._watchdogRetries === WATCHDOG_MAX_RETRIES) {
            this.emit('error', OpenAIStreamingTranscriber.ERROR_MAP[5]);
        }
        this._forceResession();
    }

    /**
     * Tear down the current connection and schedule a fresh session. The
     * pre-arm buffer survives, so the restart resumes without an audio gap.
     * Shared by the startup watchdog and the mute watchdog.
     */
    _forceResession() {
        this.stop();
        this.logger.info(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
        const t = setTimeout(() => this.start(), RECONNECT_DELAY_MS);
        this._setupTimers.push(t);
    }

    /**
     * Mute watchdog check, evaluated on each segmentation tick: too much
     * voiced audio accumulated without a single non-empty delta means the
     * server-side session is in a silence rut; restart it.
     * @returns {boolean} true if a resession was triggered
     */
    _checkMuteWatchdog() {
        if (MUTE_WATCHDOG_SPEECH_MS <= 0) return false;
        if (this._speechMsSinceLastText < MUTE_WATCHDOG_SPEECH_MS) return false;
        this._muteResessions++;
        this.logger.warn(`No text after ${Math.round(this._speechMsSinceLastText)}ms of voiced audio (silent collapse), forcing a fresh session (resession #${this._muteResessions})`);
        this._speechMsSinceLastText = 0;
        this._forceResession();
        return true;
    }

    /**
     * Milliseconds of voiced audio in a PCM chunk (16 kHz mono 16-bit LE):
     * the chunk duration if its RMS is above MUTE_RMS_DBFS, else 0.
     */
    _voicedMs(buf) {
        const samples = buf.length >> 1;
        if (samples === 0) return 0;
        let sumSq = 0;
        for (let i = 0; i < samples; i++) {
            const s = buf.readInt16LE(i << 1) / 32768;
            sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / samples);
        if (rms === 0) return 0;
        return 20 * Math.log10(rms) > MUTE_RMS_DBFS ? samples / 16 : 0;
    }

    /**
     * First transcription event on this connection: the handshake worked.
     * Disarm the watchdog and reset the retry counter.
     */
    _onTranscriptionEvidence() {
        this._watchdogRetries = 0;
        this._clearWatchdog();
    }

    formatResult(text, lang) {
        const now = Date.now();
        const elapsedSec = this.startTime ? (now - this.startTime) / 1000 : 0;
        return {
            astart: this.startedAt,
            text: text,
            translations: {},
            start: this.lastEndTime,
            end: this.lastEndTime + elapsedSec,
            lang: lang,
            locutor: null
        };
    }

    /**
     * Count words in text (split on whitespace).
     */
    _wordCount(text) {
        const trimmed = text.trim();
        if (!trimmed) return 0;
        return trimmed.split(/\s+/).length;
    }

    start() {
        this.startedAt = new Date().toISOString();
        const config = this._config;

        if (!this.channel.transcriberProfile) {
            return;
        }

        this.startTime = null;
        this.lastEndTime = 0;
        this.accumulatedText = '';
        this.lastDeltaTime = 0;
        this._cachedLang = null;
        this._lastLangCheckLen = 0;
        this._draining = false;
        this._drainStartTime = 0;
        this._speechMsSinceLastText = 0;
        // Reset the pacing clock; a reconnect re-anchors on its first audio.
        this._streamStartWall = null;
        this._audioMsAppended = 0;
        this._stopPacing();
        this.emit('connecting');

        // Decrypt apiKey if present
        let decryptedApiKey = null;
        if (config.apiKey) {
            decryptedApiKey = new Security().safeDecrypt(config.apiKey);
        }

        // Create a config copy with decrypted apiKey for the protocol
        const protocolConfig = { ...config };
        if (decryptedApiKey) {
            protocolConfig.apiKey = decryptedApiKey;
        }
        this.protocol = new this._ProtocolClass(protocolConfig, this.logger);

        const wsUrl = this.protocol.getWebSocketUrl(config.endpoint);
        const wsOptions = this.protocol.getConnectionOptions();

        this.logger.info(`Connecting to ${wsUrl} (protocol: ${this.protocolName})`);
        this.ws = new WebSocket(wsUrl, wsOptions);

        this._sessionReady = false;
        this._armed = false;
        this._updateSent = false;
        this._connGeneration++;
        const gen = this._connGeneration;

        this.ws.on('open', () => {
            this.logger.debug('WebSocket connection established, waiting for session.created...');
        });

        this.ws.on('message', (rawMessage) => {
            let msg;
            try {
                msg = JSON.parse(rawMessage);
            } catch (e) {
                this.logger.warn(`Failed to parse WebSocket message: ${e.message}`);
                return;
            }

            const event = this.protocol.parseServerEvent(msg);
            if (!event) {
                this.logger.debug(`Unhandled server event: ${msg.type || JSON.stringify(msg).substring(0, 120)}`);
                return;
            }

            switch (event.type) {
                case 'session_created':
                    this.logger.info(`Session created: ${event.data.sessionId}`);
                    this._onSessionCreated(config);
                    break;

                case 'partial':
                    this._onTranscriptionEvidence();
                    this.handlePartial(event.data.text);
                    break;

                case 'final':
                    this._onTranscriptionEvidence();
                    this.handleFinal(event.data.text);
                    break;

                case 'error':
                    this.logger.warn(`ASR error: ${event.data.message} (code: ${event.data.code})`);
                    this.emit('error', OpenAIStreamingTranscriber.ERROR_MAP[6]);
                    break;
            }
        });

        this.ws.on('error', (error) => {
            if (gen !== this._connGeneration) return;
            this.logger.warn(`WebSocket error: ${error}`);
            this.emit('error', OpenAIStreamingTranscriber.ERROR_MAP[4]);
            this.stop();

            // Don't restart if it's a critical failure
            if (error.code && OpenAIStreamingTranscriber.CRITICAL_FAILURES.has(error.code)) {
                return;
            }
            this.logger.info(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
            const t = setTimeout(() => this.start(), RECONNECT_DELAY_MS);
            this._setupTimers.push(t);
        });

        this.ws.on('close', (code, reason) => {
            if (gen !== this._connGeneration) return;
            this.logger.debug(`WebSocket closed: ${code} ${reason}`);
            this.emit('closed', { code, reason, error: OpenAIStreamingTranscriber.ERROR_MAP[code] || 'UNKNOWN_ERROR' });
        });
    }

    /**
     * Handle a partial transcription delta.
     * Accumulates text and emits 'transcribing' events.
     */
    handlePartial(deltaText) {
        // Discard orphan punctuation at segment start.
        // Some models (e.g. Voxstral) send sentence-ending punctuation as a
        // separate token several seconds after the last word, by which time the
        // segmentation timer has already emitted the previous segment.
        if (deltaText && this.accumulatedText.trim().length === 0 && /^[.!?。！？,;:，；：\s]+$/.test(deltaText)) {
            this.logger.debug(`Discarding orphan punctuation: "${deltaText.trim()}"`);
            return;
        }

        // Accumulate the delta (can be empty string for silence)
        this.accumulatedText += deltaText;

        if (deltaText && deltaText.length > 0) {
            this.lastDeltaTime = Date.now();
            this._speechMsSinceLastText = 0;

            if (!this.startTime) {
                this.startTime = Date.now();
            }

            // Priority 0: Check for internal sentence boundary in accumulated text.
            // When Voxtral emits punctuation (possibly delayed), we split immediately
            // at the boundary rather than waiting for silence.
            this._checkInternalBoundary();

            const lang = this.detectLanguage(this.accumulatedText);
            const payload = this.formatResult(this.accumulatedText, lang);
            this.emit('transcribing', payload);
            this.logger.debug(`ASR partial transcription: ${this.accumulatedText}`);
        }
    }

    /**
     * Handle a final transcription event (from OpenAI protocol).
     */
    handleFinal(text) {
        if (!text || text.trim().length === 0) return;

        this._speechMsSinceLastText = 0;

        if (!this.startTime) {
            this.startTime = Date.now();
        }

        const lang = this.detectLanguage(text, true);
        const payload = this.formatResult(text, lang);
        this.lastEndTime = payload.end;
        this.emit('transcribed', payload);

        this.logger.debug(`ASR final transcription: ${text}`);

        // Reset for next segment
        this.accumulatedText = '';
        this.startTime = null;
        this._lastLangCheckLen = 0;
    }

    /**
     * Emit accumulated text as a final segment.
     * @param {string} reason - Why this segment was emitted (for logging)
     */
    _emitSegment(reason) {
        const trimmedText = this.accumulatedText.trim();
        if (!trimmedText) return;

        if (!this.startTime) {
            this.startTime = Date.now();
        }

        const lang = this.detectLanguage(trimmedText, true);
        const payload = this.formatResult(trimmedText, lang);
        this.lastEndTime = payload.end;
        this.emit('transcribed', payload);

        this.logger.debug(`ASR final transcription (${reason}) [lang: ${lang || 'null'}]: ${trimmedText}`);

        // Reset for next segment
        this.accumulatedText = '';
        this.startTime = null;
        this._lastLangCheckLen = 0;
        this._draining = false;
    }

    /**
     * Hybrid segmentation timer for protocols without server-side final events (e.g. vLLM).
     *
     * NOTE: The primary segmentation is now handled by _checkInternalBoundary()
     * in handlePartial(), which splits at internal punctuation boundaries
     * (e.g. ". Le", "! On") as soon as they appear. This timer handles the
     * remaining cases where punctuation is absent or delayed.
     *
     * Segmentation strategy (priority order):
     * 0. [In handlePartial] Internal sentence boundary → immediate split (primary)
     * 1. Hard max words exceeded → force cut at last punctuation or word boundary
     * 2. Soft max words + sentence-ending punctuation → cut
     * 3. Silence > silenceMs + sentence-ending punctuation + min words → cut
     * 4. Silence > punctSilenceMs + sentence-ending punctuation + enough words → cut
     * 5. Silence > hardSilenceMs + min words → cut (hard fallback, no punctuation needed)
     */
    startSegmentationTimer() {
        this.segmentationTimer = setInterval(() => {
            this._runSegmentationTick(Date.now());
        }, SEGMENTATION_CHECK_MS);
    }

    /**
     * Evaluate segmentation once. Extracted from the interval callback so it
     * can be unit-tested with a controlled clock.
     * @param {number} now - current timestamp in ms
     */
    _runSegmentationTick(now) {
        // Mute watchdog first: during a silence rut the accumulated text is
        // usually empty (deltas are empty), so this must run before the
        // early returns below.
        if (this._checkMuteWatchdog()) return;

        if (!this.accumulatedText || this.accumulatedText.trim().length === 0) return;
        if (!this.lastDeltaTime) return;

        const silenceDuration = now - this.lastDeltaTime;
        const trimmedText = this.accumulatedText.trim();
        const wordCount = this._wordCount(trimmedText);
        const hasSentenceEnd = SENTENCE_ENDING_PUNCT.test(trimmedText);

        // Don't emit segments smaller than minWords (unless hard silence)
        if (wordCount < this.minWords && silenceDuration < this.hardSilenceMs) return;

        let shouldEmit = false;
        let reason = '';

        // Priority 1: Hard max words exceeded - force cut
        if (wordCount >= this.hardMaxWords) {
            // Try to find a good break point (last sentence-ending punctuation)
            const breakIdx = this._findBestBreakPoint(trimmedText);
            if (breakIdx > 0 && breakIdx < trimmedText.length - 1) {
                // Emit up to the break point, keep the rest
                const emitText = trimmedText.substring(0, breakIdx + 1).trim();
                const remaining = trimmedText.substring(breakIdx + 1).trim();

                if (!this.startTime) this.startTime = now;
                const lang = this.detectLanguage(emitText, true);
                const payload = this.formatResult(emitText, lang);
                this.lastEndTime = payload.end;
                this.emit('transcribed', payload);

                this.logger.debug(`ASR final transcription (hard max, split): ${emitText}`);

                this.accumulatedText = ' ' + remaining;
                this.startTime = now;
                this._lastLangCheckLen = 0;
                return;
            }
            // No good break point, emit everything
            shouldEmit = true;
            reason = 'hard max words';
        }

        // Priority 2: Soft max words + punctuation (no silence needed for long sentences)
        if (!shouldEmit && wordCount >= this.softMaxWords && hasSentenceEnd) {
            shouldEmit = true;
            reason = `soft max (${wordCount} words) + punctuation`;
        }

        // Priority 3: Silence + punctuation + min words (sentence boundary)
        if (!shouldEmit && silenceDuration > this.silenceMs && hasSentenceEnd && wordCount >= this.minWords) {
            shouldEmit = true;
            reason = `silence ${silenceDuration}ms + punctuation`;
        }

        // Priority 4: Longer silence + punctuation for shorter segments
        if (!shouldEmit && silenceDuration > this.punctSilenceMs && hasSentenceEnd && wordCount >= this.softMaxWords / 2) {
            shouldEmit = true;
            reason = `short silence ${silenceDuration}ms + punctuation + ${wordCount} words`;
        }

        // Priority 5: Hard silence — debounce, then emit as-is (no punctuation needed).
        //
        // We deliberately do NOT send a commit here. This used to be the only
        // mid-session commit the transcriber sent, and on the vLLM side it can
        // land while the engine is re-anchoring a long realtime session's RoPE
        // positions ("Generation already in progress, ignoring commit"), stalling
        // this stream's delta output for ~10s (the acute freeze at re-anchor).
        // The server transcribes continuously after the initial arming commit, so
        // a periodic commit is unnecessary: the reference load client in the
        // linto-ai/vllm fork (benchmarks/voxtral_realtime/ws_load.py, a bench tool
        // shipped with the server, not part of this repo) sends no mid-session
        // commit and stays in sync across re-anchors. We just wait a short grace
        // period for any late tokens (Voxtral can emit delayed punctuation), then emit.
        if (!shouldEmit && wordCount >= this.minWords && silenceDuration > this.hardSilenceMs) {
            if (!this._draining) {
                // Enter drain: wait a grace period for any late tokens
                this._draining = true;
                this._drainStartTime = now;
                this.logger.debug(`Hard silence ${silenceDuration}ms: draining (grace ${DRAIN_GRACE_MS}ms)...`);
                return;
            }

            if (this.lastDeltaTime > this._drainStartTime) {
                // New tokens arrived during grace — exit drain, keep accumulating
                this._draining = false;
                return;
            }

            if (now - this._drainStartTime > DRAIN_GRACE_MS) {
                // Grace period expired with no new tokens — emit as-is
                this._draining = false;
                shouldEmit = true;
                reason = `hard silence + drain timeout ${now - this._drainStartTime}ms`;
            }
        }

        if (shouldEmit) {
            this._emitSegment(reason);
        }
    }

    /**
     * Find the best break point in text for forced splitting.
     * Looks for the last sentence-ending punctuation followed by a space.
     * Returns the index of the punctuation character, or -1 if none found.
     */
    _findBestBreakPoint(text) {
        // Find last sentence-ending punctuation followed by space (or near end)
        let bestIdx = -1;
        for (let i = text.length - 2; i >= 0; i--) {
            if (/[.!?。！？]/.test(text[i]) && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
                bestIdx = i;
                break;
            }
        }
        return bestIdx;
    }

    /**
     * Check for internal sentence boundaries in accumulated text.
     * If found, emit everything up to the boundary as a final segment
     * and keep the rest as the start of the next segment.
     *
     * This is the primary segmentation mechanism for models like Voxtral
     * that produce reliable punctuation (possibly delayed). It cuts at
     * natural sentence boundaries without waiting for silence.
     */
    _checkInternalBoundary() {
        const trimmed = this.accumulatedText.trim();
        if (this._wordCount(trimmed) < this.minWords) return;

        const match = INTERNAL_SENTENCE_BOUNDARY.exec(trimmed);
        if (!match) return;

        // Split at the boundary: emit up to and including the punctuation
        const boundaryIdx = match.index;  // index of the . ! ? character
        const emitText = trimmed.substring(0, boundaryIdx + 1).trim();
        const remaining = trimmed.substring(boundaryIdx + 1).trim();

        // Only split if the emitted part has enough words
        if (this._wordCount(emitText) < this.minWords) return;

        const lang = this.detectLanguage(emitText, true);
        const payload = this.formatResult(emitText, lang);
        this.lastEndTime = payload.end;
        this.emit('transcribed', payload);

        this.logger.debug(`ASR final transcription (sentence boundary): ${emitText}`);

        // Keep remainder for next segment
        this.accumulatedText = ' ' + remaining;
        this.startTime = Date.now();
        this._lastLangCheckLen = 0;
        this._draining = false;
    }

    transcribe(buffer) {
        // Ensure we have a Node.js Buffer (CircularBuffer returns Uint8Array)
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

        if (this.protocolName === 'vllm' && MUTE_WATCHDOG_SPEECH_MS > 0) {
            this._speechMsSinceLastText += this._voicedMs(buf);
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN && this._sessionReady) {
            this._sendAudio(buf);
            return;
        }

        // Session not ready (handshake, arming, or reconnect in progress):
        // retain the audio instead of dropping it. It is flushed on arming,
        // so the first syllables survive the handshake and a watchdog
        // reconnect resumes without a gap.
        this._bufferPreArm(buf);
        if (this.protocolName === 'vllm') {
            this._tryArm();
        }
    }

    _sendAudio(buf) {
        // Anchor the pacing clock on the stream's first real audio. Silence is
        // only ever injected once this is set, so the first _sendAudio is always
        // real audio and the anchor is honest.
        if (this._streamStartWall === null) this._streamStartWall = Date.now();
        // Split large buffers into chunks of MAX_CHUNK_BYTES (200ms @ 16kHz mono 16-bit)
        const MAX_CHUNK_BYTES = 6400;
        let offset = 0;
        while (offset < buf.length) {
            const chunk = buf.slice(offset, offset + MAX_CHUNK_BYTES);
            const base64Audio = chunk.toString('base64');
            const msg = this.protocol.buildAudioAppend(base64Audio);
            this.ws.send(JSON.stringify(msg));
            offset += MAX_CHUNK_BYTES;
        }
        // Advance the audio timeline (real audio and injected silence alike).
        this._audioMsAppended += buf.length / PCM_BYTES_PER_MS;
    }

    // --- Silence-fill pacing (see constant block) ---

    _startPacing() {
        if (this._silenceKeepaliveMs <= 0) return;
        this._stopPacing();
        this._pacingTimer = setInterval(() => this._runPacingTick(Date.now()), PACING_INTERVAL_MS);
        // Never keep the event loop alive just for the pump.
        if (this._pacingTimer.unref) this._pacingTimer.unref();
    }

    _stopPacing() {
        if (this._pacingTimer) {
            clearInterval(this._pacingTimer);
            this._pacingTimer = null;
        }
    }

    /**
     * One pacing tick. Extracted from the interval callback so it can be
     * unit-tested with a controlled clock (same pattern as _runSegmentationTick).
     * Appends just enough digital silence to bring the audio timeline back to
     * wall-clock when real audio has fallen more than `_silenceKeepaliveMs`
     * behind. Returns the ms of silence sent (0 when none is needed).
     * @param {number} now - current timestamp in ms
     */
    _runPacingTick(now) {
        if (this._silenceKeepaliveMs <= 0) return 0;
        // No real audio yet: a session that never streams injects nothing.
        if (this._streamStartWall === null) return 0;
        if (!this._armed) return 0;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return 0;

        const lagMs = (now - this._streamStartWall) - this._audioMsAppended;
        if (lagMs <= this._silenceKeepaliveMs) return 0; // real audio is keeping up

        const fillMs = Math.min(Math.floor(lagMs), SILENCE_FILL_MAX_MS);
        if (fillMs <= 0) return 0;
        this._sendSilence(fillMs);
        return fillMs;
    }

    _sendSilence(ms) {
        // PCM S16LE zeros = digital silence. Routed through _sendAudio so it is
        // chunked into the same 200ms appends and advances the audio clock.
        this._sendAudio(Buffer.alloc(ms * PCM_BYTES_PER_MS));
    }

    _bufferPreArm(buf) {
        this._preArmBuffer.push(buf);
        this._preArmBufferBytes += buf.length;
        let droppedBytes = 0;
        // Keep at least the newest chunk, even if it alone exceeds the cap
        while (this._preArmBufferBytes > PRE_ARM_BUFFER_MAX_BYTES && this._preArmBuffer.length > 1) {
            const dropped = this._preArmBuffer.shift();
            this._preArmBufferBytes -= dropped.length;
            droppedBytes += dropped.length;
        }
        if (droppedBytes > 0 && !this._transcribeWarnThrottled) {
            this._transcribeWarnThrottled = true;
            this.logger.warn(`Session not ready after ${PRE_ARM_BUFFER_MAX_MS}ms of audio, dropping oldest buffered audio (${droppedBytes} bytes)`);
            setTimeout(() => { this._transcribeWarnThrottled = false; }, 5000);
        }
    }

    stop() {
        // Invalidate current connection generation so stale handlers are ignored
        this._connGeneration++;

        this._clearWatchdog();
        this._stopPacing();

        // Clear all pending timers (setup delays, reconnection)
        for (const t of this._setupTimers) clearTimeout(t);
        this._setupTimers = [];

        // Clear segmentation timer
        if (this.segmentationTimer) {
            clearInterval(this.segmentationTimer);
            this.segmentationTimer = null;
        }

        // Emit final for any remaining accumulated text
        if (this.accumulatedText && this.accumulatedText.trim().length > 0) {
            this._emitSegment('stop');
        }

        // Send commit to signal end of stream. For vLLM this is only
        // meaningful when the session was armed: an un-armed session has no
        // server-side generation to end.
        const skipFinalCommit = this.protocolName === 'vllm' && !this._armed;
        if (!skipFinalCommit && this.ws && this.ws.readyState === WebSocket.OPEN && this.protocol) {
            try {
                const commit = this.protocol.buildCommit(true);
                this.ws.send(JSON.stringify(commit));
            } catch (e) {
                this.logger.warn(`Error sending final commit: ${e.message}`);
            }
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = OpenAIStreamingTranscriber;
