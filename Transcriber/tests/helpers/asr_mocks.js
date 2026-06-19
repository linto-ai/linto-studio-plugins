const EventEmitter = require('eventemitter3');
const path = require('path');

// Shared mocks for the Transcriber unit suites. The require-cache plumbing used
// to be copy-pasted at the top of test_transcriber.js, test_voxstral.js,
// test_segmentation*.js (openai_streaming family) and test_asr_pause_resume.js /
// test_asr_flush_finals.js (ASR wrapper + fake provider family). It now lives
// here, parameterized by the set of modules each suite needs re-required against
// the mocks.

const TRANSCRIBER_DIR = path.resolve(__dirname, '../..');

// Resolve a module path relative to the Transcriber root (e.g.
// 'ASR/index.js'). require.cache is keyed by absolute path, so this matches
// whatever the suite-under-test resolves through its own require().
function fromTranscriber(relPath) {
    return path.resolve(TRANSCRIBER_DIR, relPath);
}

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {}, log() {},
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

const transcriberPath = fromTranscriber('ASR/openai_streaming/index.js');
const voxstralPath = fromTranscriber('ASR/voxstral/index.js');
const loggerPath = fromTranscriber('logger.js');

// Inject the mocks into the require cache and return a teardown() that restores
// it. Options:
//   - invalidate: absolute module paths of the code-under-test to clear so it
//     re-requires against the mocks (default: openai_streaming + voxstral).
//   - mockWs: also stub the `ws` module with MockWebSocket (default true; the
//     ASR-wrapper suites that drive FakeTranscriber set this false).
//   - circularBuffer: expose the real CircularBuffer on the mocked live-srt-lib
//     (default false; the ASR-wrapper suites need it for audio buffering).
function setupMocks(options = {}) {
    const {
        invalidate = [transcriberPath, voxstralPath],
        mockWs = true,
        circularBuffer = false,
    } = options;

    const liveSrtLibPath = require.resolve('live-srt-lib');
    const wsModulePath = mockWs ? require.resolve('ws') : null;

    const origWs = mockWs ? require.cache[wsModulePath] : undefined;
    const origLiveSrtLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[loggerPath];

    const liveSrtExports = { Security: MockSecurity, logger: mockLogger, Model: {} };
    if (circularBuffer) {
        liveSrtExports.CircularBuffer = require('../../../lib/circularbuffer.js');
    }

    if (mockWs) {
        require.cache[wsModulePath] = {
            id: wsModulePath, filename: wsModulePath, loaded: true,
            exports: MockWebSocket
        };
    }
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: liveSrtExports
    };
    require.cache[loggerPath] = {
        id: loggerPath, filename: loggerPath, loaded: true,
        exports: mockLogger
    };

    for (const p of invalidate) delete require.cache[p];

    return function teardown() {
        if (mockWs) {
            if (origWs) require.cache[wsModulePath] = origWs;
            else delete require.cache[wsModulePath];
        }
        if (origLiveSrtLib) require.cache[liveSrtLibPath] = origLiveSrtLib;
        else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[loggerPath] = origLogger;
        else delete require.cache[loggerPath];
        for (const p of invalidate) delete require.cache[p];
    };
}

module.exports = { mockLogger, MockSecurity, MockWebSocket, setupMocks, fromTranscriber };
