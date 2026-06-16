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
        if (this.channel.diarization) {
            recognitionConfig.diarizationConfig = {
                enableSpeakerDiarization: true,
                minSpeakerCount: 1,
                maxSpeakerCount: 6,
            };
        }
        return { config: recognitionConfig, interimResults: true };
    }

    formatResult(result) {
        const alt = (result.alternatives && result.alternatives[0]) || {};
        const text = alt.transcript || '';
        const ret = result.resultEndTime || {};
        const rel = Number(ret.seconds || 0) + Number(ret.nanos || 0) / 1e9;
        const end = this._streamOffset + rel;
        let locutor = null;
        if (this.channel.diarization && Array.isArray(alt.words) && alt.words.length) {
            const tagged = alt.words.filter(w => w.speakerTag);
            if (tagged.length) locutor = 'spk_' + tagged[tagged.length - 1].speakerTag;
        }
        const lang = result.languageCode || this.channel.transcriberProfile.config.languages[0].candidate;
        return { astart: this.startedAt, text, translations: {}, start: this.lastEnd, end, lang, locutor };
    }

    _startStream() {
        const request = this._buildRequest();
        this.recognizeStream = this.client
            .streamingRecognize(request)
            .on('error', (err) => this._onError(err))
            .on('data', (data) => this._onData(data));
        this.restartTimer = setTimeout(() => this._restartStream(), STREAM_RESTART_MS);
    }

    _restartStream() {
        if (!this.isStreaming) return;
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        this._streamOffset = this.lastEnd; // continue timestamps from where we stopped
        const old = this.recognizeStream;
        this.recognizeStream = null;
        if (old) { try { old.removeAllListeners('error'); old.end(); } catch (e) {} }
        this.logger.info('Google ASR: restarting stream (duration limit)');
        this._startStream();
    }

    _onError(err) {
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

    _onData(data) {
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
        if (this.isStreaming && this.recognizeStream && this.recognizeStream.writable) {
            // CircularBuffer yields a Uint8Array; the gRPC stream expects a Node Buffer.
            const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            try { this.recognizeStream.write(buf); }
            catch (err) { this.logger.warn('Google ASR: write failed: ' + err.message); }
        } else if (!this._warnThrottled) {
            this._warnThrottled = true;
            this.logger.warn('Google ASR: stream not ready, dropping audio');
            setTimeout(() => { this._warnThrottled = false; }, 5000);
        }
    }

    async stop() {
        this.logger.info('Google ASR: stopping');
        this.isStreaming = false;
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        if (this.lastPartial && this.lastPartial.text && this.lastPartial.text.trim().length) {
            this.emit('transcribed', this.lastPartial);
            this.lastPartial = null;
        }
        if (this.recognizeStream) {
            try { this.recognizeStream.removeAllListeners('error'); this.recognizeStream.end(); } catch (e) {}
            this.recognizeStream = null;
        }
        if (this.client) { try { await this.client.close(); } catch (e) {} this.client = null; }
        this.emit('closed');
    }
}

module.exports = GoogleTranscriber;
