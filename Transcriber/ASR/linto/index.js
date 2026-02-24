const WebSocket = require('ws');
const logger = require('../../logger')
const EventEmitter = require('eventemitter3');

const RECONNECT_DELAY_MS = 2000;

class LintoTranscriber extends EventEmitter {
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
        this._connGeneration = 0;
        this._reconnectTimer = null;
        this.emit('closed');
    }

    getMqttPayload(text) {
        return {
            "astart": this.startedAt,
            "text": text,
            "translations": {},
            "start": this.lastEndTime,
            "end": (this.lastEndTime + (Date.now() - this.startTime - process.env.MIN_AUDIO_BUFFER / 1000)) / 1000,
            "lang": process.env.ASR_LANGUAGE,
            "locutor": null
        };
    }

    start() {
        this.startedAt = new Date().toISOString();
        const { transcriberProfile } = this.channel;

        if (!transcriberProfile) {
            return;
        }

        this.startTime = null;
        this.lastEndTime = 0;
        this.emit('connecting');

        const endpoint = transcriberProfile.config.languages[0].endpoint;
        this.ws = new WebSocket(endpoint);
        this._connGeneration++;
        const gen = this._connGeneration;

        this.ws.on('open', () => {
            this.logger.debug("WebSocket connection established");
            this.ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
            this.emit('ready');
        });

        this.ws.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.text) {
                const result = this.getMqttPayload(data.text);
                this.lastEndTime = result.end;
                this.emit('transcribed', result);
                this.logger.debug(`ASR transcription: ${data.text}`);
            } else if (data.partial) {
                if (!this.startTime) {
                    this.startTime = Date.now();
                }
                const result = this.getMqttPayload(data.partial);
                this.emit('transcribing', result);
                this.logger.debug(`ASR partial transcription: ${data.partial}`);
            }
        });

        this.ws.on('error', (error) => {
            if (gen !== this._connGeneration) return;
            this.logger.warn(`WebSocket error: ${error}`);
            this.emit('error', LintoTranscriber.ERROR_MAP[4]);
            this.stop();

            // don't restart if it's a critical failure
            if (error.code && LintoTranscriber.CRITICAL_FAILURES.has(error.code)) {
                return;
            }
            this.logger.info(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
            this._reconnectTimer = setTimeout(() => this.start(), RECONNECT_DELAY_MS);
        });

        this.ws.on('close', (code, reason) => {
            if (gen !== this._connGeneration) return;
            this.logger.debug(`WebSocket closed: ${code} ${reason}`);
            this.emit('closed', { code, reason, error: LintoTranscriber.ERROR_MAP[code] || 'UNKNOWN_ERROR' });
        });
    }

    transcribe(buffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(buffer);
        } else if (!this._transcribeWarnThrottled) {
            this._transcribeWarnThrottled = true;
            this.logger.warn("LinTO ASR: WebSocket not ready, dropping audio");
            setTimeout(() => { this._transcribeWarnThrottled = false; }, 5000);
        }
    }

    stop() {
        this._connGeneration++;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = LintoTranscriber;
