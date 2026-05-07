const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// Unit tests for Session-API pause/resume endpoints, PATCH whitelist, and
// DELETE protection on paused sessions. Routes are loaded via require-cache
// injection of `live-srt-lib` so DB and MQTT layers are fully mocked.

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
        status(code) {
            captured.statusCode = code;
            return this;
        },
        json(body) {
            captured.body = body;
            return this;
        },
        send(body) {
            captured.body = body;
            return this;
        },
        end() {
            return this;
        },
        captured,
    };
}

function makeReq(body = {}, params = {}, query = {}) {
    return {
        body,
        params,
        query,
        user: { uid: 'tester' },
        payload: { token: { iss: 'admin' } },
    };
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
        setDataValue: function (k, v) {
            this[k] = v;
        },
        ...overrides,
    };
    // Sequelize-like instance update: mutates in place and records the call.
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

describe('Session-API pause/resume + PATCH whitelist + DELETE force', () => {
    let teardown;
    let sessionsRoutes;
    let webserverEvents;
    let webserver;

    before(() => {
        teardown = setupMocks();
        webserverEvents = [];
        webserver = {
            emit: (...args) => {
                webserverEvents.push(args);
            },
        };
        sessionsRoutes = require(sessionsRoutePath)(webserver);
    });

    after(() => {
        if (teardown) teardown();
    });

    beforeEach(() => {
        webserverEvents.length = 0;
        // Default mock model — overridden in individual tests.
        mockModel = {
            sequelize: { transaction: async () => makeMockTransaction() },
            Op: { startsWith: Symbol('startsWith'), in: Symbol('in'), lt: Symbol('lt'), gt: Symbol('gt'), ne: Symbol('ne') },
            Session: {
                findByPk: async () => null,
                update: async () => [1],
                destroy: async () => 1,
            },
            Channel: {
                findAll: async () => [],
                update: async () => [1],
            },
            Caption: { findAll: async () => [] },
            TranslatedCaption: { findAll: async () => [] },
            formatCaption: (c) => c,
            groupTranslatedCaptions: (arr) => arr,
        };
    });

    // -------------------- PAUSE --------------------

    describe('PUT /sessions/:id/pause', () => {
        it('1. active session → 200, status=paused, pausedAt set', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            assert.ok(route, 'route not found');

            const initial = fakeSession({ status: 'active' });
            mockModel.Session.findByPk = async () => initial;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
            assert.strictEqual(res.captured.statusCode, 200);
            assert.strictEqual(initial.updateCalls.length, 1);
            assert.strictEqual(initial.updateCalls[0].status, 'paused');
            assert.ok(initial.updateCalls[0].pausedAt instanceof Date, 'pausedAt should be a Date');
        });

        it('2. already paused session → 200 idempotent, no DB update', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            const updateCalls = [];
            mockModel.Session.findByPk = async () =>
                fakeSession({ status: 'paused', pausedAt: new Date() });
            mockModel.Session.update = async (...args) => {
                updateCalls.push(args);
                return [1];
            };

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(res.captured.statusCode, 200);
            assert.strictEqual(updateCalls.length, 0, 'no DB update expected on idempotent pause');
        });

        it('3. ready session → 400', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            mockModel.Session.findByPk = async () => fakeSession({ status: 'ready' });

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr, 'expected next(err)');
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Cannot pause/i);
        });

        it('4. terminated session → 400', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            mockModel.Session.findByPk = async () => fakeSession({ status: 'terminated' });

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
        });

        it('5. on_schedule session → 400', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            mockModel.Session.findByPk = async () => fakeSession({ status: 'on_schedule' });

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
        });

        it('6. non-existent session → 404', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            mockModel.Session.findByPk = async () => null;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'unknown' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 404);
        });

        it('7. emits "session-paused" with the updated session', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            let phase = 0;
            mockModel.Session.findByPk = async () => {
                phase += 1;
                if (phase === 1) return fakeSession({ status: 'active' });
                return fakeSession({ status: 'paused', pausedAt: new Date() });
            };

            const res = makeRes();
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                () => {}
            );

            const paused = webserverEvents.find((e) => e[0] === 'session-paused');
            assert.ok(paused, 'session-paused event should be emitted');
            assert.ok(paused[1], 'session-paused should carry the session');
            assert.strictEqual(paused[1].status, 'paused');
        });

        it('8. emits "session-update"', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/pause', 'put');
            let phase = 0;
            mockModel.Session.findByPk = async () => {
                phase += 1;
                if (phase === 1) return fakeSession({ status: 'active' });
                return fakeSession({ status: 'paused', pausedAt: new Date() });
            };

            const res = makeRes();
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                () => {}
            );

            const updated = webserverEvents.find((e) => e[0] === 'session-update');
            assert.ok(updated, 'session-update event should be emitted');
        });
    });

    // -------------------- RESUME --------------------

    describe('PUT /sessions/:id/resume', () => {
        it('9. paused session → 200, status=active, pausedAt=null', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            const initial = fakeSession({ status: 'paused', pausedAt: new Date() });
            mockModel.Session.findByPk = async () => initial;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
            assert.strictEqual(res.captured.statusCode, 200);
            assert.strictEqual(initial.updateCalls.length, 1);
            assert.strictEqual(initial.updateCalls[0].status, 'active');
            assert.strictEqual(initial.updateCalls[0].pausedAt, null);
        });

        it('10. already active session → 200 idempotent, no DB update', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            const updateCalls = [];
            mockModel.Session.findByPk = async () => fakeSession({ status: 'active' });
            mockModel.Session.update = async (...args) => {
                updateCalls.push(args);
                return [1];
            };

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(res.captured.statusCode, 200);
            assert.strictEqual(updateCalls.length, 0);
        });

        it('11. ready session → 400 (cannot resume)', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            mockModel.Session.findByPk = async () => fakeSession({ status: 'ready' });

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
            assert.match(nextErr.message, /Cannot resume/i);
        });

        it('11b. terminated session → 400', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            mockModel.Session.findByPk = async () => fakeSession({ status: 'terminated' });

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 400);
        });

        it('11c. non-existent session → 404', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            mockModel.Session.findByPk = async () => null;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'unknown' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr);
            assert.strictEqual(nextErr.status, 404);
        });

        it('12. emits "session-resumed" with updated session', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id/resume', 'put');
            let phase = 0;
            mockModel.Session.findByPk = async () => {
                phase += 1;
                if (phase === 1) return fakeSession({ status: 'paused', pausedAt: new Date() });
                return fakeSession({ status: 'active', pausedAt: null });
            };

            const res = makeRes();
            await route.controller(
                makeReq({}, { id: 'test-session-id' }),
                res,
                () => {}
            );

            const resumed = webserverEvents.find((e) => e[0] === 'session-resumed');
            assert.ok(resumed, 'session-resumed event should be emitted');
            assert.ok(resumed[1], 'session-resumed should carry the session');
            assert.strictEqual(resumed[1].status, 'active');
        });
    });

    // -------------------- PATCH WHITELIST --------------------

    describe('PATCH /sessions/:id whitelist', () => {
        it('13. body { status: "paused" } → status NOT forwarded to Model.Session.update', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'patch');
            assert.ok(route, 'PATCH route not found');

            const updateCalls = [];
            mockModel.Session.findByPk = async () => fakeSession({ status: 'active' });
            mockModel.Session.update = async (data, opts) => {
                updateCalls.push({ data, opts });
                return [1];
            };

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({ status: 'paused' }, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(updateCalls.length, 1);
            assert.ok(
                !('status' in updateCalls[0].data),
                'status must be filtered out by the whitelist'
            );
        });

        it('14. body { name: "newname" } → name forwarded to update', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'patch');
            const updateCalls = [];
            mockModel.Session.findByPk = async () => fakeSession({ status: 'active' });
            mockModel.Session.update = async (data, opts) => {
                updateCalls.push({ data, opts });
                return [1];
            };

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({ name: 'newname' }, { id: 'test-session-id' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(updateCalls.length, 1);
            assert.strictEqual(updateCalls[0].data.name, 'newname');
        });

        it('15. body { startTime: <Date> } → startTime ignored by whitelist', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'patch');
            const updateCalls = [];
            mockModel.Session.findByPk = async () => fakeSession({ status: 'active' });
            mockModel.Session.update = async (data, opts) => {
                updateCalls.push({ data, opts });
                return [1];
            };

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq(
                    { startTime: new Date('2030-01-01T00:00:00Z'), name: 'ok' },
                    { id: 'test-session-id' }
                ),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined);
            assert.strictEqual(updateCalls.length, 1);
            assert.ok(
                !('startTime' in updateCalls[0].data),
                'startTime must be filtered out by the whitelist'
            );
            assert.strictEqual(updateCalls[0].data.name, 'ok');
        });

        it('15b. PATCH on non-existent session → 404', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'patch');
            mockModel.Session.findByPk = async () => null;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({ name: 'x' }, { id: 'unknown' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(res.captured.statusCode, 404);
            assert.strictEqual(nextErr, undefined);
        });
    });

    // -------------------- DELETE --------------------

    describe('DELETE /sessions/:id (paused protection)', () => {
        it('16. paused session without force → 400 via next(err)', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'delete');
            assert.ok(route, 'DELETE route not found');
            const destroyCalls = [];
            const sess = fakeSession({ status: 'paused' });
            sess.destroy = async () => {
                destroyCalls.push(true);
            };
            mockModel.Session.findByPk = async () => sess;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }, {}),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.ok(nextErr, 'expected next(err)');
            assert.strictEqual(nextErr.status, 400);
            assert.strictEqual(destroyCalls.length, 0, 'destroy must not be called');
        });

        it('17. paused session with force=true → 200, destroy called', async () => {
            const route = getRoute(sessionsRoutes, '/sessions/:id', 'delete');
            const destroyCalls = [];
            const sess = fakeSession({ status: 'paused' });
            sess.destroy = async () => {
                destroyCalls.push(true);
            };
            mockModel.Session.findByPk = async () => sess;

            const res = makeRes();
            let nextErr;
            await route.controller(
                makeReq({}, { id: 'test-session-id' }, { force: 'true' }),
                res,
                (err) => {
                    nextErr = err;
                }
            );

            assert.strictEqual(nextErr, undefined, `unexpected next err: ${nextErr && nextErr.message}`);
            assert.strictEqual(res.captured.statusCode, 200);
            assert.deepStrictEqual(res.captured.body, { success: true });
            assert.strictEqual(destroyCalls.length, 1);
        });
    });
});
