/**
 * Unit tests for BrokerClient.handleSessions().
 *
 * The method consumes the system/out/sessions/statuses retained MQTT message,
 * detects per-session status transitions and emits 'session-paused' /
 * 'session-resumed' events that the StreamingServer turns into ASR pause/
 * resume calls. We exercise the snapshot diff logic in isolation by stubbing
 * the live-srt-lib base class and MqttClient so the constructor doesn't reach
 * the real broker.
 *
 * Critical edge case: a paused session that disappears from one snapshot
 * (transient retained-message republish, Scheduler restart, ...) and reappears
 * with status='active' in a later snapshot must still trigger session-resumed.
 * Without keeping previously-paused sessions in the snapshot, prevStatus would
 * be undefined and the resume branch would never fire — leaving the ASR paused.
 */

const assert = require('assert');
const path = require('path');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach } = require('mocha');

const liveSrtLibPath = require.resolve('live-srt-lib');
const transcriberLoggerPath = path.resolve(__dirname, '../logger.js');
const brokerClientPath = path.resolve(__dirname, '../components/BrokerClient/index.js');
const appContextPath = path.resolve(__dirname, '../appContext.js');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

// MqttClient stub — just enough to satisfy `new MqttClient(...)` and the
// listeners registered in BrokerClient.connect(). Extends EventEmitter so
// .on('ready', ...) etc. don't throw.
class StubMqttClient extends EventEmitter {
    constructor() { super(); }
    registerDomainSpecificValues() {}
    publish() {}
    publishStatus() {}
    subscribe() {}
    unsubscribe() {}
}

// Component stub — provides app, init() no-op, and EventEmitter behavior so
// emit/on/removeListener work as in the real base class.
class StubComponent extends EventEmitter {
    constructor(app) { super(); this.app = app; }
    init() {}
}

let teardownCache;
let bcInstance;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[transcriberLoggerPath];
    const origAppContext = require.cache[appContextPath];

    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: {
            Component: StubComponent,
            MqttClient: StubMqttClient,
            logger: noopLogger,
        },
    };
    require.cache[transcriberLoggerPath] = {
        id: transcriberLoggerPath,
        filename: transcriberLoggerPath,
        loaded: true,
        exports: noopLogger,
    };
    require.cache[appContextPath] = {
        id: appContextPath,
        filename: appContextPath,
        loaded: true,
        exports: { getAppId: () => 'test-transcriber-id' },
    };

    delete require.cache[brokerClientPath];

    return function teardown() {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[transcriberLoggerPath] = origLogger; else delete require.cache[transcriberLoggerPath];
        if (origAppContext) require.cache[appContextPath] = origAppContext; else delete require.cache[appContextPath];
        delete require.cache[brokerClientPath];
    };
}

describe('BrokerClient.handleSessions snapshot diff', () => {
    before(() => {
        teardownCache = setupMocks();
        const factory = require(brokerClientPath);
        bcInstance = factory({ components: {} });
    });

    after(() => {
        if (teardownCache) teardownCache();
    });

    let emitted;
    const protoEmit = EventEmitter.prototype.emit;

    beforeEach(() => {
        emitted = [];
        // Reset wrapper-internal state between tests.
        bcInstance.sessions = [];
        bcInstance._sessionStatusSnapshot = new Map();
        // Always rewrap from the prototype's emit (never the previous wrapper)
        // so beforeEach is idempotent and cannot create a recursion chain.
        bcInstance.emit = (event, ...args) => {
            emitted.push({ event, args });
            return protoEmit.call(bcInstance, event, ...args);
        };
    });

    function pushSnapshot(sessions) {
        bcInstance.handleSessions(sessions);
    }

    it('emits session-paused on first appearance with status=paused', () => {
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        const events = emitted.filter(e => e.event === 'session-paused');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].args[0].id, 'S1');
    });

    it('does not re-emit session-paused on consecutive paused snapshots', () => {
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        const events = emitted.filter(e => e.event === 'session-paused');
        assert.strictEqual(events.length, 1, 'paused must only be emitted on transition');
    });

    it('emits session-resumed when paused -> active in a single snapshot transition', () => {
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        emitted.length = 0;
        pushSnapshot([{ id: 'S1', status: 'active' }]);
        const events = emitted.filter(e => e.event === 'session-resumed');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].args[0].id, 'S1');
    });

    it('emits session-resumed when paused session disappears then returns as active', () => {
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        // Session disappears (transient retained-message republish, Scheduler restart, ...)
        pushSnapshot([]);
        emitted.length = 0;
        // Reappears as active. WITHOUT the snapshot-keep guard this never emits
        // session-resumed because prevStatus is undefined.
        pushSnapshot([{ id: 'S1', status: 'active' }]);

        const events = emitted.filter(e => e.event === 'session-resumed');
        assert.strictEqual(events.length, 1,
            'session-resumed MUST fire even after a transient snapshot loss');
        assert.strictEqual(events[0].args[0].id, 'S1');
    });

    it('keeps paused entry in snapshot when session disappears, drops it on resume', () => {
        pushSnapshot([{ id: 'S1', status: 'paused' }]);
        assert.strictEqual(bcInstance._sessionStatusSnapshot.get('S1'), 'paused');

        pushSnapshot([]);
        assert.strictEqual(bcInstance._sessionStatusSnapshot.get('S1'), 'paused',
            'paused session must persist in snapshot across an empty incoming snapshot');

        pushSnapshot([{ id: 'S1', status: 'active' }]);
        assert.strictEqual(bcInstance._sessionStatusSnapshot.get('S1'), 'active',
            'snapshot entry must be updated to the new non-paused status after resume');
    });

    it('does NOT keep non-paused entries when they disappear', () => {
        pushSnapshot([{ id: 'S1', status: 'active' }]);
        pushSnapshot([]);
        assert.strictEqual(bcInstance._sessionStatusSnapshot.has('S1'), false,
            'active sessions that disappear are not kept (their ASR is torn down by the streaming server session-stop path)');
    });

    it('handles independent transitions for two sessions in one snapshot', () => {
        pushSnapshot([
            { id: 'S1', status: 'paused' },
            { id: 'S2', status: 'active' },
        ]);
        emitted.length = 0;
        pushSnapshot([
            { id: 'S1', status: 'active' },
            { id: 'S2', status: 'paused' },
        ]);

        const resumed = emitted.filter(e => e.event === 'session-resumed').map(e => e.args[0].id);
        const paused = emitted.filter(e => e.event === 'session-paused').map(e => e.args[0].id);
        assert.deepStrictEqual(resumed, ['S1']);
        assert.deepStrictEqual(paused, ['S2']);
    });
});
