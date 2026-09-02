const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// C6 — the native join token stored in session.meta is WRITE-PROTECTED.
//
// meta.native[<cap>].token / meta.linto_native.token are scrubbed from every read
// path, but `meta` is a full-replacement, client-writable field on PUT and PATCH.
// A read-modify-write (what the Studio frontend does: it polls the session for
// meta.room / state / livekitUrl and writes the object back on e.g. a rename)
// would therefore erase a Meet-minted token nothing in this repo can re-mint.
// These tests pin: the round trip preserves it, an explicit null/empty token
// neither wipes nor resurrects it, an explicit new token still wins (the mint
// path), and every read path keeps hiding it.
//
// Same mocking style as test_pause_resume.js / test_clear_session.js: the routes
// are loaded with `live-srt-lib` injected in the require-cache.

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
    return { commit: async () => {}, rollback: async () => {} };
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

function getRoute(routes, routePath, method) {
    return routes.find((r) => r.path === routePath && r.method === method);
}

// The persisted row. Model.Session.update mutates it exactly like the real
// full-replacement write would, so a test can assert what actually landed in DB.
let stored;

function sessionRow() {
    return {
        id: 'sess-1',
        name: stored.name,
        status: 'ready',
        startTime: null,
        meta: stored.meta,
        channels: [],
        toJSON() {
            return { id: this.id, name: this.name, status: this.status, meta: this.meta, channels: [] };
        },
    };
}

function buildModelMock({ updateCalls = [] } = {}) {
    return {
        sequelize: {
            transaction: async (cb) => (typeof cb === 'function' ? cb(makeMockTransaction()) : makeMockTransaction()),
            query: async () => [],
            escape: (v) => `'${v}'`,
        },
        Sequelize: { QueryTypes: { SELECT: 'SELECT' } },
        Op: { startsWith: Symbol('startsWith'), in: Symbol('in'), lt: Symbol('lt'), gt: Symbol('gt'), ne: Symbol('ne') },
        Session: {
            findByPk: async () => sessionRow(),
            findAndCountAll: async () => ({ rows: [sessionRow()], count: 1 }),
            update: async (attrs) => {
                updateCalls.push(attrs);
                Object.assign(stored, attrs);
                return [1];
            },
            destroy: async () => 1,
        },
        Channel: {
            findAll: async () => [{ id: 1 }],
            findByPk: async () => ({ id: 1 }),
            update: async () => [1],
            create: async () => ({ id: 1 }),
            destroy: async () => 1,
            getPaginatedCaptions: async () => ({ totalClosedCaptions: 0, totalTranslatedCaptions: 0, closedCaptions: [], translatedCaptions: {} }),
        },
        Caption: { findAll: async () => [], destroy: async () => 0 },
        TranslatedCaption: { findAll: async () => [], destroy: async () => 0 },
        formatCaption: (c) => c,
        groupTranslatedCaptions: (arr) => arr,
    };
}

// A stored meta the way Meet writes it: the generic capability map + the keys the
// frontend polls. `token` is the part no client can ever read back.
function storedMeta() {
    return {
        room: 'room-1',
        state: 'ready',
        livekitUrl: 'wss://lk.example',
        native: { 'visio-native': { livekitUrl: 'wss://lk.example', room: 'room-1', token: 'meet-jwt' } },
    };
}

describe('Session-API session.meta native token (C6)', () => {
    let teardown;
    let sessionsRoutes;
    let updateCalls;

    before(() => {
        teardown = setupMocks();
        stored = { name: 'before', meta: storedMeta() };
        mockModel = buildModelMock();
        sessionsRoutes = require(sessionsRoutePath)({ emit: () => {} });
    });

    after(() => { if (teardown) teardown(); });

    beforeEach(() => {
        stored = { name: 'before', meta: storedMeta() };
        updateCalls = [];
        mockModel = buildModelMock({ updateCalls });
    });

    async function patch(body) {
        const route = getRoute(sessionsRoutes, '/sessions/:id', 'patch');
        const res = makeRes();
        let nextErr;
        await route.controller(makeReq(body, { id: 'sess-1' }), res, (err) => { nextErr = err; });
        assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
        return res.captured;
    }

    async function put(body) {
        const route = getRoute(sessionsRoutes, '/sessions/:id', 'put');
        const res = makeRes();
        let nextErr;
        await route.controller(makeReq(body, { id: 'sess-1' }), res, (err) => { nextErr = err; });
        assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
        return res.captured;
    }

    // What a client can actually read: the scrubbed descriptor (no token).
    const scrubbedMeta = () => ({
        room: 'room-1',
        state: 'ready',
        livekitUrl: 'wss://lk.example',
        native: { 'visio-native': { livekitUrl: 'wss://lk.example', room: 'room-1' } },
    });

    // -------------------- read paths still hide the token --------------------

    it('1. GET /sessions/:id never returns the token', async () => {
        const route = getRoute(sessionsRoutes, '/sessions/:id', 'get');
        const res = makeRes();
        await route.controller(makeReq({}, { id: 'sess-1' }, { withCaptions: 'false' }), res, () => {});
        assert.strictEqual('token' in res.captured.body.meta.native['visio-native'], false);
        assert.strictEqual(res.captured.body.meta.room, 'room-1');
    });

    it('2. GET /sessions (list) never returns the token', async () => {
        const route = getRoute(sessionsRoutes, '/sessions', 'get');
        const res = makeRes();
        await route.controller(makeReq({}, {}, {}), res, () => {});
        const session = res.captured.body.sessions[0];
        assert.strictEqual('token' in session.meta.native['visio-native'], false);
    });

    // -------------------- PATCH round trip --------------------

    it('3. PATCH read-modify-write (scrubbed meta echoed back) PRESERVES the stored token', async () => {
        const captured = await patch({ name: 'renamed', meta: scrubbedMeta() });
        assert.strictEqual(captured.statusCode, 200);
        // The DB write carried the token back in...
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
        assert.strictEqual(stored.name, 'renamed');
        // ...and the response still hides it.
        assert.strictEqual('token' in captured.body.meta.native['visio-native'], false);
    });

    it('4. PATCH with an explicit token:null does NOT wipe the stored token', async () => {
        const meta = scrubbedMeta();
        meta.native['visio-native'].token = null;
        await patch({ meta });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
    });

    it("5. PATCH with an explicit token:'' does NOT wipe the stored token", async () => {
        const meta = scrubbedMeta();
        meta.native['visio-native'].token = '';
        await patch({ meta });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
    });

    it('6. PATCH with a REAL new token replaces it (the mint / re-mint path)', async () => {
        const meta = scrubbedMeta();
        meta.native['visio-native'].token = 'fresh-jwt';
        await patch({ meta });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'fresh-jwt');
    });

    it('7. PATCH does not RESURRECT a token for a capability that carries none', async () => {
        stored.meta = { room: 'room-1', native: { 'visio-native': { room: 'room-1' } } };
        const meta = { room: 'room-1', native: { 'visio-native': { room: 'room-1', token: null } } };
        await patch({ meta });
        assert.strictEqual(stored.meta.native['visio-native'].token, null);
    });

    it('8. dropping the whole native map removes the capability (no resurrection)', async () => {
        // Deliberately removing the native declaration is a visible change: the
        // session simply stops being native-capable. Nothing is re-injected.
        await patch({ meta: { room: 'room-1', state: 'ready' } });
        assert.deepStrictEqual(stored.meta, { room: 'room-1', state: 'ready' });
    });

    it('9. an unrelated capability keeps its own stored token, per capability', async () => {
        stored.meta = {
            native: {
                'visio-native': { token: 'visio-jwt' },
                'teams-native': { token: 'teams-jwt' },
            },
        };
        await patch({ meta: { native: { 'visio-native': {}, 'teams-native': {}, 'new-native': { url: 'x' } } } });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'visio-jwt');
        assert.strictEqual(stored.meta.native['teams-native'].token, 'teams-jwt');
        assert.strictEqual('token' in stored.meta.native['new-native'], false);
    });

    it('10. the legacy meta.linto_native alias is protected the same way', async () => {
        stored.meta = { room: 'r', linto_native: { room: 'r', livekitUrl: 'ws://lk', token: 'alias-jwt' } };
        await patch({ meta: { room: 'r', linto_native: { room: 'r', livekitUrl: 'ws://lk' } } });
        assert.strictEqual(stored.meta.linto_native.token, 'alias-jwt');
    });

    it('11. a PATCH without `meta` leaves the stored meta untouched', async () => {
        await patch({ name: 'renamed' });
        assert.deepStrictEqual(updateCalls, [{ name: 'renamed' }]);
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
    });

    it('12. an explicit meta:null still clears the column (legacy full replacement)', async () => {
        await patch({ meta: null });
        assert.strictEqual(stored.meta, null);
    });

    it('13. a non-object meta is passed through unchanged (legacy behaviour)', async () => {
        await patch({ meta: 'not-an-object' });
        assert.strictEqual(stored.meta, 'not-an-object');
    });

    // -------------------- PUT round trip --------------------

    it('14. PUT read-modify-write PRESERVES the stored token', async () => {
        const captured = await put({ name: 'renamed', meta: scrubbedMeta(), channels: [{ id: 1 }] });
        assert.strictEqual(captured.statusCode, 200);
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
        assert.strictEqual('token' in captured.body.meta.native['visio-native'], false);
    });

    it('15. PUT with an explicit token:null does NOT wipe the stored token', async () => {
        const meta = scrubbedMeta();
        meta.native['visio-native'].token = null;
        await put({ meta, channels: [{ id: 1 }] });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
    });

    it('16. PUT without `meta` leaves the stored meta untouched', async () => {
        await put({ name: 'renamed', channels: [{ id: 1 }] });
        assert.strictEqual(stored.meta.native['visio-native'].token, 'meet-jwt');
        assert.ok(updateCalls.every(c => !('meta' in c)));
    });

    // -------------------- shape preservation of meta.native --------------------
    //
    // `meta` is a free-form, client-writable JSON column: nothing stops a client
    // from sending an ARRAY under `native`. Nonsense input, but the merge/scrub
    // helpers must PASS IT THROUGH (legacy full-replacement semantics), not
    // silently rewrite it into an object with numeric string keys — otherwise
    // what the client reads back is not what it wrote.

    it('17. PATCH with an ARRAY-valued meta.native stores it verbatim (no object rewrite)', async () => {
        await patch({ meta: { room: 'room-1', native: [{ cap: 'visio-native', url: 'ws://lk' }] } });
        assert.ok(Array.isArray(stored.meta.native), 'the array shape survives the write');
        assert.deepStrictEqual(stored.meta.native, [{ cap: 'visio-native', url: 'ws://lk' }]);
    });

    it('18. PUT with an ARRAY-valued meta.native stores it verbatim too', async () => {
        await put({ meta: { native: ['a', 'b'] }, channels: [{ id: 1 }] });
        assert.ok(Array.isArray(stored.meta.native));
        assert.deepStrictEqual(stored.meta.native, ['a', 'b']);
    });

    it('19. an ARRAY-valued meta.native is still SCRUBBED on read (shape kept, token gone)', async () => {
        // Preserving the shape must never become "skip the scrub": a token nested
        // in an array-valued native would then leak to the client.
        stored.meta = { room: 'r', native: [{ room: 'r', token: 'meet-jwt' }] };
        const route = getRoute(sessionsRoutes, '/sessions/:id', 'get');
        const res = makeRes();
        await route.controller(makeReq({}, { id: 'sess-1' }, { withCaptions: 'false' }), res, () => {});
        const native = res.captured.body.meta.native;
        assert.ok(Array.isArray(native), 'the array is not rewritten into { "0": ... }');
        assert.strictEqual('token' in native[0], false, 'the nested token is still stripped');
        assert.strictEqual(native[0].room, 'r');
        // ...and the underlying row keeps its token.
        assert.strictEqual(stored.meta.native[0].token, 'meet-jwt');
    });

    it('20. an array read-modify-write keeps the token index-wise (no erasure by omission)', async () => {
        stored.meta = { native: [{ room: 'r', token: 'meet-jwt' }] };
        await patch({ meta: { native: [{ room: 'r' }] } });
        assert.ok(Array.isArray(stored.meta.native));
        assert.strictEqual(stored.meta.native[0].token, 'meet-jwt');
    });
});
