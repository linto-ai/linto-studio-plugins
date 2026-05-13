const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// Unit tests for Session-API PUT /sessions/:id/clear endpoint.
// Mirrors test_pause_resume.js: routes are loaded via require-cache injection
// of `live-srt-lib` so DB and MQTT layers are fully mocked.

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

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: {
            Model: new Proxy({}, { get: (_, k) => mockModel[k] }),
            logger: { info() {}, warn() {}, error() {}, debug() {} },
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

function makeMockTransaction() {
    return {
        commit: async () => {},
        rollback: async () => {},
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

function makeReq(body = {}, params = {}, query = {}) {
    return { body, params, query };
}

function fakeSession(overrides = {}) {
    const session = {
        id: 'test-session-id',
        status: 'active',
        pausedAt: null,
        startTime: null,
        endTime: null,
        name: 'fake',
        organizationId: null,
        visibility: 'private',
        channels: [],
        destroy: async () => {},
        setDataValue: function (k, v) { this[k] = v; },
        ...overrides,
    };
    session.updateCalls = [];
    session.update = async function (data) {
        this.updateCalls.push(data);
        Object.assign(this, data);
        return this;
    };
    return session;
}

function getRoute(routes, path, method) {
    return routes.find((r) => r.path === path && r.method === method);
}

// Build a Model mock that records destroy/update calls and supports the
// callback form of sequelize.transaction used by the clear handler.
function buildModelMock({
    session,
    channels = [],
    captureCalls = {},
} = {}) {
    captureCalls.captionDestroy = [];
    captureCalls.translatedCaptionDestroy = [];
    captureCalls.channelUpdate = [];

    return {
        sequelize: {
            transaction: async (cb) => {
                if (typeof cb === 'function') return cb(makeMockTransaction());
                return makeMockTransaction();
            },
        },
        Op: { startsWith: Symbol('startsWith'), in: Symbol('in'), lt: Symbol('lt'), gt: Symbol('gt'), ne: Symbol('ne') },
        Session: {
            findByPk: async () => session,
            update: async () => [1],
            destroy: async () => 1,
        },
        Channel: {
            findAll: async () => channels,
            update: async (data, opts) => {
                captureCalls.channelUpdate.push({ data, opts });
                return [1];
            },
            getPaginatedCaptions: async () => ({ totalClosedCaptions: 0, totalTranslatedCaptions: 0, closedCaptions: [], translatedCaptions: {} }),
        },
        Caption: {
            findAll: async () => [],
            destroy: async (opts) => { captureCalls.captionDestroy.push(opts); return 0; },
        },
        TranslatedCaption: {
            findAll: async () => [],
            destroy: async (opts) => { captureCalls.translatedCaptionDestroy.push(opts); return 0; },
        },
        formatCaption: (c) => c,
        groupTranslatedCaptions: (arr) => arr,
    };
}

describe('Session-API clear session', () => {
    let teardown;
    let sessionsRoutes;
    let webserverEvents;
    let webserver;

    before(() => {
        teardown = setupMocks();
        webserverEvents = [];
        webserver = {
            emit: (...args) => { webserverEvents.push(args); },
        };
        // Default mock so that requiring the routes module doesn't blow up.
        mockModel = buildModelMock({ session: null });
        sessionsRoutes = require(sessionsRoutePath)(webserver);
    });

    after(() => {
        if (teardown) teardown();
    });

    beforeEach(() => {
        webserverEvents.length = 0;
    });

    // -------------------- Allowed statuses --------------------

    it('1. active session with channels → 200, captions+translations destroyed, lastSegmentId reset', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        assert.ok(route, 'clear route not found');

        const captureCalls = {};
        const session = fakeSession({ status: 'active' });
        mockModel = buildModelMock({
            session,
            channels: [{ id: 11 }, { id: 12 }],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
        assert.strictEqual(res.captured.statusCode, 200);

        assert.strictEqual(captureCalls.captionDestroy.length, 1);
        assert.deepStrictEqual(captureCalls.captionDestroy[0].where.channelId, [11, 12]);

        assert.strictEqual(captureCalls.translatedCaptionDestroy.length, 1);
        assert.deepStrictEqual(captureCalls.translatedCaptionDestroy[0].where.channelId, [11, 12]);

        assert.strictEqual(captureCalls.channelUpdate.length, 1);
        assert.deepStrictEqual(captureCalls.channelUpdate[0].data, { lastSegmentId: 0 });
        assert.deepStrictEqual(captureCalls.channelUpdate[0].opts.where.id, [11, 12]);
    });

    it('2. paused session → 200, captions destroyed', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'paused', pausedAt: new Date() }),
            channels: [{ id: 21 }],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.strictEqual(nextErr, undefined);
        assert.strictEqual(res.captured.statusCode, 200);
        assert.strictEqual(captureCalls.captionDestroy.length, 1);
        assert.strictEqual(captureCalls.translatedCaptionDestroy.length, 1);
    });

    it('3. ready session → 200, captions destroyed', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'ready' }),
            channels: [{ id: 31 }],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.strictEqual(nextErr, undefined);
        assert.strictEqual(res.captured.statusCode, 200);
        assert.strictEqual(captureCalls.captionDestroy.length, 1);
    });

    // -------------------- Refused statuses --------------------

    it('4. terminated session → 400, no destroy', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'terminated' }),
            channels: [{ id: 41 }],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.ok(nextErr, 'expected next(err)');
        assert.strictEqual(nextErr.status, 400);
        assert.match(nextErr.message, /Cannot clear/i);
        assert.strictEqual(captureCalls.captionDestroy.length, 0);
        assert.strictEqual(captureCalls.translatedCaptionDestroy.length, 0);
        assert.strictEqual(captureCalls.channelUpdate.length, 0);
    });

    it('5. on_schedule session → 400, no destroy', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'on_schedule' }),
            channels: [{ id: 51 }],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.ok(nextErr);
        assert.strictEqual(nextErr.status, 400);
        assert.strictEqual(captureCalls.captionDestroy.length, 0);
    });

    // -------------------- Not found --------------------

    it('6. non-existent session → 404, no destroy', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({ session: null, captureCalls });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'unknown' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.ok(nextErr);
        assert.strictEqual(nextErr.status, 404);
        assert.strictEqual(captureCalls.captionDestroy.length, 0);
    });

    // -------------------- Edge: no channels --------------------

    it('7. active session without channels → 200, no destroy call (no-op)', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'active' }),
            channels: [],
            captureCalls,
        });

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.strictEqual(nextErr, undefined);
        assert.strictEqual(res.captured.statusCode, 200);
        assert.strictEqual(captureCalls.captionDestroy.length, 0);
        assert.strictEqual(captureCalls.translatedCaptionDestroy.length, 0);
        assert.strictEqual(captureCalls.channelUpdate.length, 0);
    });

    // -------------------- Idempotence --------------------

    it('8. clearing twice in a row stays 200 and re-issues destroy (no captions left is fine)', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        const captureCalls = {};
        mockModel = buildModelMock({
            session: fakeSession({ status: 'active' }),
            channels: [{ id: 81 }],
            captureCalls,
        });

        for (let i = 0; i < 2; i++) {
            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => { nextErr = err; }
            );
            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(res.captured.statusCode, 200);
        }
        assert.strictEqual(captureCalls.captionDestroy.length, 2);
        assert.strictEqual(captureCalls.translatedCaptionDestroy.length, 2);
        assert.strictEqual(captureCalls.channelUpdate.length, 2);
    });

    // -------------------- Events --------------------

    it('9. emits "session-cleared" with session + channelIds', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        mockModel = buildModelMock({
            session: fakeSession({ status: 'active' }),
            channels: [{ id: 91 }, { id: 92 }],
        });

        const res = makeRes();
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            () => {}
        );

        const cleared = webserverEvents.find((e) => e[0] === 'session-cleared');
        assert.ok(cleared, 'session-cleared event should be emitted');
        assert.ok(cleared[1], 'session-cleared should carry the session');
        assert.strictEqual(cleared[1].id, 'test-session-id');
        assert.deepStrictEqual(cleared[2], [91, 92]);
    });

    it('10. emits "session-update"', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        mockModel = buildModelMock({
            session: fakeSession({ status: 'active' }),
            channels: [{ id: 101 }],
        });

        const res = makeRes();
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            () => {}
        );

        const updated = webserverEvents.find((e) => e[0] === 'session-update');
        assert.ok(updated, 'session-update event should be emitted');
    });

    it('11. refused statuses do NOT emit session-cleared', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        mockModel = buildModelMock({
            session: fakeSession({ status: 'terminated' }),
            channels: [{ id: 111 }],
        });

        const res = makeRes();
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            () => {}
        );

        const cleared = webserverEvents.find((e) => e[0] === 'session-cleared');
        assert.strictEqual(cleared, undefined, 'no session-cleared on refusal');
    });

    it('12. Caption.destroy throws → next(err), no session-cleared event', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id/clear', 'put');
        mockModel = buildModelMock({
            session: fakeSession({ status: 'active' }),
            channels: [{ id: 121 }],
        });
        mockModel.Caption.destroy = async () => {
            throw new Error('simulated DB failure');
        };

        const res = makeRes();
        let nextErr;
        await route.controller(
            makeReq({}, { id: 'test-session-id' }),
            res,
            (err) => { nextErr = err; }
        );

        assert.ok(nextErr, 'expected next(err) on destroy failure');
        assert.match(nextErr.message, /simulated DB failure/);
        const cleared = webserverEvents.find((e) => e[0] === 'session-cleared');
        assert.strictEqual(cleared, undefined, 'no session-cleared event on failure');
    });
});
