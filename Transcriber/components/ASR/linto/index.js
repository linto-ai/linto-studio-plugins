const WebSocket = require('ws');
const debug = require('debug')(`transcriber:linto`);
const EventEmitter = require('events');

class LintoTranscriber extends EventEmitter {
    constructor(transcriberProfile=null) {
        super();
        this.transcriberProfile = transcriberProfile;
        this.ws = null;
        this.emit('closed')
    }

    start() {
        // Create dummy transcriber profile from environment variables (when transcriber used as standalone, without enrollment)
        if (!this.transcriberProfile) {
            this.transcriberProfile = {
                config: {
                    type: 'linto',
                    languages: [{ "candidate": process.env.ASR_LANGUAGE, "endpoint": process.env.ASR_ENDPOINT || null }]
                }
            };
        }
        //reset time counters
        this.startTime = null;
        this.lastEndTime = 0;
        this.emit('connecting');
        // LinTO only supports one language, frist language in the transcriber profile is used
        this.ws = new WebSocket(this.transcriberProfile.config.languages[0].endpoint);
 
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