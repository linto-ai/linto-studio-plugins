const OpenAIStreamingTranscriber = require('../openai_streaming/index');

class VoxstralTranscriber extends OpenAIStreamingTranscriber {
    constructor(session, channel) {
        // Apply Voxstral defaults before parent constructor
        const config = channel.transcriberProfile.config;
        config.protocol = 'vllm';
        config.model = config.model || 'mistralai/Voxtral-Mini-4B-Realtime-2602';

        super(session, channel);
    }
}

module.exports = VoxstralTranscriber;
