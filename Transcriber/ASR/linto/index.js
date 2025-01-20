const WebSocket = require('ws');
const { logger } = require('live-srt-lib')
const EventEmitter = require('eventemitter3');

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

    constructor(channel) {
        super();
        this.channel = channel;
        this.ws = null;
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

        this.ws.on('open', () => {
            logger.debug("WebSocket connection established");
            this.ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
            this.emit('ready');
        });

        this.ws.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.text) {
                const result = this.getMqttPayload(data.text);
                this.lastEndTime = result.end;
                this.emit('transcribed', result);
                logger.debug(`ASR transcription: ${data.text}`);
            } else if (data.partial) {
                if (!this.startTime) {
                    this.startTime = Date.now();
                }
                const result = this.getMqttPayload(data.partial);
                this.emit('transcribing', result);
                logger.debug(`ASR partial transcription: ${data.partial}`);
            }
        });

        this.ws.on('error', (error) => {
            logger.debug(`WebSocket error: ${error}`);
            this.emit('error', LintoTranscriber.ERROR_MAP[4]);
            this.stop();

            // don't restart if it's a critical failure
            if (error.code && LintoTranscriber.CRITICAL_FAILURES.has(error.code)) {
                return;
            }
            this.start();
        });

        this.ws.on('close', (code, reason) => {
            const error = LintoTranscriber.ERROR_MAP[code] || 'UNKNOWN_ERROR';
            logger.debug(`WebSocket closed: ${code} ${reason}`);
            this.emit('closed', { code, reason, error });
        });
    }

    transcribe(buffer) {
        if (this.ws) {
            this.ws.send(buffer);
        } else {
            logger.debug("Linto ASR transcriber can't decode buffer");
        }
    }

    stop() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = LintoTranscriber;
