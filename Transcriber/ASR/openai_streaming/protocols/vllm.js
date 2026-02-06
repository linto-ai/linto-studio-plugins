const BaseProtocol = require('./base');

class VllmProtocol extends BaseProtocol {
    constructor(config, logger) {
        super(config, logger);
    }

    getWebSocketUrl(endpoint) {
        // Ensure no trailing slash before appending path
        const base = endpoint.replace(/\/+$/, '');
        return `${base}/v1/realtime`;
    }

    getConnectionOptions() {
        if (this.config.apiKey) {
            return {
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`
                }
            };
        }
        return {};
    }

    buildSessionUpdate(model) {
        return { type: 'session.update', model };
    }

    buildAudioAppend(base64Audio) {
        return { type: 'input_audio_buffer.append', audio: base64Audio };
    }

    buildCommit(isFinal) {
        return { type: 'input_audio_buffer.commit', final: isFinal };
    }

    parseServerEvent(msg) {
        switch (msg.type) {
            case 'session.created':
                return { type: 'session_created', data: { sessionId: msg.id } };

            case 'transcription.delta':
                return { type: 'partial', data: { text: msg.delta } };

            case 'error':
                return { type: 'error', data: { message: msg.error, code: msg.code || null } };

            default:
                return null;
        }
    }
}

module.exports = VllmProtocol;
