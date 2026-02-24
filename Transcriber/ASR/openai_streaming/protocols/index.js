const VllmProtocol = require('./vllm');
const OpenAIProtocol = require('./openai');

const PROTOCOLS = {
    vllm: VllmProtocol,
    openai: OpenAIProtocol
};

/**
 * Load a protocol adapter class by name.
 * @param {string} name - "vllm" or "openai"
 * @returns {typeof import('./base')} The protocol class
 */
function loadProtocol(name) {
    const ProtocolClass = PROTOCOLS[name];
    if (!ProtocolClass) {
        throw new Error(`Unknown protocol: "${name}". Must be one of: ${Object.keys(PROTOCOLS).join(', ')}`);
    }
    return ProtocolClass;
}

module.exports = { loadProtocol };
