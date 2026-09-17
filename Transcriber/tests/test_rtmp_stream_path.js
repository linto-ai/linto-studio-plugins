const assert = require('assert');
const { describe, it, beforeEach } = require('mocha');
const path = require('path');

// The RTMP publish path is publisher-controlled and used to be interpolated raw
// into the GStreamer launch string. These tests pin the strict parser and the
// server behaviour: malformed paths are rejected before any session lookup, and
// the worker only ever receives the canonical `/<sessionId>/<channelIndex>`.

const { parseRtmpStreamPath } = require('../components/StreamingServer/rtmp/streamPath');
const MultiplexedRTMPServer = require(path.resolve(__dirname, '../components/StreamingServer/rtmp/RTMPServer.js'));

// Streams are addressed by the session's PRIVATE id (see streamId.js); the
// fixture uses it as the path segment.
const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function fakeSessions() {
    return [{
        id: 'public-id-not-used-on-streams',
        privateId: SESSION_ID,
        autoStart: false,
        autoEnd: false,
        channels: [{ id: 10, streamStatus: 'inactive' }, { id: 11, streamStatus: 'inactive' }],
    }];
}

describe('RTMP stream path hardening (GStreamer pipeline injection)', () => {
    describe('parseRtmpStreamPath()', () => {
        it('accepts the canonical /<uuid>/<index> shape', () => {
            const parsed = parseRtmpStreamPath(`/${SESSION_ID}/1`);
            assert.deepStrictEqual(parsed, { privateId: SESSION_ID, channelIndex: 1, safePath: `/${SESSION_ID}/1` });
        });

        it('rejects a path smuggling GStreamer elements after the channel index', () => {
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID}/0 ! filesrc location=/etc/passwd ! filesink location=/tmp/x`), null);
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID}/0!souphttpsrc`), null);
        });

        it('rejects extra segments, empty segments, non-numeric indexes and non-strings', () => {
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID}/0/extra`), null);
            assert.strictEqual(parseRtmpStreamPath(`//0`), null);
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID}/abc`), null);
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID}/`), null);
            assert.strictEqual(parseRtmpStreamPath(`/${SESSION_ID} x/0`), null);
            assert.strictEqual(parseRtmpStreamPath(undefined), null);
            assert.strictEqual(parseRtmpStreamPath(42), null);
        });
    });

    describe('MultiplexedRTMPServer', () => {
        let server;
        beforeEach(() => {
            server = new MultiplexedRTMPServer({});
            server.setSessions(fakeSessions());
        });

        it('rejects an injected path even when the session id is valid', async () => {
            const result = await server.validateStream(`/${SESSION_ID}/0 ! filesrc location=/etc/passwd ! fakesink`);
            assert.strictEqual(result.isValid, false);
        });

        it('accepts a canonical path and exposes the safe path', async () => {
            const result = await server.validateStream(`/${SESSION_ID}/1`);
            assert.strictEqual(result.isValid, true);
            assert.strictEqual(result.channel.id, 11);
            assert.strictEqual(result.safePath, `/${SESSION_ID}/1`);
        });

        it('hands the worker the canonical path, never the raw publisher string', async () => {
            const sent = [];
            server.spawnWorker = () => ({
                pid: 1,
                send: (msg) => sent.push(msg),
                on() {},
                kill() {},
            });
            await server.onConnection('nms-1', `/${SESSION_ID}/0`);
            assert.strictEqual(sent.length, 1);
            assert.deepStrictEqual(sent[0], { type: 'init', streamPath: `/${SESSION_ID}/0` });
        });

        it('never spawns a worker for an injected path', async () => {
            let spawned = 0;
            server.spawnWorker = () => { spawned++; return { pid: 1, send() {}, on() {}, kill() {} }; };
            await server.onConnection('nms-2', `/${SESSION_ID}/0 ! fakesink`);
            assert.strictEqual(spawned, 0);
        });
    });
});
