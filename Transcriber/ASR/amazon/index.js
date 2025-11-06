const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { Security } = require('live-srt-lib');
const logger = require('../../logger');
const EventEmitter = require('eventemitter3');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AmazonTranscriber extends EventEmitter {
    static ERROR_MAP = {
        'BadRequestException': 'BAD_REQUEST',
        'LimitExceededException': 'TOO_MANY_REQUESTS',
        'InternalFailureException': 'SERVICE_ERROR',
        'ConflictException': 'CONFLICT',
        'ServiceUnavailableException': 'SERVICE_UNAVAILABLE',
        'ThrottlingException': 'TOO_MANY_REQUESTS',
        'AccessDeniedException': 'AUTHENTICATION_FAILURE',
    };

    constructor(session, channel) {
        super();
        this.channel = channel;
        this.session = session;
        this.logger = logger.getChannelLogger(session.id, channel.id);
        this.client = null;
        this.audioQueue = [];
        this.isStreaming = false;
        this.streamingPromise = null;
        this.lastPartialResult = null; // Track last partial result
        this.emit('closed');
    }

    async getCredentialsFromHelper() {
        const { transcriberProfile } = this.channel;
        const { config } = transcriberProfile;

        this.logger.info('Amazon ASR: Obtaining credentials via IAM Roles Anywhere');

        // Decrypt the credentials bundle
        let credentialsBundle;
        try {
            const decrypted = new Security().safeDecrypt(config.credentials);
            credentialsBundle = JSON.parse(decrypted);
        } catch (err) {
            throw new Error(`Failed to decrypt credentials: ${err.message}`);
        }

        const { privateKey, certificate, passphrase } = credentialsBundle;

        if (!privateKey || !certificate) {
            throw new Error('Missing privateKey or certificate in credentials bundle');
        }

        // Create temporary directory for credential files (use system temp directory)
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-creds-'));

        try {
            // Write temporary files
            const certPath = path.join(tempDir, 'certificate.crt');
            const keyPath = path.join(tempDir, 'private-key.pem');

            fs.writeFileSync(certPath, certificate, 'utf8');
            fs.writeFileSync(keyPath, privateKey, 'utf8');

            // Build command arguments
            const helperPath = path.join(__dirname, '../../bin/aws_signing_helper');
            const args = [
                'credential-process',
                '--certificate', certPath,
                '--private-key', keyPath,
                '--trust-anchor-arn', config.trustAnchorArn,
                '--profile-arn', config.profileArn,
                '--role-arn', config.roleArn,
            ];

            // Support PKCS#8 password-encrypted private keys (requires aws_signing_helper v1.6.0+)
            if (passphrase) {
                args.push('--pkcs8-password', passphrase);
            }

            // Execute credential helper
            const credentials = await new Promise((resolve, reject) => {
                let stdout = '';
                let stderr = '';

                const proc = spawn(helperPath, args);

                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                });

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                proc.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(`Credential helper exited with code ${code}: ${stderr}`));
                    } else {
                        try {
                            const credData = JSON.parse(stdout);
                            resolve({
                                accessKeyId: credData.AccessKeyId,
                                secretAccessKey: credData.SecretAccessKey,
                                sessionToken: credData.SessionToken,
                            });
                        } catch (err) {
                            reject(new Error(`Failed to parse credential helper output: ${err.message}`));
                        }
                    }
                });

                proc.on('error', (err) => {
                    reject(new Error(`Failed to spawn credential helper: ${err.message}`));
                });
            });

            return credentials;

        } finally {
            // Clean up temporary files
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (err) {
                this.logger.warn(`Failed to cleanup temp directory: ${err.message}`);
            }
        }
    }

    getMqttPayload(result) {
        const { transcriberProfile } = this.channel;
        const languageCode = transcriberProfile.config.languages[0].candidate;

        return {
            "astart": this.startedAt,
            "text": result.text || '',
            "translations": {},
            "start": result.startTime || 0,
            "end": result.endTime || 0,
            "lang": languageCode,
            "locutor": result.speaker || null
        };
    }

    async *audioStreamGenerator() {
        // Generator that yields audio buffers from the queue
        while (this.isStreaming) {
            if (this.audioQueue.length > 0) {
                const buffer = this.audioQueue.shift();
                yield { AudioEvent: { AudioChunk: buffer } };
            } else {
                // Wait a bit before checking again
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }

    async processTranscriptionStream(resultStream) {
        try {
            for await (const event of resultStream) {
                if (event.TranscriptEvent) {
                    const results = event.TranscriptEvent.Transcript.Results;

                    if (results && results.length > 0) {
                        for (const result of results) {
                            if (!result.Alternatives || result.Alternatives.length === 0) {
                                continue;
                            }

                            const transcript = result.Alternatives[0].Transcript;
                            if (!transcript) {
                                continue;
                            }

                            // Extract speaker label if diarization is enabled
                            let speaker = null;
                            if (result.Alternatives[0].Items) {
                                const itemsWithSpeaker = result.Alternatives[0].Items.filter(item => item.Speaker);
                                if (itemsWithSpeaker.length > 0) {
                                    speaker = `spk_${itemsWithSpeaker[0].Speaker}`;
                                }
                            }

                            const payload = {
                                text: transcript,
                                startTime: result.StartTime || 0,
                                endTime: result.EndTime || 0,
                                speaker: speaker
                            };

                            if (result.IsPartial) {
                                // Store the last partial result
                                this.lastPartialResult = payload;
                                this.emit('transcribing', this.getMqttPayload(payload));
                            } else {
                                // Clear last partial when we get a final result
                                this.lastPartialResult = null;
                                this.emit('transcribed', this.getMqttPayload(payload));
                            }
                        }
                    }
                }
            }
        } catch (err) {
            if (this.isStreaming) {
                // Check if it's a timeout due to silence
                if (err.message && err.message.includes('no new audio was received for 15 seconds')) {
                    this.logger.warn('Amazon ASR: 15-second silence timeout, attempting reconnection...');
                    // Reconnect automatically
                    this.reconnect();
                } else {
                    this.logger.error(`Amazon ASR stream processing error: ${err.message}`);
                    const errorCode = AmazonTranscriber.ERROR_MAP[err.name] || 'RUNTIME_ERROR';
                    this.emit('error', errorCode);
                }
            }
        }
    }

    async reconnect() {
        if (!this.isStreaming) {
            return;
        }

        this.logger.info('Amazon ASR: Reconnecting...');

        // Don't emit error, just reconnect silently
        try {
            // Close current client
            if (this.client) {
                this.client.destroy();
                this.client = null;
            }

            // Get new credentials (they might have expired)
            const credentials = await this.getCredentialsFromHelper();

            // Create new Transcribe client
            const { transcriberProfile, diarization } = this.channel;
            const { config } = transcriberProfile;

            this.client = new TranscribeStreamingClient({
                region: config.region,
                credentials: credentials
            });

            const languageCode = config.languages[0].candidate;

            // Prepare stream transcription command parameters
            const commandParams = {
                LanguageCode: languageCode,
                MediaEncoding: 'pcm',
                MediaSampleRateHertz: 16000,
                EnablePartialResultsStabilization: true,
                PartialResultsStability: 'medium',
                AudioStream: this.audioStreamGenerator(),
            };

            // Enable speaker diarization if requested
            if (diarization) {
                commandParams.ShowSpeakerLabel = true;
            }

            this.logger.info('Amazon ASR: Reconnected successfully');

            const command = new StartStreamTranscriptionCommand(commandParams);
            const response = await this.client.send(command);

            // Continue processing the transcription stream
            this.streamingPromise = this.processTranscriptionStream(response.TranscriptResultStream);
            await this.streamingPromise;

        } catch (err) {
            this.logger.error(`Amazon ASR: Reconnection failed: ${err.message}`);
            const errorCode = AmazonTranscriber.ERROR_MAP[err.name] || 'RUNTIME_ERROR';
            this.emit('error', errorCode);
        }
    }

    async start() {
        const { transcriberProfile, diarization } = this.channel;
        const { config } = transcriberProfile;

        let msg = 'Starting Amazon ASR';
        if (diarization) {
            msg = `${msg} - with diarization`;
        } else {
            msg = `${msg} - without diarization`;
        }

        this.logger.info(msg);
        this.startedAt = new Date().toISOString();
        this.isStreaming = true;
        this.audioQueue = [];

        try {
            // Get temporary AWS credentials
            const credentials = await this.getCredentialsFromHelper();

            // Create Transcribe client
            this.client = new TranscribeStreamingClient({
                region: config.region,
                credentials: credentials
            });

            const languageCode = config.languages[0].candidate;

            // Prepare stream transcription command parameters
            const commandParams = {
                LanguageCode: languageCode,
                MediaEncoding: 'pcm',
                MediaSampleRateHertz: 16000,
                EnablePartialResultsStabilization: true,
                PartialResultsStability: 'medium',
                AudioStream: this.audioStreamGenerator(),
            };

            // Enable speaker diarization if requested
            if (diarization) {
                commandParams.ShowSpeakerLabel = true;
            }

            this.logger.info('Amazon ASR: Starting stream transcription');

            const command = new StartStreamTranscriptionCommand(commandParams);
            const response = await this.client.send(command);

            // Emit ready immediately after connection is established
            this.emit('ready');

            // Start processing the transcription stream
            this.streamingPromise = this.processTranscriptionStream(response.TranscriptResultStream);
            await this.streamingPromise;

        } catch (err) {
            this.logger.error(`Amazon ASR: Failed to start: ${err.message}`);
            const errorCode = AmazonTranscriber.ERROR_MAP[err.name] || 'RUNTIME_ERROR';
            this.emit('error', errorCode);
            this.isStreaming = false;
        }
    }

    transcribe(buffer) {
        if (this.isStreaming) {
            this.audioQueue.push(buffer);
        } else {
            this.logger.warn("Amazon ASR transcriber can't decode buffer - not streaming");
        }
    }

    async stop() {
        this.logger.info('Amazon ASR: Stopping transcription');

        // Flush any pending partial result as a final transcription
        if (this.lastPartialResult) {
            this.logger.info('Amazon ASR: Flushing pending partial result as final');
            this.emit('transcribed', this.getMqttPayload(this.lastPartialResult));
            this.lastPartialResult = null;
        }

        this.isStreaming = false;
        this.audioQueue = [];

        // Wait for stream processing to complete
        if (this.streamingPromise) {
            try {
                await this.streamingPromise;
            } catch (err) {
                // Ignore errors during shutdown
            }
            this.streamingPromise = null;
        }

        if (this.client) {
            try {
                this.client.destroy();
            } catch (err) {
                this.logger.warn(`Error destroying AWS client: ${err.message}`);
            }
            this.client = null;
        }

        this.emit('closed');
    }
}

module.exports = AmazonTranscriber;
