const speech = require('@google-cloud/speech');
const { Security } = require('live-srt-lib');
const logger = require('../../logger');
const EventEmitter = require('eventemitter3');

// Google v1 streamingRecognize has a ~5 min hard limit per stream; restart proactively.
const STREAM_RESTART_MS = 240000; // 4 min

class GoogleTranscriber extends EventEmitter {
    static ERROR_MAP = {
        3: 'BAD_REQUEST_PARAMETERS',   // INVALID_ARGUMENT
        4: 'SERVICE_TIMEOUT',          // DEADLINE_EXCEEDED
        7: 'FORBIDDEN',                // PERMISSION_DENIED
        8: 'TOO_MANY_REQUESTS',        // RESOURCE_EXHAUSTED
        13: 'SERVICE_ERROR',           // INTERNAL
        14: 'CONNECTION_FAILURE',      // UNAVAILABLE
        16: 'AUTHENTICATION_FAILURE',  // UNAUTHENTICATED
    };

    constructor(session, channel) {
        super();
        this.session = session;
        this.channel = channel;
        this.logger = logger.getChannelLogger(session.id, channel.id);
        this.client = null;
        this.recognizeStream = null;
        this.isStreaming = false;
        this.restartTimer = null;
        this.lastPartial = null;
        this.lastEnd = 0;
        this._streamOffset = 0; // seconds accumulated across stream restarts (monotonic timestamps)
        this.startedAt = null;
        this.emit('closed');
    }

    _parseCredentials() {
        const { config } = this.channel.transcriberProfile;
        if (!config.credentials) throw new Error('Google ASR: missing credentials');
        const decrypted = new Security().safeDecrypt(config.credentials);
        try { return JSON.parse(decrypted); }
        catch (e) { throw new Error('Google ASR: invalid service-account JSON: ' + e.message); }
    }

    _buildRequest() {
        const { config } = this.channel.transcriberProfile;
        const langs = config.languages.map(l => l.candidate);
        const recognitionConfig = {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            audioChannelCount: 1,
            languageCode: langs[0],
            enableAutomaticPunctuation: true,
        };
        const alternates = langs.slice(1, 4); // Google allows up to 3 alternates
        if (alternates.length > 0) recognitionConfig.alternativeLanguageCodes = alternates;
        if (config.model) recognitionConfig.model = config.model;
        // Word offsets give us a real per-segment start time; without them every
        // result would inherit the previous final's end and absorb inter-segment
        // silence into the caption.
        recognitionConfig.enableWordTimeOffsets = true;
        if (this.channel.diarization) {
            recognitionConfig.diarizationConfig = {
                enableSpeakerDiarization: true,
                minSpeakerCount: 1,
                maxSpeakerCount: 6,
            };
        }
        return { config: recognitionConfig, interimResults: true };
    }

    // Convert a Google Duration ({seconds, nanos}) to fractional seconds.
    static _durationToSeconds(d) {
        if (!d) return null;
        return Number(d.seconds || 0) + Number(d.nanos || 0) / 1e9;
    }

    formatResult(result) {
        const alt = (result.alternatives && result.alternatives[0]) || {};
        const text = alt.transcript || '';
        const end = this._streamOffset + (GoogleTranscriber._durationToSeconds(result.resultEndTime) || 0);
        // Prefer the first word's startTime (requires enableWordTimeOffsets) so a
        // segment following silence is timestamped at the actual utterance start
        // rather than stretched back to the previous final. Fall back to lastEnd
        // for partials/results without word timings.
        let start = this.lastEnd;
        const words = Array.isArray(alt.words) ? alt.words : [];
        if (words.length && words[0].startTime) {
            start = this._streamOffset + (GoogleTranscriber._durationToSeconds(words[0].startTime) || 0);
        }
        let locutor = null;
        if (this.channel.diarization && words.length) {
            // First tagged speaker in the segment — consistent with the Amazon
            // provider so a speaker change mid-segment is attributed the same way.
            const tagged = words.find(w => w.speakerTag);
            if (tagged) locutor = 'spk_' + tagged.speakerTag;
        }
        const lang = result.languageCode || this.channel.transcriberProfile.config.languages[0].candidate;
        return { astart: this.startedAt, text, translations: {}, start, end, lang, locutor };
    }

    // Detach every listener and close a stream we are done with. Detaching ALL
    // events (not just 'error') is load-bearing: a duplex gRPC stream keeps
    // delivering buffered 'data' after end(), and the wrapper keeps our
    // listeners attached across pause()/stop(); a leaked 'data' handler would
    // replay _onData and publish a phantom final (wrong timestamp after a
    // restart bumped _streamOffset, and an extra segmentId since Google never
    // sets isPrimary).
    _teardownStream(stream) {
        if (!stream) return;
        try { stream.removeAllListeners(); stream.end(); } catch (e) {}
    }

    _startStream() {
        const request = this._buildRequest();
        const stream = this.client.streamingRecognize(request);
        this.recognizeStream = stream;
        // Bind the stream identity into the handlers so a late callback from a
        // stream we already replaced/stopped is ignored even if a listener
        // somehow survived teardown (defense in depth alongside _teardownStream).
        stream
            .on('error', (err) => this._onError(err, stream))
            .on('data', (data) => this._onData(data, stream));
        this.restartTimer = setTimeout(() => this._restartStream(), STREAM_RESTART_MS);
    }

    _restartStream() {
        if (!this.isStreaming) return;
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        this._streamOffset = this.lastEnd; // continue timestamps from where we stopped
        const old = this.recognizeStream;
        this.recognizeStream = null;
        this._teardownStream(old);
        this.logger.info('Google ASR: restarting stream (duration limit)');
        this._startStream();
    }

    _onError(err, stream) {
        // Ignore errors from a stream we already replaced or stopped.
        if (stream && stream !== this.recognizeStream) return;
        // OUT_OF_RANGE(11): stream exceeded max duration -> restart silently
        if (err && (err.code === 11 || /exceed/i.test(err.message || ''))) {
            this.logger.warn('Google ASR: stream duration exceeded, restarting');
            this._restartStream();
            return;
        }
        if (!this.isStreaming) return;
        this.logger.error('Google ASR error: ' + err.message + ' (code ' + err.code + ')');
        this.emit('error', GoogleTranscriber.ERROR_MAP[err.code] || 'RUNTIME_ERROR');
    }

    _onData(data, stream) {
        // Ignore late buffered data from a stream we already replaced or stopped.
        if (stream && stream !== this.recognizeStream) return;
        if (!data.results || !data.results.length) return;
        const result = data.results[0];
        if (!result.alternatives || !result.alternatives.length) return;
        const payload = this.formatResult(result);
        if (!payload.text || payload.text.trim().length === 0) return;
        if (result.isFinal) {
            this.lastEnd = payload.end;
            this.lastPartial = null;
            this.emit('transcribed', payload);
        } else {
            this.lastPartial = payload;
            this.emit('transcribing', payload);
        }
    }

    async start() {
        this.startedAt = new Date().toISOString();
        this.lastEnd = 0;
        this._streamOffset = 0;
        this.lastPartial = null;
        this.emit('connecting');
        try {
            const creds = this._parseCredentials();
            const { config } = this.channel.transcriberProfile;
            this.client = new speech.SpeechClient({
                projectId: config.projectId || creds.project_id,
                credentials: { client_email: creds.client_email, private_key: creds.private_key },
            });
            this.isStreaming = true;
            this._startStream();
            this.emit('ready');
            this.logger.info('Google ASR started (lang=' + config.languages[0].candidate + ', diarization=' + !!this.channel.diarization + ')');
        } catch (err) {
            this.logger.error('Google ASR failed to start: ' + err.message);
            this.emit('error', GoogleTranscriber.ERROR_MAP[err.code] || 'RUNTIME_ERROR');
            this.isStreaming = false;
        }
    }

    transcribe(buffer) {
        if (!this.isStreaming || !this.recognizeStream || !this.recognizeStream.writable) {
            if (!this._warnThrottled) {
                this._warnThrottled = true;
                this.logger.warn('Google ASR: stream not ready, dropping audio');
                setTimeout(() => { this._warnThrottled = false; }, 5000);
            }
            return;
        }
        // Respect gRPC backpressure: once the stream asks to drain, drop audio
        // rather than growing an unbounded internal buffer. Upstream CircularBuffer
        // already tolerates gaps and the pipeline keeps flowing.
        if (this.recognizeStream.writableNeedDrain) {
            if (!this._backpressureWarned) {
                this._backpressureWarned = true;
                this.logger.warn('Google ASR: backpressure, dropping audio until drain');
                this.recognizeStream.once('drain', () => { this._backpressureWarned = false; });
            }
            return;
        }
        // CircularBuffer yields a Uint8Array; the gRPC stream expects a Node Buffer.
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        try { this.recognizeStream.write(buf); }
        catch (err) { this.logger.warn('Google ASR: write failed: ' + err.message); }
    }

    async stop() {
        this.logger.info('Google ASR: stopping');
        this.isStreaming = false;
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        if (this.lastPartial && this.lastPartial.text && this.lastPartial.text.trim().length) {
            this.emit('transcribed', this.lastPartial);
            this.lastPartial = null;
        }
        this._teardownStream(this.recognizeStream);
        this.recognizeStream = null;
        if (this.client) { try { await this.client.close(); } catch (e) {} this.client = null; }
        this.emit('closed');
    }
}

module.exports = GoogleTranscriber;
