const { AudioConfig, ConversationTranscriber, PropertyId, AudioInputStream, SpeechConfig, SpeechTranslationConfig, TranslationRecognizer, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { Security } = require('live-srt-lib')
const logger = require('../../logger')
const EventEmitter = require('eventemitter3');


class RecognizerListener {
    constructor(transcriber, name) {
        this.transcriber = transcriber;
        this.name = name;
    }

    emitTranscribing(payload) {
        this.transcriber.logger.debug(`${this.name}: Microsoft ASR partial transcription: ${payload.text}`);
        this.transcriber.emit('transcribing', payload);
    }

    emitTranscribed(payload) {
        this.transcriber.logger.debug(`${this.name}: Microsoft ASR final transcription: ${payload.text}`);
        this.transcriber.emit('transcribed', payload);
    }

    handleRecognizing(s, e) {
        this.emitTranscribing(this.transcriber.getMqttPayload(e.result))
    }

    handleRecognized(s, e) {
        if (e.result.reason === ResultReason.RecognizedSpeech || e.result.reason === ResultReason.TranslatedSpeech) {
            this.emitTranscribed(this.transcriber.getMqttPayload(e.result))
        }
    }

    formatErrorMsg(e) {
        let msg = `${this.name}: Microsoft ASR canceled`;
        if (e.errorDetails) {
            msg = `${msg} - ${e.errorDetails}`;
        }
        if (e.errorCode && MicrosoftTranscriber.ERROR_MAP[e.errorCode]) {
            msg = `${msg} - ${MicrosoftTranscriber.ERROR_MAP[e.errorCode]}`;
        }
        return msg;
    }

    async handleCanceled(s, e) {
        // Guard: ignore subsequent canceled events while already stopping
        if (this.transcriber._stopping) return;
        this.transcriber._stopping = true;

        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        this.transcriber.logger.info(`${this.formatErrorMsg(e)}`);
        const error = MicrosoftTranscriber.ERROR_MAP[e.errorCode];
        this.transcriber.emit('error', error);
        await this.transcriber.stop();
    };

    handleSessionStopped(s, e) {
        this.transcriber.logger.info(`${this.name}: Microsoft ASR session stopped: ${e.reason}`);
        this.transcriber.emit('closed', e.reason);
    };

    handleStartContinuousRecognitionAsync() {
        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        this.transcriber.logger.info(`${this.name}: Microsoft ASR recognition started`);
        this.transcriber.emit('ready');
    };

    handleStartContinuousRecognitionAsyncError(error) {
        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        this.transcriber.logger.error(`${this.name}: Microsoft ASR recognition error during startup: ${error}`);
        this.transcriber.emit('error', 'STARTUP_ERROR');
    };

    listen(recognizer) {
        const eventHandlers = {
            "recognizing": this.handleRecognizing,
            "recognized": this.handleRecognized,
            "transcribing": this.handleRecognizing,
            "transcribed": this.handleRecognized,
            "canceled": this.handleCanceled,
            "sessionStopped": this.handleSessionStopped
        };

        const isRecognizer = recognizer instanceof SpeechRecognizer || recognizer instanceof TranslationRecognizer;
        let recognizerEvents = ["canceled", "sessionStopped"];
        let recognizerListenFun = "startContinuousRecognitionAsync";
        if (isRecognizer) {
            recognizerEvents = recognizerEvents.concat(["recognizing", "recognized"]);
        }
        else {
            recognizerEvents = recognizerEvents.concat(["transcribing", "transcribed"]);
            recognizerListenFun = "startTranscribingAsync";
        }

        for (const recognizerEvent of recognizerEvents) {
            recognizer[recognizerEvent] = eventHandlers[recognizerEvent].bind(this);
        }

        recognizer[recognizerListenFun](
            this.handleStartContinuousRecognitionAsync.bind(this),
            this.handleStartContinuousRecognitionAsyncError.bind(this)
        );

        // Startup timeout: if Azure doesn't respond within 15s, emit error
        this._startupTimeout = setTimeout(() => {
            this._startupTimeout = null;
            this.transcriber.logger.error(`${this.name}: Microsoft ASR startup timeout (15s)`);
            this.transcriber.emit('error', 'STARTUP_TIMEOUT');
        }, 15000);
    }
}


class OnlyRecognizedRecognizerListener extends RecognizerListener {
    handleRecognizing(s, e) {
        return;
    }

    handleRecognized(s, e) {
        if (e.result.reason === ResultReason.RecognizedSpeech || e.result.reason === ResultReason.TranslatedSpeech) {
            this.emitTranscribed(this.transcriber.getMqttPayload(e.result))
        }
    }

    handleCanceled(s, e) {
        this.transcriber.logger.info(`${this.formatErrorMsg(e)}`);
    };

    handleSessionStopped(s, e) {
        const reason = e.reason ? `: ${e.reason}` : '';
        this.transcriber.logger.info(`${this.name}: Microsoft ASR session stopped${reason}`);
    };

    handleStartContinuousRecognitionAsync() {
        this.transcriber.logger.info(`${this.name}: Microsoft ASR recognition started`);
    };
}

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

    constructor(session, channel) {
        super();
        this.channel = channel;
        this.logger = logger.getChannelLogger(session.id, channel.id);
        this.recognizers = [];
        this.pushStreams = [];
        this.pushStream = AudioInputStream.createPushStream();
        this.pushStream2 = null;
        this._stopping = false;
        this.emit('closed');
    }

    getTargetLanguages() {
        const { translations } = this.channel;
        if (!translations || !translations.length) {
            return;
        }

        // Filter for discrete translations only (external translations are handled by TranslationBus)
        const discreteTranslations = translations.filter(entry =>
            typeof entry === 'object' ? entry.mode === 'discrete' : true
        );

        if (!discreteTranslations.length) {
            return;
        }

        return discreteTranslations.map(entry =>
            typeof entry === 'object' ? entry.target.split('-')[0] : entry.split('-')[0]
        );
    }

    getMqttPayload(result) {
        let translations = {};
        const targetLanguages = this.getTargetLanguages();
        if (result.translations && targetLanguages) {
            translations = Object.fromEntries(targetLanguages.map((key, i) => [key, result.translations.get(key)]));
        }
        const lang = result.language ? result.language : this.channel.transcriberProfile.config.languages[0].candidate;
        return {
            "astart": this.startedAt,
            "text": result.text,
            "translations": translations,
            "start": result.offset / 10000000,
            "end": (result.offset + result.duration) / 10000000,
            "lang": lang,
            "locutor": result.speakerId
        };
    }

    start() {
        const { transcriberProfile, translations, diarization } = this.channel;
        let msg = 'Starting Microsoft ASR';

        if (translations && translations.length > 0) {
            msg = `${msg} - translations=${translations}`;
        } else {
            msg = `${msg} - without translation`;
        }

        if (diarization) {
            msg = `${msg} - with diarization`;
        } else {
            msg = `${msg} - without diarization`;
        }

        this.logger.info(msg);
        this.pushStreams = [AudioInputStream.createPushStream()];
        this.recognizers = [];
        this._stopping = false;
        this.startedAt = new Date().toISOString();

        // If translation and diarization are enabled, we use two recognizers
        if (translations && translations.length && diarization) {
            this.pushStreams.push(AudioInputStream.createPushStream());

            this.recognizers.push(this.startRecognizer(
                transcriberProfile.config,
                null,
                true,
                this.pushStreams[0],
                new RecognizerListener(this, "[Diarization ASR]")
            ));
            this.recognizers.push(this.startRecognizer(
                transcriberProfile.config,
                translations,
                false,
                this.pushStreams[1],
                new OnlyRecognizedRecognizerListener(this, "[Translation ASR]")
            ));

            return;
        }

        this.recognizers.push(this.startRecognizer(
            transcriberProfile.config,
            translations,
            diarization,
            this.pushStreams[0],
            new RecognizerListener(this, "[ASR]")
        ));
    }

    getSpeechConfig(config, translations) {
        const multi = config.languages.length > 1;
        const hasTranslations = translations && translations.length;
        let usedEndpoint = null;

        const decryptedKey = new Security().safeDecrypt(config.key);

        if (multi && hasTranslations) {
            const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
            usedEndpoint = universalEndpoint;
            const speechConfig = SpeechTranslationConfig.fromEndpoint(new URL(universalEndpoint), decryptedKey);
            speechConfig.speechRecognitionLanguage = config.languages[0].candidate;
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

            // Target language
            const targetLanguages = this.getTargetLanguages();
            for (const targetLanguage of targetLanguages) {
                speechConfig.addTargetLanguage(targetLanguage);
            }

            this.logger.info(`ASR is using endpoint ${usedEndpoint}`);
            return speechConfig;
        }

        if (multi) {
            const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
            usedEndpoint = universalEndpoint;
            const speechConfig = SpeechConfig.fromEndpoint(new URL(universalEndpoint), decryptedKey);
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
            this.logger.info(`ASR is using endpoint ${usedEndpoint}`);
            return speechConfig;
        }

        if (hasTranslations) {
            const speechConfig = SpeechTranslationConfig.fromSubscription(decryptedKey, config.region);
            speechConfig.speechRecognitionLanguage = config.languages[0]?.candidate;

            const targetLanguages = this.getTargetLanguages();
            for (const targetLanguage of targetLanguages) {
                speechConfig.addTargetLanguage(targetLanguage);
            }

            const usedEndpoint = config.languages[0]?.endpoint;
            if (usedEndpoint) {
                this.logger.info(`ASR is using custom endpoint ${usedEndpoint}`);
            } else {
                this.logger.info(`ASR is using default endpoint for region ${config.region}`);
            }
            return speechConfig;
        }

        // mono without translations
        const speechConfig = SpeechConfig.fromSubscription(decryptedKey, config.region);
        speechConfig.speechRecognitionLanguage = config.languages[0]?.candidate;
        // Uses custom endpoint if provided, if not, uses default endpoint for region
        speechConfig.endpointId = config.languages[0]?.endpoint;
        usedEndpoint = config.languages[0]?.endpoint;

        this.logger.info(`ASR is using endpoint ${usedEndpoint}`);
        return speechConfig;
    }

    getRecognizer(config, translations, diarization, speechConfig, audioConfig) {
        const multi = config.languages.length > 1;
        const hasTranslations = translations && translations.length;

        if (multi) {
            const candidates = config.languages.map(language => {
                return language.endpoint ? SourceLanguageConfig.fromLanguage(language.candidate, language.endpoint) : SourceLanguageConfig.fromLanguage(language.candidate);
            });
            const autoDetectSourceLanguageConfig = AutoDetectSourceLanguageConfig.fromSourceLanguageConfigs(candidates);

            if (hasTranslations) {
                return TranslationRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
            }

            if (diarization) {
                return ConversationTranscriber.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
            }

            return SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
        }

        if (hasTranslations) {
            // Use AutoDetectSourceLanguageConfig to properly pass custom endpoint for single-language translation
            const endpoint = config.languages[0]?.endpoint;
            if (endpoint) {
                const sourceLanguageConfig = SourceLanguageConfig.fromLanguage(config.languages[0].candidate, endpoint);
                const autoDetectSourceLanguageConfig = AutoDetectSourceLanguageConfig.fromSourceLanguageConfigs([sourceLanguageConfig]);
                return TranslationRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
            }
            return new TranslationRecognizer(speechConfig, audioConfig);
        }

        if (diarization) {
            return new ConversationTranscriber(speechConfig, audioConfig);
        }

        return new SpeechRecognizer(speechConfig, audioConfig);
    }

    startRecognizer(config, translations, diarization, pushStream, listener) {
        const speechConfig = this.getSpeechConfig(config, translations);
        const audioConfig = AudioConfig.fromStreamInput(pushStream);
        const recognizer = this.getRecognizer(config, translations, diarization, speechConfig, audioConfig);
        listener.listen(recognizer);
        return recognizer;
    }

    transcribe(buffer) {
        if (this.recognizers.length > 0) {
            for (const pushStream of this.pushStreams) {
                pushStream.write(buffer);
            }
        } else if (!this._transcribeWarnThrottled) {
            this._transcribeWarnThrottled = true;
            this.logger.warn("Microsoft ASR: no active recognizer, dropping audio");
            setTimeout(() => { this._transcribeWarnThrottled = false; }, 5000);
        }
    }

    stopTranscription(recognizer, callback) {
        const isRecognizer = recognizer instanceof SpeechRecognizer || recognizer instanceof TranslationRecognizer;
        if (isRecognizer) {
            recognizer.stopContinuousRecognitionAsync(callback);
        }
        else {
            recognizer.stopTranscribingAsync(callback);
        }
    }

    stopRecognizer(recognizer) {
        return new Promise((resolve, reject) => {
            const handleStopContinuousRecognitionAsync = () => {
                recognizer.close();
                resolve();
            };
            this.stopTranscription(recognizer, handleStopContinuousRecognitionAsync);
        })
    }

    async stop() {
        for (const recognizer of this.recognizers) {
            await this.stopRecognizer(recognizer);
        }
        this.recognizers = [];
        this.pushStreams = [];
        this.emit('closed');
    }
}

module.exports = MicrosoftTranscriber;
