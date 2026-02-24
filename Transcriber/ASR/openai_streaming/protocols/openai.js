const BaseProtocol = require('./base');

class OpenAIProtocol extends BaseProtocol {
    constructor(config, logger) {
        super(config, logger);
    }

    getWebSocketUrl(endpoint) {
        const base = endpoint.replace(/\/+$/, '');
        return `${base}/v1/realtime?intent=transcription`;
    }

    getConnectionOptions() {
        const headers = {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
        };
        return { headers };
    }

    buildSessionUpdate(model) {
        return {
            type: 'transcription_session.update',
            session: {
                input_audio_transcription: { model },
                input_audio_format: 'pcm16'
            }
        };
    }

    buildAudioAppend(base64Audio) {
        return { type: 'input_audio_buffer.append', audio: base64Audio };
    }

    buildCommit() {
        return { type: 'input_audio_buffer.commit' };
    }

    parseServerEvent(msg) {
        switch (msg.type) {
            case 'transcription_session.created':
                return { type: 'session_created', data: { sessionId: msg.session?.id || msg.event_id } };

            case 'conversation.item.input_audio_transcription.delta':
                return { type: 'partial', data: { text: msg.delta } };

            case 'conversation.item.input_audio_transcription.completed':
                return { type: 'final', data: { text: msg.transcript, usage: msg.usage || null } };

            case 'conversation.item.input_audio_transcription.failed':
                return {
                    type: 'error',
                    data: {
                        message: msg.error?.message || 'Transcription failed',
                        code: msg.error?.code || null
                    }
                };

            case 'input_audio_buffer.speech_started':
            case 'input_audio_buffer.speech_stopped':
                // VAD events - informational only
                return null;

            default:
                return null;
        }
    }
}

module.exports = OpenAIProtocol;
