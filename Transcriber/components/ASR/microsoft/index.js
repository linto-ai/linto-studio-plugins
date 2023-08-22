const { AudioConfig, AudioInputStream, SpeechConfig, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult } = require('microsoft-cognitiveservices-speech-sdk');
const debug = require('debug')(`transcriber:microsoft`);
const stream = require('stream');
const EventEmitter = require('events');

class MicrosoftTranscriber extends EventEmitter {
    constructor(transcriberProfile = null) {
        super();
        this.transcriberProfile = transcriberProfile;
        this.recognizer = null;
        this.pushStream = AudioInputStream.createPushStream();
        this.emit('closed')
    }

    start() {
        //UTC date and time in ISO format, e.g. 2020-12-31T23:59:59Z
        this.startedAt = new Date().toISOString();
        if (this.transcriberProfile) {
            if (this.transcriberProfile.config.languages.length === 1) {
                this.startMono();
            } else {
                this.startMulti();
            }
        } else {
            // Create dummy transcriber profile from environment variables (when transcriber used as standalone, without enrollment)
            this.transcriberProfile = {
                config: {
                    type: 'microsoft',
                    languages: [{ "candidate": process.env.ASR_LANGUAGE, "endpoint": process.env.ASR_ENDPOINT || null }],
                    key: process.env.ASR_API_KEY,
                    region: process.env.ASR_REGION
                }
            };
            this.startMono();
        }
        // The event signals that the service has stopped processing speech.
        // https://docs.microsoft.com/javascript/api/microsoft-cognitiveservices-speech-sdk/speechrecognitioncanceledeventargs?view=azure-node-latest
        // This can happen for two broad classes of reasons.
        // 1. An error is encountered.
        //    In this case the .errorDetails property will contain a textual representation of the error.
        // 2. Speech was detected to have ended.
        //    This can be caused by the end of the specified file being reached, or ~20 seconds of silence from a microphone input.
        // TODO : mitigate this issue and verify if it is still relevant
        this.recognizer.canceled = (s, e) => {
            debug(`Microsoft ASR canceled: ${e.errorDetails}`);
            this.stop()
            this.emit('error', e.reason);
        };
        this.recognizer.sessionStopped = (s, e) => {
            debug(`Microsoft ASR session stopped: ${e.reason}`);
            this.emit('close', e.reason);
        };
    }

    // One language in the transcriber profile
    startMono() {
        debug("Microsoft ASR starting mono transcription")
        const speechConfig = SpeechConfig.fromSubscription(this.transcriberProfile.config.key, this.transcriberProfile.config.region);
        // Uses custom endpoint if provided, if not, uses default endpoint for region
        speechConfig.endpointId = this.transcriberProfile.config.languages[0]?.endpoint
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
                    "start": e.result.offset / 10000000, // Convert from 100-nanosecond units to seconds
                    "end": (e.result.offset + e.result.duration) / 10000000, // Convert from 100-nanosecond units to seconds
                    "lang": this.transcriberProfile.config.languages[0].candidate,
                    "locutor": null //TODO : might use speaker diarization
                }
                this.emit('transcribed', result);
            }
        };
        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    // Multiple languages in the transcriber profile, auto-detect language
    startMulti() {
        // Currently for speech to text recognition with continuous language identification, you must create a SpeechConfig from the wss://{region}.stt.speech.microsoft.com/speech/universal/v2
        // Language detection with a custom endpoint isn't supported by the Speech SDK for JavaScript.
        // https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification?pivots=programming-language-javascript&tabs=continuous#speech-to-text
        // TODO : /!\ Keep track of this future issue /!\
        // For now, i explicitly skip using custom endpoint if multiple languages are provided
        const candidates = this.transcriberProfile.config.languages.map(lang => lang.candidate);
        const autoDetectSourceLanguageConfig = AutoDetectSourceLanguageConfig.fromLanguages(candidates);
        const universalEndpoint = `wss://${this.transcriberProfile.config.region}.stt.speech.microsoft.com/speech/universal/v2`;
        const speechConfig = SpeechConfig.fromEndpoint(new URL(universalEndpoint), this.transcriberProfile.key);
        // const speechConfig = SpeechConfig.fromSubscription(this.transcriberProfile.config.key, this.transcriberProfile.config.region);
        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);
        this.recognizer = SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription: ${e.result.text}`);
            this.emit('transcribing', e.result.text);
        };
        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.RecognizedSpeech) {
                debug(`Microsoft ASR final transcription: ${e.result.text}`);
                const languageDetectionResult = AutoDetectSourceLanguageResult.fromResult(e.result);
                const detectedLanguage = languageDetectionResult.language;
                const result = {
                    "astart": this.startedAt,
                    "text": e.result.text,
                    "start": e.result.offset / 10000000, // Convert from 100-nanosecond units to seconds
                    "end": (e.result.offset + e.result.duration) / 10000000, // Convert from 100-nanosecond units to seconds
                    "lang": detectedLanguage,
                    "locutor": null //TODO : might use speaker diarization
                }
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