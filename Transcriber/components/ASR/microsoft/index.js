const { AudioConfig, AudioInputStream, SpeechConfig, SpeechRecognizer, ResultReason } = require('microsoft-cognitiveservices-speech-sdk');
const debug = require('debug')(`transcriber:microsoft`);
const stream = require('stream');
const EventEmitter = require('events');

class MicrosoftTranscriber extends EventEmitter {
    constructor(channel=null, transcriberProfile=null) {
        super();
        this.channel = channel;
        this.transcriberProfile = transcriberProfile;
        this.recognizer = null;
        this.pushStream = AudioInputStream.createPushStream();
        this.emit('closed')
    }

    start() {
        if (this.transcriberProfile && this.channel){
            this.ASR_API_KEY = this.transcriberProfile.config.key;
            this.ASR_REGION = this.transcriberProfile.config.region;
            this.ASR_LANGUAGE = this.channel.language;
            this.ASR_ENDPOINT = this.transcriberProfile.config.endpoint
        } else {
            this.ASR_API_KEY = process.env.ASR_API_KEY;
            this.ASR_REGION = process.env.ASR_REGION;
            this.ASR_LANGUAGE = process.env.ASR_LANGUAGE;
            this.ASR_ENDPOINT = process.env.ASR_ENDPOINT;
        }
        const speechConfig = SpeechConfig.fromSubscription(this.ASR_API_KEY, this.ASR_REGION);
        // Uses custom endpoint if provided
        if (this.ASR_ENDPOINT) speechConfig.endpointId = this.ASR_ENDPOINT;
        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);
        this.recognizer = new SpeechRecognizer(speechConfig, audioConfig);
        this.emit('connecting');
        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription: ${e.result.text}`);
            this.emit('transcribing', e.result.text);
        };
        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.RecognizedSpeech) {
                debug(`Microsoft ASR final transcription: ${e.result.text}`);
                const result = {
                    "text": e.result.text,
                    "start": e.result.offset / 10000000, // Convert from 100-nanosecond units to seconds
                    "end":  (e.result.offset + e.result.duration) / 10000000, // Convert from 100-nanosecond units to seconds
                    "lang": e.result.language || this.ASR_LANGUAGE, //TODO : might use language detection
                    "locutor": null //TODO : might use speaker diarization
                }
                this.emit('transcribed', result);
            }
        };
        this.recognizer.canceled = (s, e) => {
            debug(`Microsoft ASR canceled: ${e.reason}`);
            this.stop()
            this.emit('error', e.reason);
        };
        this.recognizer.sessionStopped = (s, e) => {
            debug(`Microsoft ASR session stopped: ${e.reason}`);
            this.emit('close', e.reason);
        };
        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    transcribe(buffer) {
        if (this.recognizer) {
            this.pushStream.write(buffer);
        }
    }

    stop() {
        if (this.recognizer) {
            this.recognizer.stopContinuousRecognitionAsync(() => {
                debug("ASR recognition stopped");
                this.recognizer.close();
                this.recognizer = null;
            });
        }
    }
}

module.exports = MicrosoftTranscriber;