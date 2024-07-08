const { AudioConfig, PropertyId, AudioInputStream, SpeechConfig, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const debug = require('debug')(`transcriber:microsoft`);
const EventEmitter = require('eventemitter3');

class MicrosoftTranscriber extends EventEmitter {
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
    }

    constructor(channel) {
        super();
        this.channel = channel;
        this.recognizer = null;
        this.pushStream = AudioInputStream.createPushStream();
        this.emit('closed');
    }

    start() {
        this.startedAt = new Date().toISOString();
        const { transcriber_profile } = this.channel;

        if (transcriber_profile) {
            if (transcriber_profile.config.languages.length === 1) {
                this.startMono();
            } else {
                this.startMulti();
            }
        } 

        this.recognizer.canceled = (s, e) => {
            debug(`Microsoft ASR canceled: ${e.errorDetails}`);
            const error = MicrosoftTranscriber.ERROR_MAP[e.errorCode];
            this.emit('error', error);
            this.stop();
        };

        this.recognizer.sessionStopped = (s, e) => {
            debug(`Microsoft ASR session stopped: ${e.reason}`);
            this.emit('closed', e.reason);
        };
    }

    startMono() {
        debug("Microsoft ASR starting mono transcription");
        const { config } = this.channel.transcriber_profile;
        const speechConfig = SpeechConfig.fromSubscription(config.key, config.region);
        speechConfig.endpointId = config.languages[0]?.endpoint;
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
                    "astart": this.startedAt,
                    "text": e.result.text,
                    "start": e.result.offset / 10000000,
                    "end": (e.result.offset + e.result.duration) / 10000000,
                    "lang": config.languages[0].candidate,
                    "locutor": null // TODO: might use speaker diarization
                };
                this.emit('transcribed', result);
            }
        };

        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    startMulti() {
        const { config } = this.channel.transcriber_profile;
        const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
        const speechConfig = SpeechConfig.fromEndpoint(new URL(universalEndpoint), config.key);
        speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
        speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

        const candidates = config.languages.map(language => {
            return language.endpoint ? SourceLanguageConfig.fromLanguage(language.candidate, language.endpoint) : SourceLanguageConfig.fromLanguage(language.candidate);
        });

        const autoDetectSourceLanguageConfig = AutoDetectSourceLanguageConfig.fromSourceLanguageConfigs(candidates);
        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);
        this.recognizer = SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);

        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription ${e.result.language}: ${e.result.text}`);
            this.emit('transcribing', e.result.text);
        };

        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.RecognizedSpeech) {
                debug(`Microsoft ASR final transcription ${e.result.language}: ${e.result.text}`);
                const result = {
                    "astart": this.startedAt,
                    "text": e.result.text,
                    "start": e.result.offset / 10000000,
                    "end": (e.result.offset + e.result.duration) / 10000000,
                    "lang": e.result.language,
                    "locutor": null // TODO: might use speaker diarization
                };
                this.emit('transcribed', result);
            }
        };

        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    transcribe(buffer) {
        if (this.recognizer) {
            this.pushStream.write(buffer);
        } else {
            debug("Microsoft ASR transcriber can't decode buffer");
        }
    }

    stop() {
        if (this.recognizer) {
            this.recognizer.stopContinuousRecognitionAsync(() => {
                debug("ASR recognition stopped");
                this.recognizer.close();
                this.recognizer = null;
                this.emit('closed');
            });
        }
    }
}

module.exports = MicrosoftTranscriber;
