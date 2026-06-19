const EventEmitter = require('eventemitter3');
const path = require('path');

// Shared mocks for the OpenAI-streaming transcriber family (openai_streaming +
// voxstral). The require-cache plumbing used to be copy-pasted at the top of
// test_transcriber.js, test_voxstral.js and test_segmentation_reanchor.js; it
// now lives here so the three suites share a single source of truth.

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

class MockSecurity {
    encrypt(text) { return `encrypted:${text}`; }
    decrypt(text) { return text.replace('encrypted:', ''); }
    safeDecrypt(text) {
        if (text.startsWith('encrypted:')) return text.replace('encrypted:', '');
        return text;
    }
}

class MockWebSocket extends EventEmitter {
    constructor(url, options) {
        super();
        this.readyState = 1; // OPEN
        this.sentMessages = [];
        this.closed = false;
    }
    send(data) { this.sentMessages.push(data); }
    close() { this.closed = true; this.readyState = 3; } // CLOSED
    static get OPEN() { return 1; }
    static get CLOSED() { return 3; }
}

const transcriberPath = path.resolve(__dirname, '../../ASR/openai_streaming/index.js');
const voxstralPath = path.resolve(__dirname, '../../ASR/voxstral/index.js');
const loggerPath = path.resolve(__dirname, '../../logger.js');

// Inject the mocks into the require cache and return a teardown() that restores
// it. Both the openai_streaming and voxstral modules are invalidated so they
// re-require against the mocks (invalidating an unloaded module is a no-op).
function setupMocks() {
    const wsModulePath = require.resolve('ws');
    const liveSrtLibPath = require.resolve('live-srt-lib');

    const origWs = require.cache[wsModulePath];
    const origLiveSrtLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[loggerPath];

    require.cache[wsModulePath] = {
        id: wsModulePath, filename: wsModulePath, loaded: true,
        exports: MockWebSocket
    };
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };
    require.cache[loggerPath] = {
        id: loggerPath, filename: loggerPath, loaded: true,
        exports: mockLogger
    };

    delete require.cache[transcriberPath];
    delete require.cache[voxstralPath];

    return function teardown() {
        if (origWs) require.cache[wsModulePath] = origWs;
        else delete require.cache[wsModulePath];
        if (origLiveSrtLib) require.cache[liveSrtLibPath] = origLiveSrtLib;
        else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[loggerPath] = origLogger;
        else delete require.cache[loggerPath];
        delete require.cache[transcriberPath];
        delete require.cache[voxstralPath];
    };
}

module.exports = { mockLogger, MockSecurity, MockWebSocket, setupMocks };
