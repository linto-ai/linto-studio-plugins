const { AudioConfig, PropertyId, AudioInputStream, SpeechConfig, SpeechTranslationConfig, TranslationRecognizer, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
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

    getTargetLanguages() {
        const { translations } = this.channel;
        if (!translations || !translations.length) {
            return;
        }

        return translations.map(lang => lang.split('-')[0]);
    }

    getMqttPayload(result) {
        let translations = {};
        if (result.translations) {
            translations = Object.fromEntries(this.getTargetLanguages().map((key, i) => [key, result.translations.get(key)]));
        }
        const lang = result.language ? result.language : this.channel.transcriberProfile.config.languages[0].candidate;
        return {
            "astart": this.startedAt,
            "text": result.text,
            "translations": translations,
            "start": result.offset / 10000000,
            "end": (result.offset + result.duration) / 10000000,
            "lang": lang,
            "locutor": null // TODO: might use speaker diarization
        };
    }

    start() {
        this.startedAt = new Date().toISOString();
        const { transcriberProfile, translations } = this.channel;

        if (transcriberProfile) {
            if (transcriberProfile.config.languages.length === 1) {
                if (translations && translations.length) {
                    this.startMonoTranslation();
                }
                else {
                    this.startMono();
                }
            } else {
                if (translations && translations.length) {
                    this.startMultiTranslation();
                }
                else {
                    this.startMulti();
                }
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
        const { config } = this.channel.transcriberProfile;
        const speechConfig = SpeechConfig.fromSubscription(config.key, config.region);
        speechConfig.endpointId = config.languages[0]?.endpoint;
        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);
        this.recognizer = new SpeechRecognizer(speechConfig, audioConfig);
        this.emit('connecting');

        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription: ${e.result.text}`);
            this.emit('transcribing', this.getMqttPayload(e.result));
        };

        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.RecognizedSpeech) {
                debug(`Microsoft ASR final transcription: ${e.result.text}`);
                this.emit('transcribed', this.getMqttPayload(e.result));
            }
        };

        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    startMonoTranslation() {
        debug("Microsoft ASR starting mono transcription with translation");
        const { config } = this.channel.transcriberProfile;
        const speechConfig = SpeechTranslationConfig.fromSubscription(config.key, config.region);
        speechConfig.speechRecognitionLanguage = config.languages[0]?.candidate;
        speechConfig.endpointId = config.languages[0]?.endpoint;

        const targetLanguages = this.getTargetLanguages();
        for (const targetLanguage of targetLanguages) {
            speechConfig.addTargetLanguage(targetLanguage);
        }

        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);
        this.recognizer = new TranslationRecognizer(speechConfig, audioConfig);
        this.emit('connecting');

        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription: ${e.result.text}`);
            for(const targetLanguage of targetLanguages) {
                debug(`Microsoft ASR partial translation: ${targetLanguage} -> ${e.result.translations.get(targetLanguage)}`);
            }
            this.emit('transcribing', this.getMqttPayload(e.result));
        };

        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.TranslatedSpeech) {
                debug(`Microsoft ASR final transcription: ${e.result.text}`);
                for(const targetLanguage of targetLanguages) {
                    debug(`Microsoft ASR final translation: ${targetLanguage} -> ${e.result.translations.get(targetLanguage)}`);
                }
                this.emit('transcribed', this.getMqttPayload(e.result));
            }
        };

        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    startMultiTranslation() {
        debug("Microsoft ASR starting multi transcription with translation");
        const { config } = this.channel.transcriberProfile;

        // Speech config
        const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
        const speechConfig = SpeechTranslationConfig.fromEndpoint(new URL(universalEndpoint), config.key);
        speechConfig.speechRecognitionLanguage = config.languages[0].candidate;
        speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
        speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

        // Auto detect source language
        const candidates = config.languages.map(language => {
            return language.endpoint ? SourceLanguageConfig.fromLanguage(language.candidate, language.endpoint) : SourceLanguageConfig.fromLanguage(language.candidate);
        });
        const autoDetectSourceLanguageConfig = AutoDetectSourceLanguageConfig.fromSourceLanguageConfigs(candidates);

        // Target language
        const targetLanguages = this.getTargetLanguages();
        for (const targetLanguage of targetLanguages) {
            speechConfig.addTargetLanguage(targetLanguage);
        }

        // Audio config
        const audioConfig = AudioConfig.fromStreamInput(this.pushStream);

        // Translation Recognizer
        this.recognizer = TranslationRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);

        this.emit('connecting');

        this.recognizer.recognizing = (s, e) => {
            debug(`Microsoft ASR partial transcription: ${e.result.text}`);
            for(const targetLanguage of targetLanguages) {
                debug(`Microsoft ASR partial translation: ${targetLanguage} -> ${e.result.translations.get(targetLanguage)}`);
            }
            this.emit('transcribing', this.getMqttPayload(e.result));
        };

        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.TranslatedSpeech) {
                debug(`Microsoft ASR final transcription: ${e.result.text}`);
                for(const targetLanguage of targetLanguages) {
                    debug(`Microsoft ASR final translation: ${targetLanguage} -> ${e.result.translations.get(targetLanguage)}`);
                }
                this.emit('transcribed', this.getMqttPayload(e.result));
            }
        };

        this.recognizer.startContinuousRecognitionAsync(() => {
            debug("Microsoft ASR recognition started");
            this.emit('ready');
        });
    }

    startMulti() {
        const { config } = this.channel.transcriberProfile;
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
            this.emit('transcribing', this.getMqttPayload(e.result));
        };

        this.recognizer.recognized = (s, e) => {
            if (e.result.reason === ResultReason.RecognizedSpeech) {
                debug(`Microsoft ASR final transcription ${e.result.language}: ${e.result.text}`);
                this.emit('transcribed', this.getMqttPayload(e.result));
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
