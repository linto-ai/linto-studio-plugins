/**
 * validateBotUrl() only classifies IP literals: `http://internal-name/` whose
 * DNS answer is 10.x / 127.x / 169.254.x / fd00:: passed the guard and the bot's
 * Chromium navigated there. validateBotUrlResolved() resolves DNS names and
 * rejects any that answer with a reserved address. The resolver is injected so
 * the suite never touches the network.
 */
const assert = require('assert');
const path = require('path');
const { describe, it } = require('mocha');

const { validateBotUrlResolved, isIpLiteral } = require('../components/WebServer/routes/api/bots.helpers');

function resolver(table) {
    return async (name) => {
        if (!(name in table)) { const e = new Error(`getaddrinfo ENOTFOUND ${name}`); e.code = 'ENOTFOUND'; throw e; }
        const v = table[name];
        if (v instanceof Error) throw v;
        return v.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
}

describe('validateBotUrlResolved() — DNS-aware SSRF guard', () => {
    it('rejects a public-looking name that resolves to a private / loopback / link-local / ULA address', async () => {
        const lookup = resolver({
            'internal.example.org': ['10.42.0.7'],
            'loop.example.org': ['127.0.0.2'],
            'meta.example.org': ['169.254.169.254'],
            'ula.example.org': ['fd12:3456::1'],
            'mapped.example.org': ['::ffff:192.168.1.10'],
            'mixed.example.org': ['93.184.216.34', '172.16.5.5'], // one bad answer is enough
        });
        for (const host of ['internal', 'loop', 'meta', 'ula', 'mapped', 'mixed']) {
            const r = await validateBotUrlResolved(`https://${host}.example.org/room`, { lookup });
            assert.ok(r && r.status === 400, `${host} must be rejected`);
        }
    });

    it('accepts a name that resolves only to public addresses', async () => {
        const lookup = resolver({ 'meet.example.org': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
        assert.strictEqual(await validateBotUrlResolved('https://meet.example.org/abc', { lookup }), undefined);
    });

    it('does not resolve IP literals and keeps the static verdicts', async () => {
        let called = 0;
        const lookup = async () => { called++; return [{ address: '8.8.8.8' }]; };
        assert.strictEqual(await validateBotUrlResolved('http://8.8.8.8/', { lookup }), undefined);
        assert.ok(await validateBotUrlResolved('http://10.0.0.1/', { lookup }));
        assert.ok(await validateBotUrlResolved('http://[::1]/', { lookup }));
        assert.ok(await validateBotUrlResolved('http://localhost/', { lookup }));
        assert.ok(await validateBotUrlResolved('ftp://example.org/', { lookup }));
        assert.strictEqual(called, 0);
    });

    it('lets an unresolvable name through (nothing reachable; the bot fails on its own)', async () => {
        const lookup = resolver({});
        assert.strictEqual(await validateBotUrlResolved('https://meet.example.com/room-1', { lookup }), undefined);
    });

    it('isIpLiteral() distinguishes literals from names', () => {
        assert.strictEqual(isIpLiteral('1.2.3.4'), true);
        assert.strictEqual(isIpLiteral('[::1]'), true);
        assert.strictEqual(isIpLiteral('::ffff:7f00:1'), true);
        assert.strictEqual(isIpLiteral('meet.example.org'), false);
    });

    it('POST /bots uses the resolving variant (static guard)', () => {
        const src = require('fs').readFileSync(path.resolve(__dirname, '../components/WebServer/routes/api/bots.js'), 'utf8');
        assert.ok(/await validateBotUrlResolved\(url\)/.test(src));
        assert.ok(!/[^a-zA-Z]validateBotUrl\(url\)/.test(src), 'the sync, DNS-blind variant must not be used by the route');
    });

    describe('BOT_URL_PRIVATE_HOST_ALLOWLIST (development only)', () => {
        const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
        it('lets an allowlisted host that resolves privately through', async () => {
            const err = await validateBotUrlResolved('http://127.0.0.1.nip.io:3000/room', {
                lookup: privateLookup,
                env: { BOT_URL_PRIVATE_HOST_ALLOWLIST: 'other.test, 127.0.0.1.NIP.IO' },
            });
            assert.strictEqual(err, undefined);
        });
        it('still rejects a host that is not in the list', async () => {
            const err = await validateBotUrlResolved('http://internal.test/room', {
                lookup: privateLookup,
                env: { BOT_URL_PRIVATE_HOST_ALLOWLIST: '127.0.0.1.nip.io' },
            });
            assert.strictEqual(err && err.status, 400);
        });
        it('never exempts localhost or a literal private IP', async () => {
            const env = { BOT_URL_PRIVATE_HOST_ALLOWLIST: 'localhost,10.0.0.1' };
            assert.strictEqual((await validateBotUrlResolved('http://localhost/r', { lookup: privateLookup, env })).status, 400);
            assert.strictEqual((await validateBotUrlResolved('http://10.0.0.1/r', { lookup: privateLookup, env })).status, 400);
        });
        it('is empty by default', async () => {
            const err = await validateBotUrlResolved('http://127.0.0.1.nip.io/room', { lookup: privateLookup, env: {} });
            assert.strictEqual(err && err.status, 400);
        });
    });
});
