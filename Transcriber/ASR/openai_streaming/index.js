const WebSocket = require('ws');
const { Security } = require('live-srt-lib');

// Dynamic import for ESM-only franc module
let _franc = null;
import('franc').then(m => { _franc = m.franc; });
const logger = require('../../logger');
const EventEmitter = require('eventemitter3');
const { loadProtocol } = require('./protocols');

// BCP 47 -> ISO 639-3 mapping for franc language detection
const BCP47_TO_ISO3 = {
    'fr-FR': 'fra',
    'en-US': 'eng',
    'de-DE': 'deu',
    'es-ES': 'spa',
    'it-IT': 'ita',
    'pt-BR': 'por',
    'nl-NL': 'nld',
    'ru-RU': 'rus',
    'zh-CN': 'zho',
    'ja-JP': 'jpn',
    'ko-KR': 'kor',
    'ar-SA': 'ara',
    'hi-IN': 'hin'
};

// Sentence-ending punctuation (multilingual)
const SENTENCE_ENDING_PUNCT = /[.!?。！？]$/;

// Segmentation check interval
const SEGMENTATION_CHECK_MS = 250;

// Language detection thresholds
const LANG_DETECT_MIN_CHARS = 30;
const LANG_DETECT_RECHECK_CHARS = 80;

// Segmentation defaults
const DEFAULT_SILENCE_MS = 1000;
const DEFAULT_PUNCT_SILENCE_MS = 500;
const DEFAULT_HARD_SILENCE_MS = 2500;
const DEFAULT_MIN_WORDS = 3;
const DEFAULT_SOFT_MAX_WORDS = 30;
const DEFAULT_HARD_MAX_WORDS = 45;

// Grace period after sending a commit: wait for server to flush trailing tokens (punctuation, etc.)
const DRAIN_GRACE_MS = 750;

// Reconnection delay after WebSocket error (ms)
const RECONNECT_DELAY_MS = 2000;

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
        this._drainCommitTime = 0;
        this._setupTimers = [];
        this._connGeneration = 0;

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

        // Build language detection mappings from config.languages
        this.allowedIso3 = [];
        this.iso3ToBcp47 = {};
        if (config.languages && config.languages.length) {
            for (const lang of config.languages) {
                const bcp47 = lang.candidate;
                const iso3 = BCP47_TO_ISO3[bcp47];
                if (iso3) {
                    this.allowedIso3.push(iso3);
                    this.iso3ToBcp47[iso3] = bcp47;
                }
            }
        }

        // Language detection state
        this._cachedLang = null;
        this._lastLangCheckLen = 0;

        // Protocol will be fully initialized in start() after apiKey decryption
        this._config = config;
        this._ProtocolClass = ProtocolClass;
        this.protocol = null;

        this.emit('closed');
    }

    /**
     * Detect language from text using franc, constrained to profile languages.
     * Uses caching: only re-detects when text grows significantly.
     * @param {string} text
     * @param {boolean} force - Force re-detection (for finals)
     * @returns {string|null} BCP 47 language tag or null if undetermined
     */
    detectLanguage(text, force = false) {
        if (!this.allowedIso3.length || !text || text.trim().length === 0) {
            return this._cachedLang;
        }

        const textLen = text.length;

        // Don't attempt detection on very short text, return cached value
        if (textLen < LANG_DETECT_MIN_CHARS && !force) {
            return this._cachedLang;
        }

        // Only re-detect when text has grown enough (or forced for finals)
        if (!force && this._cachedLang && (textLen - this._lastLangCheckLen) < LANG_DETECT_RECHECK_CHARS) {
            return this._cachedLang;
        }

        if (!_franc) return this._cachedLang;
        const detected = _franc(text, { only: this.allowedIso3 });
        const bcp47 = detected === 'und' ? null : (this.iso3ToBcp47[detected] || null);

        if (bcp47) {
            this._cachedLang = bcp47;
            this._lastLangCheckLen = textLen;
        }

        return this._cachedLang;
    }

    /**
     * Called when the server sends session.created. Now safe to configure the session.
     */
    _onSessionCreated(config) {
        const gen = this._connGeneration;

        // Send session configuration
        const sessionUpdate = this.protocol.buildSessionUpdate(config.model);
        this.ws.send(JSON.stringify(sessionUpdate));
        this.logger.debug(`Sent session update: ${JSON.stringify(sessionUpdate)}`);

        if (this.protocolName === 'vllm') {
            // vLLM requires commit(false) on an empty buffer to arm the pipeline,
            // BEFORE any audio is sent. Delay to let the server process session.update,
            // then send commit, then emit ready so audio starts flowing.
            const t1 = setTimeout(() => {
                if (gen !== this._connGeneration) return;
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                const commit = this.protocol.buildCommit(false);
                this.ws.send(JSON.stringify(commit));
                this.logger.debug('Sent initial commit (vLLM) to arm pipeline');

                const t2 = setTimeout(() => {
                    if (gen !== this._connGeneration) return;
                    this._sessionReady = true;
                    this.emit('ready');
                    this.startSegmentationTimer();
                }, 200);
                this._setupTimers.push(t2);
            }, 500);
            this._setupTimers.push(t1);
        } else {
            this._sessionReady = true;
            this.emit('ready');
        }
    }

    getMqttPayload(text, lang) {
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
        this._drainCommitTime = 0;
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
                    this.handlePartial(event.data.text);
                    break;

                case 'final':
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

            if (!this.startTime) {
                this.startTime = Date.now();
            }

            const lang = this.detectLanguage(this.accumulatedText);
            const payload = this.getMqttPayload(this.accumulatedText, lang);
            this.emit('transcribing', payload);
            this.logger.debug(`ASR partial transcription: ${this.accumulatedText}`);
        }
    }

    /**
     * Handle a final transcription event (from OpenAI protocol).
     */
    handleFinal(text) {
        if (!text || text.trim().length === 0) return;

        if (!this.startTime) {
            this.startTime = Date.now();
        }

        const lang = this.detectLanguage(text, true);
        const payload = this.getMqttPayload(text, lang);
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
        const payload = this.getMqttPayload(trimmedText, lang);
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
     * Segmentation strategy (priority order):
     * 1. Hard max words exceeded → force cut at last punctuation or word boundary
     * 2. Soft max words + sentence-ending punctuation → cut
     * 3. Silence > silenceMs + sentence-ending punctuation + min words → cut (sentence boundary)
     * 4. Silence > punctSilenceMs + sentence-ending punctuation + soft max words → cut (long sentence)
     * 5. Silence > hardSilenceMs + min words → cut (hard fallback, no punctuation needed)
     */
    startSegmentationTimer() {
        this.segmentationTimer = setInterval(() => {
            if (!this.accumulatedText || this.accumulatedText.trim().length === 0) return;
            if (!this.lastDeltaTime) return;

            const now = Date.now();
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
                    const payload = this.getMqttPayload(emitText, lang);
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

            // Priority 5: Hard silence — commit-drain approach.
            // Instead of emitting immediately, send a commit to flush the server's
            // pending tokens (e.g. trailing punctuation), then wait a grace period.
            if (!shouldEmit && wordCount >= this.minWords && silenceDuration > this.hardSilenceMs) {
                if (!this._draining) {
                    // Enter drain: send commit, wait for server to flush
                    this._draining = true;
                    this._drainCommitTime = now;
                    this._sendCommit();
                    this.logger.debug(`Hard silence ${silenceDuration}ms: sent commit, draining...`);
                    return;
                }

                if (this.lastDeltaTime > this._drainCommitTime) {
                    // New tokens arrived after commit — exit drain, back to normal accumulation
                    this._draining = false;
                    return;
                }

                if (now - this._drainCommitTime > DRAIN_GRACE_MS) {
                    // Grace period expired, server sent nothing — emit as-is
                    this._draining = false;
                    shouldEmit = true;
                    reason = `hard silence + drain timeout ${now - this._drainCommitTime}ms`;
                }
            }

            if (shouldEmit) {
                this._emitSegment(reason);
            }
        }, SEGMENTATION_CHECK_MS);
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

    _sendCommit() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.protocol) {
            const commit = this.protocol.buildCommit(false);
            this.ws.send(JSON.stringify(commit));
        }
    }

    transcribe(buffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this._sessionReady) {
            // Ensure we have a Node.js Buffer (CircularBuffer returns Uint8Array)
            const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
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
        } else if (!this._transcribeWarnThrottled) {
            this._transcribeWarnThrottled = true;
            this.logger.warn("OpenAI Streaming ASR: WebSocket not ready, dropping audio");
            setTimeout(() => { this._transcribeWarnThrottled = false; }, 5000);
        }
    }

    stop() {
        // Invalidate current connection generation so stale handlers are ignored
        this._connGeneration++;

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

        // Send commit to signal end of stream
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.protocol) {
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
