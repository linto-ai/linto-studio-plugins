const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// The bot routes used to ignore the organization: any member of an org with
// the BOT permission could list, read, stop or start the bots of another org.
// The Studio proxy now forces query.organizationId on every bot route and the
// routes scope Bot -> Channel -> Session.organizationId. The admin route sends
// no organization and keeps the global behaviour.

const liveSrtLibPath = require.resolve('live-srt-lib');
const botsRoutePath = path.resolve(__dirname, '../components/WebServer/routes/api/bots.js');
const helpersPath = path.resolve(__dirname, '../components/WebServer/routes/api/bots.helpers.js');

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
    require.cache[helpersPath] = {
        id: helpersPath, filename: helpersPath, loaded: true,
        exports: { validateBotUrlResolved: async () => null },
    };
    delete require.cache[botsRoutePath];
    return () => {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        delete require.cache[helpersPath];
        delete require.cache[botsRoutePath];
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

let calls;
const Session = { name: 'Session' };
const Channel = {
    name: 'Channel',
    findByPk: async (id, opts) => {
        calls.channelFindByPk.push({ id, opts });
        if (opts && opts.include) return null;
        return { id, streamStatus: 'inactive', compressAudio: false, enableLiveTranscripts: true };
    },
};

function expectedBotScope(organizationId) {
    return {
        model: Channel,
        attributes: [],
        required: true,
        include: { model: Session, attributes: [], required: true, where: { organizationId } },
    };
}

describe('Bot routes organization scoping', () => {
    let teardown, routes, events;

    function controller(method, routePath) {
        return routes.find((r) => r.path === routePath && r.method === method).controller;
    }

    async function run(method, routePath, req) {
        const res = makeRes();
        let nextErr = null;
        await controller(method, routePath)({ params: {}, query: {}, body: {}, ...req }, res, (e) => { nextErr = e; });
        return { res, nextErr };
    }

    before(() => {
        teardown = setupMocks();
        events = [];
        routes = require(botsRoutePath)({ emit: (...a) => events.push(a) });
    });
    after(() => teardown && teardown());

    beforeEach(() => {
        calls = { findByPk: [], findAndCountAll: [], channelFindByPk: [], create: [] };
        events.length = 0;
        mockModel = {
            Session,
            Channel,
            Bot: {
                findByPk: async (id, opts) => { calls.findByPk.push({ id, opts }); return opts.include ? null : { id }; },
                findAndCountAll: async (opts) => { calls.findAndCountAll.push(opts); return { rows: [], count: 0 }; },
                create: async (data) => { calls.create.push(data); return { id: 7, ...data }; },
            },
        };
    });

    it('GET /bots scopes the list to the organization forced by the proxy', async () => {
        const { res } = await run('get', '/bots', { query: { organizationId: 'org-A', limit: 1000 } });
        assert.strictEqual(res.captured.statusCode, 200);
        assert.deepStrictEqual(calls.findAndCountAll[0].include, expectedBotScope('org-A'));
    });

    it('GET /bots without organization (admin route) stays global', async () => {
        await run('get', '/bots', { query: {} });
        assert.strictEqual(calls.findAndCountAll[0].include, undefined);
    });

    it('GET /bots rejects a non string organizationId', async () => {
        const { res } = await run('get', '/bots', { query: { organizationId: { $ne: 'x' } } });
        assert.strictEqual(res.captured.statusCode, 400);
        assert.strictEqual(calls.findAndCountAll.length, 0);
    });

    it('GET /bots/:id returns 404 for a bot outside the organization', async () => {
        const { res } = await run('get', '/bots/:id', { params: { id: '3' }, query: { organizationId: 'org-A' } });
        assert.strictEqual(res.captured.statusCode, 404);
        assert.strictEqual(calls.findByPk[0].id, '3');
        assert.deepStrictEqual(calls.findByPk[0].opts.include, expectedBotScope('org-A'));
    });

    it('DELETE /bots/:id does not stop a bot outside the organization', async () => {
        const { res } = await run('delete', '/bots/:id', { params: { id: '3' }, query: { organizationId: 'org-A' } });
        assert.strictEqual(res.captured.statusCode, 404);
        assert.strictEqual(events.length, 0);
    });

    it('DELETE /bots/:id without organization (admin route) still stops the bot', async () => {
        const { res } = await run('delete', '/bots/:id', { params: { id: '3' } });
        assert.deepStrictEqual(res.captured.body, { success: true });
        assert.deepStrictEqual(events, [['stopbot', '3']]);
    });

    it('POST /bots refuses a channel whose session belongs to another organization', async () => {
        const { res } = await run('post', '/bots', {
            query: { organizationId: 'org-A' },
            body: { url: 'https://meet.example.org/x', channelId: 12, provider: 'jitsi' },
        });
        assert.strictEqual(res.captured.statusCode, 404);
        assert.deepStrictEqual(calls.channelFindByPk[0].opts.include,
            { model: Session, attributes: [], required: true, where: { organizationId: 'org-A' } });
        assert.strictEqual(calls.create.length, 0);
        assert.strictEqual(events.length, 0);
    });

    it('POST /bots without organization (admin route) keeps the global lookup', async () => {
        const { res } = await run('post', '/bots', {
            body: { url: 'https://meet.example.org/x', channelId: 12, provider: 'jitsi' },
        });
        assert.strictEqual(res.captured.statusCode, 200);
        assert.deepStrictEqual(calls.channelFindByPk[0].opts, {});
        assert.deepStrictEqual(events, [['startbot', 7]]);
    });
});
