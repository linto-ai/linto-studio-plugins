const assert = require('assert');
const path = require('path');
const { describe, it, before, beforeEach } = require('mocha');

// Streams are resolved by the session's PRIVATE id, never by the public id
// (which is visible to every viewer of a live session). The three streaming
// servers are exercised through their real validateStream().

const { parseStreamId, findSessionByPrivateId } = require('../components/StreamingServer/streamId');
const MultiplexedRTMPServer = require(path.resolve(__dirname, '../components/StreamingServer/rtmp/RTMPServer.js'));
const MultiplexedWebsocketServer = require(path.resolve(__dirname, '../components/StreamingServer/websocket/WebsocketServer.js'));

// linto-node-srt is a native addon that only builds in Docker: stub it in the
// require cache (same approach as test_srt_payload_stall.js) to load the REAL
// SRTServer.js.
const srtLibPath = require.resolve('linto-node-srt', { paths: [path.join(__dirname, '..')] });
const srtServerPath = path.resolve(__dirname, '../components/StreamingServer/srt/SRTServer.js');
function loadSrtServer() {
    const libCache = require.cache[srtLibPath];
    const serverCache = require.cache[srtServerPath];
    require.cache[srtLibPath] = {
        id: srtLibPath, filename: srtLibPath, loaded: true,
        exports: { SRT: {}, AsyncSRT: class { async getSockOpt() { return ''; } }, SRTServer: class {} },
    };
    delete require.cache[srtServerPath];
    const Server = require(srtServerPath);
    if (libCache) require.cache[srtLibPath] = libCache; else delete require.cache[srtLibPath];
    if (serverCache) require.cache[srtServerPath] = serverCache; else delete require.cache[srtServerPath];
    return Server;
}

const PUBLIC_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PRIVATE_ID = '9b2e4c1a-0d3f-4e5a-8b6c-7d8e9f0a1b2c';
const OTHER_PRIVATE_ID = '11111111-2222-4333-8444-555555555555';

function sessions() {
    return [
        { id: PUBLIC_ID, privateId: PRIVATE_ID, autoStart: false, autoEnd: false,
          channels: [{ id: 10, streamStatus: 'inactive' }, { id: 11, streamStatus: 'inactive' }] },
        { id: 'other-public', privateId: OTHER_PRIVATE_ID, autoStart: false, autoEnd: false,
          channels: [{ id: 20, streamStatus: 'inactive' }] },
        // Not migrated: unreachable by any stream.
        { id: 'legacy-public', privateId: null, autoStart: false, autoEnd: false,
          channels: [{ id: 30, streamStatus: 'inactive' }] },
    ];
}

describe('Stream identification by private session id', () => {
    describe('parseStreamId()', () => {
        it('parses "<privateId>,<index>"', () => {
            assert.deepStrictEqual(parseStreamId(`${PRIVATE_ID},1`), { privateId: PRIVATE_ID, channelIndex: 1 });
        });
        it('rejects malformed ids', () => {
            for (const bad of ['', PRIVATE_ID, `${PRIVATE_ID},x`, `${PRIVATE_ID},1,extra`, `,1`, `${PRIVATE_ID} ,1`, undefined, 3]) {
                assert.strictEqual(parseStreamId(bad), null, `${JSON.stringify(bad)} must be rejected`);
            }
        });
    });

    describe('findSessionByPrivateId()', () => {
        it('matches on privateId only, never on the public id, and ignores unmigrated sessions', () => {
            assert.strictEqual(findSessionByPrivateId(sessions(), PRIVATE_ID).id, PUBLIC_ID);
            assert.strictEqual(findSessionByPrivateId(sessions(), PUBLIC_ID), undefined);
            assert.strictEqual(findSessionByPrivateId(sessions(), 'legacy-public'), undefined);
            assert.strictEqual(findSessionByPrivateId(sessions(), null), undefined);
            assert.strictEqual(findSessionByPrivateId(sessions(), undefined), undefined);
            assert.strictEqual(findSessionByPrivateId(undefined, PRIVATE_ID), undefined);
        });
    });

    describe('validateStream() across the three servers', () => {
        let rtmp, ws, srt, MultiplexedSRTServer;
        before(() => { MultiplexedSRTServer = loadSrtServer(); });
        beforeEach(() => {
            rtmp = new MultiplexedRTMPServer({});
            ws = new MultiplexedWebsocketServer({});
            srt = new MultiplexedSRTServer({});
            for (const s of [rtmp, ws, srt]) s.setSessions(sessions());
        });

        const cases = [
            ['rtmp', (id) => { const [sid, idx] = id.split(','); return rtmp.validateStream(`/${sid}/${idx}`); }],
            ['ws', (id) => ws.validateStream({ url: `/${id}` })],
            ['srt', (id) => { srt.asyncSrtHelper = { getSockOpt: async () => id }; return srt.validateStream({ fd: 1 }); }],
        ];

        for (const [name, validate] of cases) {
            it(`${name}: accepts the private id and resolves the public session`, async () => {
                const r = await validate(`${PRIVATE_ID},1`);
                assert.strictEqual(r.isValid, true);
                assert.strictEqual(r.session.id, PUBLIC_ID);
                assert.strictEqual(r.channel.id, 11);
            });

            it(`${name}: rejects the public id (what a viewer knows)`, async () => {
                assert.strictEqual((await validate(`${PUBLIC_ID},0`)).isValid, false);
            });

            it(`${name}: rejects an unmigrated session's public id and an unknown id`, async () => {
                assert.strictEqual((await validate(`legacy-public,0`)).isValid, false);
                assert.strictEqual((await validate(`00000000-0000-4000-8000-000000000000,0`)).isValid, false);
            });
        }

        it('rtmp: the worker receives the canonical private path', async () => {
            const sent = [];
            rtmp.spawnWorker = () => ({ pid: 1, send: (m) => sent.push(m), on() {}, kill() {} });
            await rtmp.onConnection('nms-1', `/${PRIVATE_ID}/0`);
            assert.deepStrictEqual(sent, [{ type: 'init', streamPath: `/${PRIVATE_ID}/0` }]);
            await rtmp.onConnection('nms-2', `/${PUBLIC_ID}/0`);
            assert.strictEqual(sent.length, 1, 'public id → no worker');
        });
    });
});
