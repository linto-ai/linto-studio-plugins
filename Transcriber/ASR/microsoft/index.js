const { AudioConfig, ConversationTranscriber, PropertyId, AudioInputStream, SpeechConfig, SpeechTranslationConfig, TranslationRecognizer, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const debug = require('debug')(`transcriber:microsoft`);
const EventEmitter = require('eventemitter3');


class RecognizerListener {
    constructor(transcriber) {
        this.transcriber = transcriber;
    }

    emitTranscribing(payload) {
        debug(`Microsoft ASR partial transcription: ${payload.text}`);
        this.transcriber.emit('transcribing', payload);
    }

    emitTranscribed(payload) {
        debug(`Microsoft ASR final transcription: ${payload.text}`);
        debug(JSON.stringify(payload));
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

    handleCanceled(s, e) {
        // The ASR is cancelled until the end of the stream
        // and can be restarted with a new stream
        debug(`Microsoft ASR canceled: ${e.errorDetails}`);
        const error = MicrosoftTranscriber.ERROR_MAP[e.errorCode];
        this.transcriber.emit('error', error);
        this.transcriber.stop();
    };

    handleSessionStopped(s, e) {
        debug(`Microsoft ASR session stopped: ${e.reason}`);
        this.transcriber.emit('closed', e.reason);
    };

    handleStartContinuousRecognitionAsync() {
        debug("Microsoft ASR recognition started");
        this.transcriber.emit('ready');
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

        recognizer[recognizerListenFun](this.handleStartContinuousRecognitionAsync);
    }
}


class MultiRecognizerListener extends RecognizerListener {
    constructor(transcriber) {
        super(transcriber);
        this.finals = [];
        this.recognizerCount = 0;
    }

    handleRecognized(s, e) {
        if (e.result.reason === ResultReason.RecognizedSpeech || e.result.reason === ResultReason.TranslatedSpeech) {
            this.finals.push(this.transcriber.getMqttPayload(e.result));
            const finalGroups = this.findFinalByStart();
            Object.values(finalGroups).forEach(value => {
                const mergedFinal = this.mergePayload(...value);
                this.emitTranscribed(mergedFinal);
            });
        }
    }

    mergePayload(obj1, obj2) {
      return {
        ...obj1,
        ...obj2,
        locutor: obj1.locutor || obj2.locutor,
        translations: {
          ...obj1.translations,
          ...obj2.translations
        }
      };
    }

    findFinalByStart() {
        const groupedByStart = {};

        this.finals.forEach(item => {
          if (!groupedByStart[item.start]) {
            groupedByStart[item.start] = [item];
          } else {
            groupedByStart[item.start].push(item);
          }
        });

        const duplicates = Object.fromEntries(
          Object.entries(groupedByStart).filter(([key, value]) => value.length > 1)
        );

        // remove the finals
        this.finals = this.finals.filter(item => !duplicates[item.start]);

        return duplicates;
    }

    listenOnlyRecognized(recognizer) {
        const eventHandlers = {
            "recognized": this.handleRecognized,
            "transcribed": this.handleRecognized,
        };

        const isRecognizer = recognizer instanceof SpeechRecognizer || recognizer instanceof TranslationRecognizer;
        let recognizerEvent = "recognized";
        let recognizerListenFun = "startContinuousRecognitionAsync";
        if (!isRecognizer) {
            recognizerEvent = "transcribed";
            recognizerListenFun = "startTranscribingAsync";
        }

        recognizer[recognizerEvent] = eventHandlers[recognizerEvent].bind(this);
        recognizer[recognizerListenFun](this.handleStartContinuousRecognitionAsync);
    }

    listen(recognizer) {
        this.recognizerCount += 1;
        if (this.recognizerCount == 1) {
            super.listen(recognizer);
            return;
        }
        if (this.recognizerCount == 2) {
            this.listenOnlyRecognized(recognizer);
            return;
        }
        throw new Error(`MultiRecognizerListener supports only 2 recognizers, current: ${this.recognizerCount}`);
    }
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
        this.recognizer = null;
        this.recognizer2 = null;
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
        this.pushStream2 = null;
        this.recognizer2 = null;
        this.startedAt = new Date().toISOString();

        // If translation and diarization are enabled, we use the same listener and reconciliate
        // the result
        if (translations && translations.length && diarization) {
            this.pushStream2 = AudioInputStream.createPushStream();
            const listener = new MultiRecognizerListener(this);

            this.recognizer = this.startRecognizer(
                transcriberProfile.config,
                translations,
                false,
                this.pushStream,
                listener
            );
            this.recognizer2 = this.startRecognizer(
                transcriberProfile.config,
                null,
                true,
                this.pushStream2,
                listener
            );

            return;
        }

        this.recognizer = this.startRecognizer(
            transcriberProfile.config,
            translations,
            diarization,
            this.pushStream,
            new RecognizerListener(this)
        );
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
                return ConversationTranscriber(speechConfig, autoDetectSourceLanguageConfig, audioConfig);
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
        if (this.recognizer) {
            this.pushStream.write(buffer);
            if (this.pushStream2) {
                this.pushStream2.write(buffer);
            }
        } else {
            debug("Microsoft ASR transcriber can't decode buffer");
        }
    }

    stopRecognizer(recognizer, callback) {
        const isRecognizer = recognizer instanceof SpeechRecognizer || recognizer instanceof TranslationRecognizer;
        if (isRecognizer) {
            recognizer.stopContinuousRecognitionAsync(callback);
        }
        else {
            recognizer.stopTranscribingAsync(callback);
        }
    }

    stopRecognizer1() {
        const handleStopContinuousRecognitionAsync = () => {
            debug("ASR recognition stopped");
            this.recognizer.close();
            this.recognizer = null;
            this.emit('closed');
        };
        this.stopRecognizer(this.recognizer, handleStopContinuousRecognitionAsync);
    }

    stopRecognizer2() {
        const handleStopContinuousRecognitionAsync = () => {
            debug("ASR recognition stopped");
            this.recognizer2.close();
            this.recognizer2 = null;
        };
        this.stopRecognizer(this.recognizer2, handleStopContinuousRecognitionAsync);
    }

    stop() {
        if (this.recognizer) {
            this.stopRecognizer1();
        }
        if (this.recognizer2) {
            this.stopRecognizer2();
        }

        this.pushStream2 = null;
    }
}

module.exports = MicrosoftTranscriber;
