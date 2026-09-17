const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// Private session id: stream endpoints are built from session.privateId, the
// column is excluded from every session read, a session created through the
// API gets one explicitly, and a row without one gets it minted when its
// endpoints are computed. Exercised through the REAL POST /sessions controller
// with a mocked Model (same harness as the other route tests).

const liveSrtLibPath = require.resolve('live-srt-lib');
const sessionsRoutePath = path.resolve(__dirname, '../components/WebServer/routes/api/sessions.js');
const helpersPath = path.resolve(__dirname, '../components/WebServer/routes/api/translationHelpers.js');

let mockModel;
const STREAM_ENV = {
    STREAMING_PROTOCOLS: 'SRT,RTMP,WS', STREAMING_HOST: 'stream.example', STREAMING_SRT_UDP_PORT: '8889',
    STREAMING_RTMP_TCP_PORT: '1935', STREAMING_WS_TCP_PORT: '8890', STREAMING_WS_ENDPOINT: 'transcriber-ws',
    STREAMING_SRT_MODE: 'listener', STREAMING_PASSPHRASE: 'false',
    STREAMING_PROXY_SRT_HOST: 'false', STREAMING_PROXY_SRT_UDP_PORT: 'false',
    STREAMING_PROXY_RTMP_HOST: 'false', STREAMING_PROXY_RTMP_TCP_PORT: 'false',
    STREAMING_PROXY_WS_HOST: 'false', STREAMING_PROXY_WS_TCP_PORT: 'false',
    STREAMING_WS_SECURE: 'false', STREAMING_RTMP_SECURE: 'false',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: {
            Model: new Proxy({}, { get: (_, k) => mockModel[k] }),
            logger: { info() {}, warn() {}, error() {}, debug() {} },
        },
    };
    delete require.cache[helpersPath];
    delete require.cache[sessionsRoutePath];
    return () => {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        delete require.cache[helpersPath];
        delete require.cache[sessionsRoutePath];
    };
}

describe('Private session id (Session-API)', () => {
    let teardown, post, put, channelUpdates, sessionCreates, sessionUpdates, findByPkOpts, findAndCountOpts, savedEnv;
    const PUBLIC_ID = 'sess-public';

    before(() => {
        savedEnv = {};
        for (const [k, v] of Object.entries(STREAM_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
        teardown = setupMocks();
        const routes = require(sessionsRoutePath)({ emit() {} });
        post = routes.find((r) => r.path === '/sessions' && r.method === 'post').controller;
        put = routes.find((r) => r.path === '/sessions/:id' && r.method === 'put').controller;
    });
    after(() => {
        if (teardown) teardown();
        for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    function install({ privateId } = {}) {
        channelUpdates = []; sessionCreates = []; sessionUpdates = []; findByPkOpts = []; findAndCountOpts = [];
        const channels = [{ id: 1 }, { id: 2 }];
        const row = {
            id: PUBLIC_ID, privateId, status: 'ready', startTime: null, meta: null,
            channels: channels.map((c) => ({ ...c, setDataValue() {} })),
            update: async (attrs) => { sessionUpdates.push(attrs); Object.assign(row, attrs); return row; },
        };
        mockModel = {
            sequelize: { transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) },
            Op: {},
            Session: {
                create: async (data) => { sessionCreates.push(data); Object.assign(row, { privateId: data.privateId }); return row; },
                findByPk: async (id, opts) => { findByPkOpts.push(opts); return row; },
                update: async () => [1],
                findAndCountAll: async (opts) => { findAndCountOpts.push(opts); return { count: 0, rows: [] }; },
            },
            Channel: {
                create: async () => ({}),
                findAll: async () => channels,
                findByPk: async (id) => channels.find((c) => c.id === id) || null,
                update: async (data, opts) => { channelUpdates.push({ data, opts }); return [1]; },
                destroy: async () => 1,
            },
            TranscriberProfile: { findByPk: async () => null },
        };
        return row;
    }

    function makeRes() {
        const captured = { statusCode: 200, body: null };
        return { status(c) { captured.statusCode = c; return this; }, json(b) { captured.body = b; return this; }, captured };
    }

    it('POST /sessions mints a v4 privateId and builds every endpoint from it, not from the public id', async () => {
        install();
        const res = makeRes(); let nextErr = null;
        await post({ body: { name: 's', channels: [{ name: 'c0' }, { name: 'c1' }] }, params: {}, query: {} }, res, (e) => { nextErr = e; });
        assert.strictEqual(nextErr, null);
        assert.strictEqual(res.captured.statusCode, 200);
        const privateId = sessionCreates[0].privateId;
        assert.match(privateId, UUID_RE);
        const updates = channelUpdates.filter((u) => 'streamEndpoints' in u.data);
        assert.strictEqual(updates.length, 2);
        updates.forEach((u, index) => {
            const e = u.data.streamEndpoints;
            assert.strictEqual(e.srt, `srt://stream.example:8889?streamid=${privateId},${index}&mode=caller`);
            assert.strictEqual(e.rtmp, `rtmp://stream.example:1935/${privateId}/${index}`);
            assert.strictEqual(e.ws, `ws://stream.example:8890/transcriber-ws/${privateId},${index}`);
            assert.ok(!JSON.stringify(e).includes(PUBLIC_ID), 'the public id must not appear in any endpoint');
        });
    });

    it('PUT /sessions/:id keeps the existing privateId (a running sender is not cut by a rename)', async () => {
        const row = install({ privateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
        const res = makeRes(); let nextErr = null;
        await put({ params: { id: PUBLIC_ID }, body: { name: 'renamed', channels: [{ id: 1 }, { id: 2 }] }, query: {} }, res, (e) => { nextErr = e; });
        assert.strictEqual(nextErr, null);
        assert.strictEqual(sessionUpdates.length, 0);
        const updates = channelUpdates.filter((u) => 'streamEndpoints' in u.data);
        assert.ok(updates.every((u) => u.data.streamEndpoints.ws.includes(row.privateId)));
    });

    it('a row without privateId (migration not applied) gets one minted and persisted before endpoints are computed', async () => {
        install({ privateId: null });
        const res = makeRes(); let nextErr = null;
        await put({ params: { id: PUBLIC_ID }, body: { name: 'x', channels: [{ id: 1 }, { id: 2 }] }, query: {} }, res, (e) => { nextErr = e; });
        assert.strictEqual(nextErr, null);
        assert.strictEqual(sessionUpdates.length, 1);
        assert.match(sessionUpdates[0].privateId, UUID_RE);
        const updates = channelUpdates.filter((u) => 'streamEndpoints' in u.data);
        assert.ok(updates.every((u) => u.data.streamEndpoints.ws.includes(sessionUpdates[0].privateId)));
    });

    it('never selects privateId when reading sessions (single and list)', async () => {
        install({ privateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
        const res = makeRes();
        await post({ body: { name: 's', channels: [{ name: 'c0' }] }, params: {}, query: {} }, res, () => {});
        const withInclude = findByPkOpts.filter((o) => o && o.include);
        assert.ok(withInclude.length > 0);
        for (const o of withInclude) assert.ok(o.attributes.exclude.includes('privateId'), 'getSessionResult must exclude privateId');

        const routes = require(sessionsRoutePath)({ emit() {} });
        const list = routes.find((r) => r.path === '/sessions' && r.method === 'get').controller;
        await list({ query: {}, params: {}, body: {} }, makeRes(), () => {});
        assert.strictEqual(findAndCountOpts.length, 1);
        assert.ok(findAndCountOpts[0].attributes.exclude.includes('privateId'), 'the list must exclude privateId');
    });
});
