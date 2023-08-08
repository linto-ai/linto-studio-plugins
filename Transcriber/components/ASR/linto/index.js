const WebSocket = require('ws');
const debug = require('debug')(`transcriber:linto`);
const EventEmitter = require('events');

class LintoTranscriber extends EventEmitter {
    constructor(channel=null, transcriberProfile=null) {
        super();
        this.channel = channel;
        this.transcriberProfile = transcriberProfile;
        this.ws = null;
        this.emit('closed')
    }

    start() {
        //reset time counters
        this.startTime = null;
        this.lastEndTime = 0;
        this.emit('connecting');
        if (this.transcriberProfile && this.channel){
            this.ASR_LANGUAGE = this.channel.language;
            this.ASR_ENDPOINT = this.transcriberProfile.config.endpoint
        } else {
            this.ASR_LANGUAGE = process.env.ASR_LANGUAGE;
            this.ASR_ENDPOINT = process.env.ASR_ENDPOINT;
        }
        this.ws = new WebSocket(this.ASR_ENDPOINT);
 
        this.ws.on('open', () => {
            debug("WebSocket connection established");
            this.ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
            this.emit('ready');
        });

        this.ws.on('message', message => {
            const data = JSON.parse(message);
            if (data.text) {
                const result = {
                    "text": data.text,
                    "start": this.lastEndTime,
                    "end": (this.lastEndTime + (Date.now() - this.startTime - process.env.MIN_AUDIO_BUFFER/1000)) / 1000,
                    "lang": this.ASR_LANGUAGE,
                    "locutor": null
                }
                this.lastEndTime = result.end;
                this.emit('transcribed', result);
                debug(`ASR transcription: ${data.text}`);
            } else if (data.partial){
                if (!this.startTime) {
                    this.startTime = Date.now();
                }
                this.emit('transcribing', data);
                debug(`ASR partial transcription: ${data.partial}`);
            }
        });

        this.ws.on('error', error => {
            debug(`WebSocket error: ${error}`);
            this.emit('error', error);
            this.stop();
            this.start();
        });

        this.ws.on('close', (code, reason) => {
            this.emit('close', code, reason);
        });
    }

    transcribe(buffer) {
        if (this.ws) {
            this.ws.send(buffer);
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