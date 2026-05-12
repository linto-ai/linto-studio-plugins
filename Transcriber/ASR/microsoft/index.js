const { AudioConfig, ConversationTranscriber, PropertyId, AudioInputStream, SpeechConfig, SpeechTranslationConfig, TranslationRecognizer, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { Security } = require('live-srt-lib')
const logger = require('../../logger')
const EventEmitter = require('eventemitter3');
const { toAzureCode, isAzureValid } = require('./azureLocale');


class PrimaryRecognizerListener {
    constructor(transcriber, name, epoch) {
        this.transcriber = transcriber;
        this.name = name;
        // Captured at listener creation. The Azure SDK keeps invoking listener
        // callbacks asynchronously after stopRecognizer() returns (close+ack
        // round-trip is racy). Comparing this.epoch to transcriber._epoch lets
        // every handler short-circuit when it belongs to a previous start()
        // generation, so a stale `canceled` cannot reset _stopping and mark
        // the *new* recognizer as failed (root cause of the spurious
        // STARTUP_TIMEOUT errors observed after pause/resume).
        this.epoch = epoch;
        // Track the last SDK event observed for this recognizer, so that on
        // STARTUP_TIMEOUT we can surface what (if anything) Azure replied with.
        this._lastSdkEvent = null;
    }

    _isStale() {
        return this.epoch !== this.transcriber._epoch;
    }

    _recordSdkEvent(type, extra) {
        this._lastSdkEvent = Object.assign(
            { type, at: new Date().toISOString() },
            extra || {}
        );
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
        if (this._isStale()) return;
        this._recordSdkEvent('recognizing', { reason: e && e.result && e.result.reason });
        this.emitTranscribing(this.transcriber.formatResult(e.result))
    }

    handleRecognized(s, e) {
        if (this._isStale()) return;
        this._recordSdkEvent('recognized', { reason: e && e.result && e.result.reason });
        if (e.result.reason === ResultReason.RecognizedSpeech || e.result.reason === ResultReason.TranslatedSpeech) {
            this.emitTranscribed(this.transcriber.formatResult(e.result))
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
        if (this._isStale()) {
            this.transcriber.logger.debug(`${this.name}: ignoring stale canceled (epoch ${this.epoch} != ${this.transcriber._epoch})`);
            // Always clear our own startup timeout so it cannot fire after
            // the listener has been retired.
            if (this._startupTimeout) {
                clearTimeout(this._startupTimeout);
                this._startupTimeout = null;
            }
            return;
        }
        this._recordSdkEvent('canceled', {
            error: e && e.errorDetails,
            code: e && e.errorCode,
        });
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
        if (this._isStale()) return;
        this._recordSdkEvent('sessionStopped', { reason: e && e.reason });
        this.transcriber.logger.info(`${this.name}: Microsoft ASR session stopped: ${e.reason}`);
        this.transcriber.emit('closed', e.reason);
    };

    onStartSuccess() {
        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        if (this._isStale()) return;
        this.transcriber.logger.info(`${this.name}: Microsoft ASR recognition started`);
        this.transcriber.emit('ready');
    };

    onStartError(error) {
        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        if (this._isStale()) return;
        this.transcriber.logger.error(`${this.name}: Microsoft ASR recognition error during startup: ${error}`);
        this.transcriber.emit('error', 'STARTUP_ERROR');
    };

    attachTo(recognizer) {
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
            this.onStartSuccess.bind(this),
            this.onStartError.bind(this)
        );

        // Startup timeout: if Azure doesn't respond within 15s, emit error.
        // Surface diagnostic hints to spare operators the typical hour-long
        // hunt — most timeouts are caused by either an encrypted key being
        // forwarded verbatim (SECURITY_CRYPT_KEY missing on the Transcriber)
        // or an invalid/wrong-region subscription.
        this._startupTimeout = setTimeout(() => {
            this._startupTimeout = null;
            // A stale listener's timeout fires for an old recognizer that the
            // new generation has nothing to do with — never report it.
            if (this._isStale()) return;
            const region = (this.transcriber.channel
                && this.transcriber.channel.transcriberProfile
                && this.transcriber.channel.transcriberProfile.config
                && this.transcriber.channel.transcriberProfile.config.region) || '<region>';
            const hints = [
                'Possible causes:',
                `  - Invalid API key (verify by issuing a token: curl -X POST https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken -H "Ocp-Apim-Subscription-Key: <key>" -H "Content-Length: 0")`,
                '  - SECURITY_CRYPT_KEY mismatch: if Session-API encrypts keys at rest, the Transcriber MUST share the same SECURITY_CRYPT_KEY to decrypt them (without this, an encrypted key is forwarded verbatim and Azure rejects it silently)',
                '  - Wrong region (verify the region matches the Azure Speech resource)',
                '  - Network/firewall blocking outbound HTTPS/WSS to *.api.cognitive.microsoft.com and *.stt.speech.microsoft.com',
                '  - Azure service degraded (check Azure status page)',
            ].join('\n');
            const lastEvt = this._lastSdkEvent
                ? ` Last SDK event: ${JSON.stringify(this._lastSdkEvent)}`
                : ' (no SDK event received)';
            this.transcriber.logger.error(`${this.name}: Microsoft ASR startup timeout (15s).${lastEvt}\n${hints}`);
            this.transcriber.emit('error', 'STARTUP_TIMEOUT');
        }, 15000);
    }
}


class SecondaryRecognizerListener extends PrimaryRecognizerListener {
    handleRecognizing(s, e) {
        if (this._isStale()) return;
        this._recordSdkEvent('recognizing', { reason: e && e.result && e.result.reason });
        this.emitTranscribing(this.transcriber.formatResult(e.result))
    }

    handleRecognized(s, e) {
        if (this._isStale()) return;
        this._recordSdkEvent('recognized', { reason: e && e.result && e.result.reason });
        if (e.result.reason === ResultReason.RecognizedSpeech || e.result.reason === ResultReason.TranslatedSpeech) {
            this.emitTranscribed(this.transcriber.formatResult(e.result))
        }
    }

    handleCanceled(s, e) {
        if (this._isStale()) {
            if (this._startupTimeout) {
                clearTimeout(this._startupTimeout);
                this._startupTimeout = null;
            }
            return;
        }
        this._recordSdkEvent('canceled', {
            error: e && e.errorDetails,
            code: e && e.errorCode,
        });
        this.transcriber.logger.info(`${this.formatErrorMsg(e)}`);
    };

    handleSessionStopped(s, e) {
        if (this._isStale()) return;
        this._recordSdkEvent('sessionStopped', { reason: e && e.reason });
        const reason = e.reason ? `: ${e.reason}` : '';
        this.transcriber.logger.info(`${this.name}: Microsoft ASR session stopped${reason}`);
    };

    onStartSuccess() {
        if (this._startupTimeout) {
            clearTimeout(this._startupTimeout);
            this._startupTimeout = null;
        }
        if (this._isStale()) return;
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
        this._listeners = [];
        this._stopping = false;
        this._translationKeyMap = null;
        // Generation counter bumped on every start(). Any listener created in
        // a previous generation compares this to its captured value and
        // becomes a no-op once they differ. See PrimaryRecognizerListener.
        this._epoch = 0;
        this.emit('closed');
    }

    // Map<azureCode, originalUserKey> — built once from channel.translations.
    // azureCode is the canonical form Azure expects (e.g. 'pt-pt', 'fr-ca', 'zh-Hans').
    // originalUserKey is the user-supplied BCP47 tag preserved for the MQTT payload.
    getTranslationKeyMap() {
        if (this._translationKeyMap) return this._translationKeyMap;
        const map = new Map();
        const { translations } = this.channel;
        if (!Array.isArray(translations) || translations.length === 0) {
            this._translationKeyMap = map;
            return map;
        }
        for (const entry of translations) {
            if (typeof entry === 'object' && entry.mode !== 'discrete') continue;
            const originalKey = typeof entry === 'object' ? entry.target : entry;
            const azureCode = toAzureCode(originalKey);
            if (!isAzureValid(azureCode)) {
                this.logger.warn(`Microsoft ASR: unsupported target language ${originalKey} (resolved to ${azureCode}) — Azure may reject or fall back`);
            }
            // First entry wins on collision (validation upstream should prevent this).
            if (!map.has(azureCode)) map.set(azureCode, originalKey);
        }
        this._translationKeyMap = map;
        return map;
    }

    getTargetLanguages() {
        return Array.from(this.getTranslationKeyMap().keys());
    }

    formatResult(result) {
        const translations = {};
        const keyMap = this.getTranslationKeyMap();
        if (result.translations && keyMap.size > 0) {
            const returnedKeys = result.translations.languages || [];
            for (const [azureCode, originalKey] of keyMap.entries()) {
                let value = result.translations.get(azureCode);
                if (value === undefined) {
                    const matched = returnedKeys.find(k => k.toLowerCase() === azureCode.toLowerCase());
                    if (matched) value = result.translations.get(matched);
                }
                if (value !== undefined) translations[originalKey] = value;
            }
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
            msg = `${msg} - translations=${JSON.stringify(translations)}`;
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
        this._listeners = [];
        this._stopping = false;
        this._translationKeyMap = null;
        this.startedAt = new Date().toISOString();
        // Bump epoch BEFORE creating new listeners so any stale callback from
        // a previous generation is reliably classified as such by _isStale().
        this._epoch += 1;
        const epoch = this._epoch;

        // If translation and diarization are enabled, we use two recognizers
        if (this.getTargetLanguages().length > 0 && diarization) {
            this.pushStreams.push(AudioInputStream.createPushStream());

            this.recognizers.push(this.setupRecognizer(
                transcriberProfile.config,
                null,
                true,
                this.pushStreams[0],
                new PrimaryRecognizerListener(this, "[Diarization ASR]", epoch)
            ));
            this.recognizers.push(this.setupRecognizer(
                transcriberProfile.config,
                translations,
                false,
                this.pushStreams[1],
                new SecondaryRecognizerListener(this, "[Translation ASR]", epoch)
            ));

            return;
        }

        this.recognizers.push(this.setupRecognizer(
            transcriberProfile.config,
            translations,
            diarization,
            this.pushStreams[0],
            new PrimaryRecognizerListener(this, "[ASR]", epoch)
        ));
    }

    createSpeechConfig(config, translations) {
        const multi = config.languages.length > 1;
        const hasTranslations = this.getTargetLanguages().length > 0;
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

    createRecognizer(config, translations, diarization, speechConfig, audioConfig) {
        const multi = config.languages.length > 1;
        const hasTranslations = this.getTargetLanguages().length > 0;

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

    setupRecognizer(config, translations, diarization, pushStream, listener) {
        const speechConfig = this.createSpeechConfig(config, translations);
        const audioConfig = AudioConfig.fromStreamInput(pushStream);
        const recognizer = this.createRecognizer(config, translations, diarization, speechConfig, audioConfig);
        this._listeners.push(listener);
        listener.attachTo(recognizer);
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

    stopRecognition(recognizer, callback) {
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
            this.stopRecognition(recognizer, handleStopContinuousRecognitionAsync);
        })
    }

    async stop() {
        // Snapshot current resources and reset instance state synchronously BEFORE
        // awaiting any async cleanup. This prevents transcribe() from writing to
        // pushStreams that are in the process of being closed (race condition).
        const recognizersToClose = this.recognizers;
        const listenersToClear = this._listeners;
        this.recognizers = [];
        this.pushStreams = [];
        this._listeners = [];
        this._stopping = true;

        // Clear any pending startup timeouts so they don't fire a spurious
        // STARTUP_TIMEOUT error after the transcriber has been stopped.
        for (const listener of listenersToClear) {
            if (listener && listener._startupTimeout) {
                clearTimeout(listener._startupTimeout);
                listener._startupTimeout = null;
            }
        }

        for (const recognizer of recognizersToClose) {
            await this.stopRecognizer(recognizer);
        }
        this.emit('closed');
    }
}

module.exports = MicrosoftTranscriber;
