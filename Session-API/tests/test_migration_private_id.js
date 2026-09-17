/**
 * The private-id migration rewrites the streamEndpoints already stored on
 * channels (public id → private id, and back on down()) so the Transcriber
 * never needs a legacy acceptance path. Pin the pure rewrite helper.
 * Hosted in the Session-API suite like test_migration_paused_down.js.
 */
const assert = require('assert');
const path = require('path');
const { describe, it } = require('mocha');

const { rewriteEndpoints } = require(path.resolve(__dirname, '../../migration/migrations/20260914000000-add-session-private-id.js'));

const PUB = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PRIV = '9b2e4c1a-0d3f-4e5a-8b6c-7d8e9f0a1b2c';

describe('add-session-private-id migration: rewriteEndpoints()', () => {
    it('replaces the public id by the private id in every protocol string', () => {
        const before = {
            srt: `srt://h:8889?streamid=${PUB},0&mode=caller&passphrase=x`,
            rtmp: `rtmp://h:1935/${PUB}/0`,
            ws: `wss://h:443/transcriber-ws/${PUB},0`,
        };
        const after = rewriteEndpoints(before, PUB, PRIV);
        assert.deepStrictEqual(after, {
            srt: `srt://h:8889?streamid=${PRIV},0&mode=caller&passphrase=x`,
            rtmp: `rtmp://h:1935/${PRIV}/0`,
            ws: `wss://h:443/transcriber-ws/${PRIV},0`,
        });
        assert.deepStrictEqual(rewriteEndpoints(after, PRIV, PUB), before, 'down() is the exact inverse');
    });

    it('leaves non-string values and unrelated objects untouched', () => {
        assert.deepStrictEqual(rewriteEndpoints({ srt: `x${PUB}`, extra: 42, none: null }, PUB, PRIV), { srt: `x${PRIV}`, extra: 42, none: null });
        assert.strictEqual(rewriteEndpoints(null, PUB, PRIV), null);
        assert.strictEqual(rewriteEndpoints(undefined, PUB, PRIV), undefined);
    });
});
