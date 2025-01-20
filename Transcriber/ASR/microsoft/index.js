const { AudioConfig, ConversationTranscriber, PropertyId, AudioInputStream, SpeechConfig, SpeechTranslationConfig, TranslationRecognizer, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { logger } = require('live-srt-lib')
const EventEmitter = require('eventemitter3');


class RecognizerListener {
    constructor(transcriber, name) {
        this.transcriber = transcriber;
        this.name = name;
    }

    emitTranscribing(payload) {
        logger.debug(`${this.name}: Microsoft ASR partial transcription: ${payload.text}`);
        this.transcriber.emit('transcribing', payload);
    }

    emitTranscribed(payload) {
        logger.debug(`${this.name}: Microsoft ASR final transcription: ${payload.text}`);
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

    async handleCanceled(s, e) {
        // The ASR is cancelled until the end of the stream
        // and can be restarted with a new stream
        logger.debug(`${this.name}: Microsoft ASR canceled: ${e.errorDetails}`);
        const error = MicrosoftTranscriber.ERROR_MAP[e.errorCode];
        this.transcriber.emit('error', error);
        await this.transcriber.stop();
        // Wait 1 second before restarting the ASR
        setTimeout(() => {this.transcriber.start()}, 2000);
    };

    handleSessionStopped(s, e) {
        logger.debug(`${this.name}: Microsoft ASR session stopped: ${e.reason}`);
        this.transcriber.emit('closed', e.reason);
    };

    handleStartContinuousRecognitionAsync() {
        logger.debug(`${this.name}: Microsoft ASR recognition started`);
        this.transcriber.emit('ready');
    };

    handleStartContinuousRecognitionAsyncError(error) {
        logger.debug(`${this.name}: Microsoft ASR recognition error during startup: ${error}`);
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
        logger.debug(`${this.name}: Microsoft ASR canceled: ${e.errorDetails}`);
    };

    handleSessionStopped(s, e) {
        const reason = e.reason ? `: ${e.reason}` : '';
        logger.debug(`${this.name}: Microsoft ASR session stopped${reason}`);
    };

    handleStartContinuousRecognitionAsync() {
        logger.debug(`${this.name}: Microsoft ASR recognition started`);
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

    constructor(channel) {
        super();
        this.channel = channel;
        this.recognizers = [];
        this.pushStreams = [];
        this.pushStream = AudioInputStream.createPushStream();
        this.pushStream2 = null;
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
            "locutor": result.speakerId
        };
    }

    start() {
        const { transcriberProfile, translations, diarization } = this.channel;
        logger.debug(`Starting Microsoft ASR with translations=${translations} and diarization=${diarization}`);
        this.pushStreams = [AudioInputStream.createPushStream()];
        this.recognizers = [];
        this.startedAt = new Date().toISOString();

        // If translation and diarization are enabled, we use the same listener
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

        if (multi && hasTranslations) {
            const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
            const speechConfig = SpeechTranslationConfig.fromEndpoint(new URL(universalEndpoint), config.key);
            speechConfig.speechRecognitionLanguage = config.languages[0].candidate;
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

            // Target language
            const targetLanguages = this.getTargetLanguages();
            for (const targetLanguage of targetLanguages) {
                speechConfig.addTargetLanguage(targetLanguage);
            }

            return speechConfig;
        }

        if (multi) {
            const universalEndpoint = `wss://${config.region}.stt.speech.microsoft.com/speech/universal/v2`;
            const speechConfig = SpeechConfig.fromEndpoint(new URL(universalEndpoint), config.key);
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true');
            speechConfig.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
            return speechConfig;
        }

        if (hasTranslations) {
            const speechConfig = SpeechTranslationConfig.fromSubscription(config.key, config.region);
            speechConfig.speechRecognitionLanguage = config.languages[0]?.candidate;
            // Uses custom endpoint if provided, if not, uses default endpoint for region
            speechConfig.endpointId = config.languages[0]?.endpoint;

            const targetLanguages = this.getTargetLanguages();
            for (const targetLanguage of targetLanguages) {
                speechConfig.addTargetLanguage(targetLanguage);
            }

            return speechConfig;
        }

        // mono without translations
        const speechConfig = SpeechConfig.fromSubscription(config.key, config.region);
        // Uses custom endpoint if provided, if not, uses default endpoint for region
        speechConfig.endpointId = config.languages[0]?.endpoint;
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
        } else {
            logger.debug("Microsoft ASR transcriber can't decode buffer");
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
