const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// POST /sessions/purge used to run Session.destroy({}) with force=true, i.e.
// every session of every organization, and the Studio proxy exposes it to any
// Meeting Manager of any organization. The route now honours the
// organizationId the proxy injects in the body and scopes the destroy to it.
// Routes are loaded via require-cache injection of `live-srt-lib` (same
// harness as test_pause_resume.js) so the DB layer is fully mocked.

const liveSrtLibPath = require.resolve('live-srt-lib');
const sessionsRoutePath = path.resolve(__dirname, '../components/WebServer/routes/api/sessions.js');
const helpersPath = path.resolve(__dirname, '../components/WebServer/routes/api/translationHelpers.js');

let mockModel;

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

function makeRes() {
    const captured = { statusCode: 200, body: null };
    return {
        status(code) { captured.statusCode = code; return this; },
        json(body) { captured.body = body; return this; },
        captured,
    };
}

describe('POST /sessions/purge organization scoping', () => {
    let teardown, purge, destroyCalls, events;

    before(() => {
        teardown = setupMocks();
        events = [];
        const routes = require(sessionsRoutePath)({ emit: (...a) => events.push(a) });
        purge = routes.find((r) => r.path === '/sessions/purge' && r.method === 'post').controller;
    });
    after(() => teardown && teardown());

    beforeEach(() => {
        destroyCalls = [];
        events.length = 0;
        mockModel = {
            Session: { destroy: async (opts) => { destroyCalls.push(opts); return 1; } },
        };
    });

    async function run(body, query = {}) {
        const res = makeRes();
        let nextErr = null;
        await purge({ body, query, params: {} }, res, (e) => { nextErr = e; });
        return { res, nextErr };
    }

    it('scopes a Meeting Manager force purge to the organization injected by the proxy', async () => {
        const { res } = await run({ organizationId: 'org-A' }, { force: 'true' });
        assert.strictEqual(res.captured.statusCode, 200);
        assert.deepStrictEqual(res.captured.body, { success: true });
        assert.strictEqual(destroyCalls.length, 1);
        assert.deepStrictEqual(destroyCalls[0].where, { organizationId: 'org-A' });
        assert.ok(events.some((e) => e[0] === 'session-update'));
    });

    it('scopes a plain purge (terminated only) to the organization as well', async () => {
        await run({ organizationId: 'org-A' });
        assert.deepStrictEqual(destroyCalls[0].where, { status: 'terminated', organizationId: 'org-A' });
    });

    it('keeps the global behaviour when no organization is given (administration route)', async () => {
        await run({}, { force: 'true' });
        assert.deepStrictEqual(destroyCalls[0].where, {});
        await run(undefined);
        assert.deepStrictEqual(destroyCalls[1].where, { status: 'terminated' });
    });

    it('treats null / empty organizationId as absent', async () => {
        await run({ organizationId: null });
        assert.deepStrictEqual(destroyCalls[0].where, { status: 'terminated' });
        await run({ organizationId: '' });
        assert.deepStrictEqual(destroyCalls[1].where, { status: 'terminated' });
    });

    it('rejects a non-string organizationId without touching the database', async () => {
        const { res } = await run({ organizationId: { $ne: null } }, { force: 'true' });
        assert.strictEqual(res.captured.statusCode, 400);
        assert.ok(res.captured.body.error);
        assert.strictEqual(destroyCalls.length, 0);
    });

    it('forwards a database error to next()', async () => {
        mockModel.Session.destroy = async () => { throw new Error('db down'); };
        const { nextErr, res } = await run({ organizationId: 'org-A' });
        assert.ok(nextErr instanceof Error);
        assert.strictEqual(res.captured.body, null);
    });
});
