const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// Unit tests for the PUT /sessions/:id/stop drain barrier (?waitFinal=true).
// Routes are loaded via require-cache injection of `live-srt-lib` so DB and
// MQTT layers are fully mocked. Covers:
//   - legacy path (no waitFinal): all channels forced inactive immediately,
//     no polling — byte-for-byte the old behaviour
//   - waitFinal path: poll until no channel is 'active', then normalize every
//     still-open channel to inactive; warn (only) when the deadline is hit

const liveSrtLibPath = require.resolve('live-srt-lib');
const sessionsRoutePath = path.resolve(
    __dirname,
    '../components/WebServer/routes/api/sessions.js'
);
const helpersPath = path.resolve(
    __dirname,
    '../components/WebServer/routes/api/translationHelpers.js'
);

let mockModel;
let warns;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: {
            Model: new Proxy({}, { get: (_, k) => mockModel[k] }),
            logger: {
                info() {}, debug() {}, error() {},
                warn(...args) { warns.push(args.join(' ')); },
            },
        },
    };
    delete require.cache[helpersPath];
    delete require.cache[sessionsRoutePath];
    return function teardown() {
        if (origLib) require.cache[liveSrtLibPath] = origLib;
        else delete require.cache[liveSrtLibPath];
        delete require.cache[helpersPath];
        delete require.cache[sessionsRoutePath];
    };
}

function makeRes() {
    const captured = { statusCode: 200, body: null };
    return {
        status(code) { captured.statusCode = code; return this; },
        json(body) { captured.body = body; return this; },
        send(body) { captured.body = body; return this; },
        end() { return this; },
        captured,
    };
}

function makeReq(query = {}) {
    return { body: {}, params: { id: 'sess-1' }, query, payload: { token: { iss: 'admin' } } };
}

function fakeSession(overrides = {}) {
    return Object.assign({
        id: 'sess-1',
        status: 'active',
        channels: [],
        setDataValue(k, v) { this[k] = v; },
    }, overrides);
}

function getRoute(routes) {
    return routes.find((r) => r.path === '/sessions/:id/stop' && r.method === 'put');
}

describe('PUT /sessions/:id/stop — drain barrier (waitFinal)', () => {
    let teardown;
    let route;
    let webserverEvents;
    let channelUpdateCalls;
    let countCalls;

    const ORIG_TIMEOUT = process.env.SESSION_STOP_FLUSH_TIMEOUT_MS;

    before(() => {
        teardown = setupMocks();
        webserverEvents = [];
        const webserver = { emit: (...a) => webserverEvents.push(a) };
        route = getRoute(require(sessionsRoutePath)(webserver));
        webserver._events = webserverEvents;
    });

    after(() => {
        if (teardown) teardown();
        if (ORIG_TIMEOUT === undefined) delete process.env.SESSION_STOP_FLUSH_TIMEOUT_MS;
        else process.env.SESSION_STOP_FLUSH_TIMEOUT_MS = ORIG_TIMEOUT;
    });

    beforeEach(() => {
        warns = [];
        webserverEvents.length = 0;
        channelUpdateCalls = [];
        countCalls = [];
        mockModel = {
            Op: { ne: Symbol('ne') },
            Session: {
                findByPk: async () => fakeSession(),
                update: async () => [1],
            },
            Channel: {
                update: async (values, opts) => { channelUpdateCalls.push({ values, opts }); return [0]; },
                count: async (opts) => { countCalls.push(opts); return 0; },
                findAll: async () => [],
            },
            Caption: { findAll: async () => [] },
            TranslatedCaption: { findAll: async () => [] },
            formatCaption: (c) => c,
            groupTranslatedCaptions: (a) => a,
        };
    });

    it('legacy (no waitFinal): forces all channels inactive immediately, no polling', async () => {
        const res = makeRes();
        await route.controller(makeReq({ force: 'true' }), res, () => {});

        assert.strictEqual(countCalls.length, 0, 'must NOT poll Channel.count on the legacy path');
        assert.strictEqual(channelUpdateCalls.length, 1, 'exactly one Channel.update');
        const where = channelUpdateCalls[0].opts.where;
        assert.strictEqual(where.sessionId, 'sess-1');
        assert.ok(!('streamStatus' in where),
            'legacy update targets ALL channels (no streamStatus filter)');
        assert.strictEqual(channelUpdateCalls[0].values.streamStatus, 'inactive');
        assert.ok(webserverEvents.some((e) => e[0] === 'session-update'));
    });

    it('waitFinal with no active channels: returns without warning, normalizes once', async () => {
        const res = makeRes();
        await route.controller(makeReq({ force: 'true', waitFinal: 'true' }), res, () => {});

        assert.strictEqual(countCalls.length, 1, 'one initial count, loop exits immediately (0 active)');
        assert.strictEqual(warns.length, 0, 'no warning when nothing is still active');
        // Normalization update targets non-inactive channels only.
        assert.strictEqual(channelUpdateCalls.length, 1);
        assert.strictEqual(channelUpdateCalls[0].values.streamStatus, 'inactive');
        assert.deepStrictEqual(channelUpdateCalls[0].opts.where.streamStatus, { [mockModel.Op.ne]: 'inactive' });
        assert.strictEqual(res.captured.statusCode, 200);
    });

    it('waitFinal: polls until a channel transitions to inactive, no warning', async () => {
        let active = 1;
        mockModel.Channel.count = async (opts) => { countCalls.push(opts); const v = active; active = 0; return v; };
        const res = makeRes();
        await route.controller(makeReq({ force: 'true', waitFinal: 'true' }), res, () => {});

        assert.ok(countCalls.length >= 2, 'polled more than once until drained');
        assert.strictEqual(warns.length, 0, 'drained before the deadline → no warning');
    });

    it('waitFinal: warns and force-normalizes when the deadline is hit', async () => {
        process.env.SESSION_STOP_FLUSH_TIMEOUT_MS = '60'; // shorter than one 200ms poll
        mockModel.Channel.count = async (opts) => { countCalls.push(opts); return 2; }; // never drains
        const res = makeRes();
        await route.controller(makeReq({ force: 'true', waitFinal: 'true' }), res, () => {});

        assert.strictEqual(warns.length, 1, 'one warning when channels stay active past the deadline');
        assert.ok(/still active/.test(warns[0]), `unexpected warn: ${warns[0]}`);
        // Still normalizes the leftover channels to inactive.
        const normalize = channelUpdateCalls.find(
            (c) => c.values.streamStatus === 'inactive' && c.opts.where.streamStatus
        );
        assert.ok(normalize, 'leftover channels are force-set inactive after the deadline');
        assert.deepStrictEqual(normalize.opts.where.streamStatus, { [mockModel.Op.ne]: 'inactive' });
    });
});
