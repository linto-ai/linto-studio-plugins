const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// Tests Session-API route controllers (sessions.js, templates.js) by invoking
// them directly with mocked Model. Validates that translation validation errors
// surface as ApiError with status 400 through the next(err) chain.

const liveSrtLibPath = require.resolve('live-srt-lib');
const sessionsRoutePath = path.resolve(__dirname, '../../Session-API/components/WebServer/routes/api/sessions.js');
const templatesRoutePath = path.resolve(__dirname, '../../Session-API/components/WebServer/routes/api/templates.js');
const helpersPath = path.resolve(__dirname, '../../Session-API/components/WebServer/routes/api/translationHelpers.js');

let mockModel;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: {
            Model: new Proxy({}, { get: (_, k) => mockModel[k] }),
            logger: { info() {}, warn() {}, error() {}, debug() {} },
        }
    };
    delete require.cache[helpersPath];
    delete require.cache[sessionsRoutePath];
    delete require.cache[templatesRoutePath];
    return function teardown() {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        delete require.cache[helpersPath];
        delete require.cache[sessionsRoutePath];
        delete require.cache[templatesRoutePath];
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

function makeReq(body, params = {}, query = {}) {
    return {
        body,
        params,
        query,
        user: { uid: 'tester' },
        payload: { token: { iss: 'admin' } },
    };
}

describe('Route controllers: HTTP routes call helpers with proper error handling', () => {
    let teardown;
    let sessionsRoutes;
    let templatesRoutes;

    before(() => {
        teardown = setupMocks();
        sessionsRoutes = require(sessionsRoutePath)({ emit() {} });
        templatesRoutes = require(templatesRoutePath)({ emit() {} });
    });

    after(() => { if (teardown) teardown(); });

    beforeEach(() => {
        mockModel = {
            sequelize: { transaction: async () => makeMockTransaction() },
            Op: { startsWith: Symbol('startsWith') },
            Session: { create: async (data) => ({ id: 'session-uuid', ...data }) },
            Channel: { create: async (data) => ({ id: 1, ...data }) },
            TranscriberProfile: {
                findByPk: async () => ({
                    id: 1,
                    config: {
                        type: 'microsoft',
                        languages: [{ candidate: 'en-US' }],
                        availableTranslations: [{ target: 'pt-PT', mode: 'discrete' }],
                    },
                }),
            },
            Translator: { findAll: async () => [] },
            SessionTemplate: {
                create: async (data) => ({ id: 1, ...data }),
                findByPk: async () => ({ id: 1, channels: [] }),
                update: async () => [1],
            },
            ChannelTemplate: {
                create: async (data) => ({ id: 1, ...data }),
                destroy: async () => {},
            },
        };
    });

    function getRoute(routes, path, method) {
        return routes.find(r => r.path === path && r.method === method);
    }

    describe('POST /sessions — translations validation', () => {
        it('rejects channel with mixed pt + pt-PT (ambiguous) via next(ApiError 400)', async () => {
            const route = getRoute(sessionsRoutes, '/sessions', 'post');
            assert.ok(route, 'POST /sessions route not found');

            const req = makeReq({
                channels: [{
                    transcriberProfileId: 1,
                    translations: [
                        { target: 'pt', mode: 'discrete' },
                        { target: 'pt-PT', mode: 'discrete' },
                    ],
                }],
            });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.ok(nextErr, 'expected next(err) to be called');
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Ambiguous translation targets/);
        });

        it('rejects channel with invalid BCP47 tag via next(ApiError 400)', async () => {
            const route = getRoute(sessionsRoutes, '/sessions', 'post');
            const req = makeReq({
                channels: [{
                    transcriberProfileId: 1,
                    translations: [{ target: '!!!', mode: 'discrete' }],
                }],
            });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Invalid BCP47 tag/);
        });

        it('accepts valid pt-PT and persists normalized translations on the Channel', async () => {
            const route = getRoute(sessionsRoutes, '/sessions', 'post');
            let createdChannel;
            mockModel.Channel.findAll = async () => [];
            mockModel.Channel.update = async () => {};
            mockModel.Channel.create = async (data) => {
                createdChannel = data;
                return { id: 1, ...data };
            };
            mockModel.Session.findByPk = async () => ({ id: 'session-uuid', channels: [] });

            const req = makeReq({
                channels: [{
                    transcriberProfileId: 1,
                    translations: [{ target: 'pt-PT', mode: 'discrete' }],
                }],
            });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.strictEqual(nextErr, undefined,
                `unexpected next(err): ${nextErr && nextErr.message}`);
            assert.ok(createdChannel, 'Model.Channel.create should have been invoked');
            assert.deepStrictEqual(
                createdChannel.translations,
                [{ target: 'pt-PT', mode: 'discrete' }],
                'translation must reach DB layer with the original BCP47 tag preserved'
            );
        });
    });

    describe('POST /templates — translations validation', () => {
        it('rejects template channel with mixed pt + pt-PT via next(ApiError 400)', async () => {
            const route = getRoute(templatesRoutes, '/templates', 'post');
            assert.ok(route, 'POST /templates route not found');

            const req = makeReq({
                channels: [{
                    transcriberProfileId: 1,
                    translations: [
                        { target: 'pt', mode: 'discrete' },
                        { target: 'pt-PT', mode: 'discrete' },
                    ],
                }],
            });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.ok(nextErr, 'expected next(err) to be called');
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Ambiguous translation targets/);
        });

        it('accepts legacy string format and normalizes to discrete objects', async () => {
            const route = getRoute(templatesRoutes, '/templates', 'post');
            const created = [];
            mockModel.ChannelTemplate.create = async (data) => { created.push(data); return { id: created.length, ...data }; };

            const req = makeReq({
                name: 'tpl',
                channels: [{
                    transcriberProfileId: 1,
                    translations: ['pt-PT', 'fr-CA'],
                }],
            });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.strictEqual(nextErr, undefined,
                `unexpected next(err): ${nextErr && nextErr.message}`);
            assert.strictEqual(created.length, 1);
            // Stored translations should be normalized to objects with mode discrete.
            assert.deepStrictEqual(created[0].translations, [
                { target: 'pt-PT', mode: 'discrete' },
                { target: 'fr-CA', mode: 'discrete' },
            ]);
        });

        it('rejects PUT /templates/:id with duplicate canonicalized targets', async () => {
            const route = getRoute(templatesRoutes, '/templates/:id', 'put');
            assert.ok(route, 'PUT /templates/:id route not found');

            // PUT first does findByPk to verify the template exists.
            mockModel.SessionTemplate.findByPk = async () => ({ id: 1, name: 'existing' });

            const req = makeReq({
                name: 'updated',
                channels: [{
                    transcriberProfileId: 1,
                    translations: [
                        { target: 'pt-PT', mode: 'discrete' },
                        { target: 'pt-pt', mode: 'discrete' }, // canonical duplicate
                    ],
                }],
            }, { id: 1 });
            const res = makeRes();
            let nextErr;
            await route.controller(req, res, (err) => { nextErr = err; });

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Duplicate translation target/);
        });
    });
});
