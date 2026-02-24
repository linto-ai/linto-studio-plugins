class BaseProtocol {
    /**
     * @param {object} config - transcriberProfile.config
     * @param {object} logger - channel logger
     */
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    /** Build the WebSocket URL from config.endpoint */
    getWebSocketUrl(endpoint) {
        throw new Error('getWebSocketUrl() must be implemented by subclass');
    }

    /** Build WebSocket connection options (headers, etc.) */
    getConnectionOptions() {
        throw new Error('getConnectionOptions() must be implemented by subclass');
    }

    /** Build the session configuration message to send after connection */
    buildSessionUpdate(model) {
        throw new Error('buildSessionUpdate() must be implemented by subclass');
    }

    /** Build an audio append message from a base64-encoded PCM buffer */
    buildAudioAppend(base64Audio) {
        throw new Error('buildAudioAppend() must be implemented by subclass');
    }

    /** Build a commit message (called on stop) */
    buildCommit(isFinal) {
        throw new Error('buildCommit() must be implemented by subclass');
    }

    /**
     * Parse an incoming server message and return a normalized event object:
     * { type: "session_created" | "partial" | "final" | "error", data: {...} }
     *
     * - "session_created": { sessionId: string }
     * - "partial": { text: string }
     * - "final": { text: string, usage: object|null }
     * - "error": { message: string, code: string|null }
     */
    parseServerEvent(message) {
        throw new Error('parseServerEvent() must be implemented by subclass');
    }
}

module.exports = BaseProtocol;
