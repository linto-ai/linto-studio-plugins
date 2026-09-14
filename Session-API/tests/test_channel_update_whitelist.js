const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// PUT /sessions/:id spread the client-supplied channel object straight into
// Model.Channel.update(), so a caller could overwrite platform-owned columns:
// transcriberId (ownership), streamStatus, streamEndpoints, lastSegmentId,
// audioFile, sessionId (re-parenting a channel into another session), id.
// The update now goes through a column whitelist. Same require-cache harness
// as test_pause_resume.js: DB and MQTT fully mocked.

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
        status(c) { captured.statusCode = c; return this; },
        json(b) { captured.body = b; return this; },
        captured,
    };
}

const SESSION_ID = 'sess-1';
const CHANNEL_ID = 7;

describe('PUT /sessions/:id channel column whitelist', () => {
    let teardown, put, channelUpdates;

    before(() => {
        teardown = setupMocks();
        const routes = require(sessionsRoutePath)({ emit() {} });
        put = routes.find((r) => r.path === '/sessions/:id' && r.method === 'put').controller;
    });
    after(() => teardown && teardown());

    beforeEach(() => {
        channelUpdates = [];
        const currentChannel = { id: CHANNEL_ID, sessionId: SESSION_ID, transcriberProfileId: null, name: 'old' };
        const sessionRow = {
            id: SESSION_ID, status: 'ready', startTime: null, meta: null,
            channels: [{ ...currentChannel, setDataValue() {} }],
        };
        mockModel = {
            sequelize: { transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) },
            Op: {},
            Session: {
                findByPk: async () => sessionRow,
                update: async () => [1],
            },
            Channel: {
                findByPk: async (id) => (id === CHANNEL_ID ? currentChannel : null),
                findAll: async () => [currentChannel],
                update: async (data, opts) => { channelUpdates.push({ data, opts }); return [1]; },
                destroy: async () => 1,
                create: async () => { throw new Error('no channel should be created'); },
            },
            TranscriberProfile: { findByPk: async () => null },
        };
    });

    async function run(channel) {
        const res = makeRes();
        let nextErr = null;
        await put({ params: { id: SESSION_ID }, body: { channels: [channel] }, query: {} }, res, (e) => { nextErr = e; });
        return { res, nextErr };
    }

    it('drops platform-owned columns from the client channel object', async () => {
        const { res, nextErr } = await run({
            id: CHANNEL_ID,
            name: 'renamed',
            keepAudio: false,
            // Platform-owned, must never come from the body:
            transcriberId: 'attacker-transcriber',
            streamStatus: 'active',
            streamEndpoints: { srt: 'srt://evil' },
            lastSegmentId: 999,
            audioFile: '/etc/passwd',
            sessionId: 'another-session',
            languages: ['xx-XX'],
            createdAt: '1970-01-01',
        });
        assert.strictEqual(nextErr, null);
        assert.strictEqual(res.captured.statusCode, 200);

        // The channel-level update is the one targeting our channel id (the
        // streamEndpoints recomputation issued by setChannelsEndpoints is separate).
        const chanUpdate = channelUpdates.find((u) => u.opts.where.id === CHANNEL_ID && 'name' in u.data);
        assert.ok(chanUpdate, 'expected a Channel.update carrying the client fields');
        const { data } = chanUpdate;
        assert.strictEqual(data.name, 'renamed');
        assert.strictEqual(data.keepAudio, false);
        for (const forbidden of ['transcriberId', 'streamStatus', 'streamEndpoints', 'lastSegmentId', 'audioFile', 'languages', 'createdAt', 'id']) {
            assert.ok(!(forbidden in data), `${forbidden} must not be forwarded to Channel.update`);
        }
        // sessionId is always the session in the path, never the body value.
        assert.strictEqual(data.sessionId, SESSION_ID);
    });

    it('still forwards every legitimate client field', async () => {
        await run({
            id: CHANNEL_ID, name: 'n', keepAudio: true, diarization: true, compressAudio: true,
            enableLiveTranscripts: false, meta: { k: 'v' },
        });
        const { data } = channelUpdates.find((u) => u.opts.where.id === CHANNEL_ID && 'name' in u.data);
        assert.deepStrictEqual(
            Object.keys(data).sort(),
            ['compressAudio', 'diarization', 'enableLiveTranscripts', 'keepAudio', 'meta', 'name', 'sessionId'].sort()
        );
        assert.deepStrictEqual(data.meta, { k: 'v' });
    });
});
