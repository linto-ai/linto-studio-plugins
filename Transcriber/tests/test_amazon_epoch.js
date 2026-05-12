/**
 * Unit tests for AmazonTranscriber epoch / stale-reconnect protection (B2).
 *
 * Backstory: reconnect() awaits getCredentialsFromHelper() (200-1000ms via the
 * aws_signing_helper subprocess) without re-checking _stopping after the
 * await. A stop() that fires while we're awaiting credentials would set
 * _stopping=true but the in-flight reconnect would proceed to install a fresh
 * TranscribeStreamingClient on this.client AFTER stop() set it to null,
 * leaking a streaming connection and accruing AWS bill until the process exit.
 *
 * Fix: every long-running async path (start, reconnect) captures
 * this._epoch at entry and re-checks it after each await via _isStaleReconnect.
 * stop() bumps the epoch so an in-flight reconnect with the old epoch detects
 * the mismatch and aborts cleanly (destroying any client it had just created).
 *
 * These tests cover the epoch arithmetic and _isStaleReconnect predicate. The
 * end-to-end reconnect race itself requires either a real AWS round-trip or a
 * full SDK mock with controllable async resolution — out of scope here. The
 * harness covers the integration path (scenario 12 pause-resume amazon).
 */

const assert = require('assert');
const path = require('path');
const { describe, it, before, after } = require('mocha');

const noopLogger = {
    info() {}, warn() {}, error() {}, debug() {}, log() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

const liveSrtLibPath = require.resolve('live-srt-lib');
const amazonLoggerPath = path.resolve(__dirname, '../logger.js');
const amazonIndexPath = path.resolve(__dirname, '../ASR/amazon/index.js');
const awsSdkPath = require.resolve('@aws-sdk/client-transcribe-streaming');

class MockSecurity {
    safeDecrypt(text) { return text; }
    encrypt(text) { return text; }
    decrypt(text) { return text; }
}

// AWS SDK mocks: just enough shape so `new TranscribeStreamingClient(...)` and
// `new StartStreamTranscriptionCommand(...)` don't throw. .send() is never
// called in these tests because we don't run start()/reconnect() end-to-end.
class MockTranscribeStreamingClient {
    constructor(opts) { this.opts = opts; this.destroyed = false; }
    destroy() { this.destroyed = true; }
    async send() { return { TranscriptResultStream: (async function*(){})() }; }
}
class MockStartStreamTranscriptionCommand {
    constructor(params) { this.params = params; }
}

let teardown;
let AmazonTranscriber;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[amazonLoggerPath];
    const origAws = require.cache[awsSdkPath];

    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: { Security: MockSecurity, logger: noopLogger },
    };
    require.cache[amazonLoggerPath] = {
        id: amazonLoggerPath,
        filename: amazonLoggerPath,
        loaded: true,
        exports: noopLogger,
    };
    require.cache[awsSdkPath] = {
        id: awsSdkPath,
        filename: awsSdkPath,
        loaded: true,
        exports: {
            TranscribeStreamingClient: MockTranscribeStreamingClient,
            StartStreamTranscriptionCommand: MockStartStreamTranscriptionCommand,
        },
    };
    delete require.cache[amazonIndexPath];

    return function tearDown() {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[amazonLoggerPath] = origLogger; else delete require.cache[amazonLoggerPath];
        if (origAws) require.cache[awsSdkPath] = origAws; else delete require.cache[awsSdkPath];
        delete require.cache[amazonIndexPath];
    };
}

function makeChannel() {
    return {
        id: 'channel-1',
        transcriberProfile: {
            config: {
                region: 'eu-west-1',
                credentials: '{"privateKey":"k","certificate":"c"}',
                trustAnchorArn: 'arn:trust',
                profileArn: 'arn:profile',
                roleArn: 'arn:role',
                languages: [{ candidate: 'fr-FR' }],
            },
        },
    };
}

describe('AmazonTranscriber epoch (B2 — stale reconnect isolation)', () => {
    before(() => {
        teardown = setupMocks();
        AmazonTranscriber = require(amazonIndexPath);
    });

    after(() => { if (teardown) teardown(); });

    it('constructor initializes _epoch to 0', () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        assert.strictEqual(t._epoch, 0);
    });

    it('stop() bumps _epoch even without a prior start()', async () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        const before = t._epoch;
        await t.stop();
        assert.strictEqual(t._epoch, before + 1,
            'stop() must bump epoch so any in-flight reconnect aborts cleanly');
    });

    it('_isStaleReconnect: returns true when epoch differs', () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        t.isStreaming = true;
        t._stopping = false;
        const captured = t._epoch;
        t._epoch = captured + 1;
        assert.strictEqual(t._isStaleReconnect(captured), true);
    });

    it('_isStaleReconnect: returns true when _stopping is set', () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        t.isStreaming = true;
        t._stopping = true;
        assert.strictEqual(t._isStaleReconnect(t._epoch), true);
    });

    it('_isStaleReconnect: returns true when isStreaming is false', () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        t.isStreaming = false;
        t._stopping = false;
        assert.strictEqual(t._isStaleReconnect(t._epoch), true);
    });

    it('_isStaleReconnect: returns false on the live generation', () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        t.isStreaming = true;
        t._stopping = false;
        assert.strictEqual(t._isStaleReconnect(t._epoch), false);
    });

    it('reconnect() captured epoch becomes stale after stop() bumps it', async () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        // Simulate "in the middle of reconnect()": we've captured the entry epoch.
        t.isStreaming = true;
        t._stopping = false;
        const capturedEpoch = t._epoch;

        // stop() fires while we're awaiting (e.g.) credentials.
        await t.stop();

        // Back in reconnect(), the post-await staleness check must trip.
        assert.strictEqual(t._isStaleReconnect(capturedEpoch), true,
            'after stop() bumps epoch, the in-flight reconnect must be classified stale');
    });

    it('reconnect() captured epoch becomes stale after stop()+start()', async () => {
        const t = new AmazonTranscriber({ id: 's' }, makeChannel());
        t.isStreaming = true;
        t._stopping = false;
        const capturedEpoch = t._epoch;

        await t.stop();
        // Manually replay the start() epoch bump (so we don't actually invoke AWS):
        t._epoch += 1;
        t._stopping = false;
        t.isStreaming = true;

        // The new generation has a new epoch — old reconnect must abort.
        assert.notStrictEqual(t._epoch, capturedEpoch);
        assert.strictEqual(t._isStaleReconnect(capturedEpoch), true);

        // The new generation's own epoch capture is fresh and not stale.
        assert.strictEqual(t._isStaleReconnect(t._epoch), false);
    });
});
