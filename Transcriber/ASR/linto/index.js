const WebSocket = require('ws');
const debug = require('debug')(`transcriber:linto`);
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

    constructor(channel) {
        super();
        this.channel = channel;
        this.ws = null;
        this.emit('closed');
    }

    start() {
        this.startedAt = new Date().toISOString();
        const { transcriber_profile } = this.channel;

        if (!transcriber_profile) {
            return;
        }

        this.startTime = null;
        this.lastEndTime = 0;
        this.emit('connecting');

        const endpoint = transcriber_profile.config.languages[0].endpoint;
        this.ws = new WebSocket(endpoint);

        this.ws.on('open', () => {
            debug("WebSocket connection established");
            this.ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
            this.emit('ready');
        });

        this.ws.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.text) {
                const result = {
                    astart: this.startedAt,
                    text: data.text,
                    translations: {},
                    start: this.lastEndTime,
                    end: (this.lastEndTime + (Date.now() - this.startTime - process.env.MIN_AUDIO_BUFFER / 1000)) / 1000,
                    lang: process.env.ASR_LANGUAGE,
                    locutor: null
                };
                this.lastEndTime = result.end;
                this.emit('transcribed', result);
                debug(`ASR transcription: ${data.text}`);
            } else if (data.partial) {
                if (!this.startTime) {
                    this.startTime = Date.now();
                }
                this.emit('transcribing', {transcription: data.partial, translations: {}});
                debug(`ASR partial transcription: ${data.partial}`);
            }
        });

        this.ws.on('error', (error) => {
            debug(`WebSocket error: ${error}`);
            this.emit('error', LintoTranscriber.ERROR_MAP[4]);
            this.stop();
            this.start();
        });

        this.ws.on('close', (code, reason) => {
            const error = LintoTranscriber.ERROR_MAP[code] || 'UNKNOWN_ERROR';
            debug(`WebSocket closed: ${code} ${reason}`);
            this.emit('closed', { code, reason, error });
        });
    }

    transcribe(buffer) {
        if (this.ws) {
            this.ws.send(buffer);
        } else {
            debug("Linto ASR transcriber can't decode buffer");
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
