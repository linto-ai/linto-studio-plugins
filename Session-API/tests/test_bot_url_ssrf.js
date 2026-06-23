/**
 * Unit tests for the SSRF guard on the meeting URL accepted by POST /bots.
 * Imports the REAL helper from bots.helpers.js — the same code the route runs —
 * so the route cannot silently drift from what the suite verifies.
 *
 * The meeting url is later handed to a headless Chromium via Playwright
 * page.goto(); these tests assert that loopback, RFC1918 private, link-local
 * (incl. cloud metadata 169.254.169.254), unspecified, and non-http targets are
 * rejected, while ordinary public http(s) URLs pass.
 */
const assert = require('assert');
const { describe, it } = require('mocha');

const { validateBotUrl } = require('../components/WebServer/routes/api/bots.helpers');

// Helper: a rejected url returns { error, status: 400 }.
function assertRejected(url) {
    const r = validateBotUrl(url);
    assert.ok(r, `expected ${url} to be rejected`);
    assert.strictEqual(r.status, 400, `expected 400 for ${url}`);
    assert.strictEqual(typeof r.error, 'string');
    assert.ok(r.error.length > 0, `expected a non-empty error for ${url}`);
}

// Helper: an accepted url returns undefined.
function assertAccepted(url) {
    assert.strictEqual(validateBotUrl(url), undefined, `expected ${url} to be accepted`);
}

describe('validateBotUrl() — SSRF guard (real source)', function () {

    describe('valid public URLs pass', function () {
        it('accepts https public meeting URLs', function () {
            assertAccepted('https://meet.google.com/abc-defg-hij');
            assertAccepted('https://teams.microsoft.com/l/meetup-join/xyz');
            assertAccepted('https://example.com:8443/room/42');
        });
        it('accepts a public DNS host (no resolution performed)', function () {
            assertAccepted('http://meet.example.org/room');
        });
        it('accepts a public IPv4 literal', function () {
            assertAccepted('https://8.8.8.8/');
            assertAccepted('http://1.1.1.1:443/path');
        });
        it('accepts a public IPv6 literal', function () {
            assertAccepted('https://[2001:4860:4860::8888]/');
        });
    });

    describe('non-http(s) schemes are rejected', function () {
        it('rejects file://', function () { assertRejected('file:///etc/passwd'); });
        it('rejects ftp://', function () { assertRejected('ftp://example.com/x'); });
        it('rejects gopher:// (classic SSRF vector)', function () { assertRejected('gopher://127.0.0.1:6379/'); });
        it('rejects data:', function () { assertRejected('data:text/html,<h1>x</h1>'); });
        it('rejects javascript:', function () { assertRejected('javascript:alert(1)'); });
    });

    describe('localhost names are rejected', function () {
        it('rejects http://localhost', function () { assertRejected('http://localhost/'); });
        it('rejects https://localhost with a port', function () { assertRejected('https://localhost:8080/admin'); });
        it('rejects *.localhost (RFC 6761 loopback)', function () { assertRejected('http://api.localhost/'); });
        it('rejects ip6-localhost', function () { assertRejected('http://ip6-localhost/'); });
    });

    describe('loopback IPs are rejected (127.0.0.0/8)', function () {
        it('rejects 127.0.0.1', function () { assertRejected('http://127.0.0.1/'); });
        it('rejects 127.1.2.3 (whole /8)', function () { assertRejected('http://127.1.2.3:9000/'); });
        it('rejects ::1', function () { assertRejected('http://[::1]/'); });
    });

    describe('cloud metadata endpoint is rejected (169.254.0.0/16)', function () {
        it('rejects 169.254.169.254', function () { assertRejected('http://169.254.169.254/latest/meta-data/'); });
        it('rejects the whole link-local /16', function () { assertRejected('http://169.254.1.1/'); });
    });

    describe('RFC1918 private ranges are rejected', function () {
        it('rejects 10.0.0.0/8', function () { assertRejected('http://10.1.2.3/'); });
        it('rejects 172.16.0.0/12', function () {
            assertRejected('http://172.16.0.1/');
            assertRejected('http://172.31.255.255/');
        });
        it('accepts 172.32.x (just outside the /12)', function () {
            assertAccepted('http://172.32.0.1/');
        });
        it('accepts 172.15.x (just below the /12)', function () {
            assertAccepted('http://172.15.255.255/');
        });
        it('rejects 192.168.0.0/16', function () { assertRejected('http://192.168.1.1/'); });
    });

    describe('unspecified / "this" network is rejected', function () {
        it('rejects 0.0.0.0', function () { assertRejected('http://0.0.0.0/'); });
        it('rejects 0.0.0.0/8', function () { assertRejected('http://0.1.2.3/'); });
        it('rejects [::]', function () { assertRejected('http://[::]/'); });
    });

    describe('IPv6 reserved ranges are rejected', function () {
        it('rejects fc00::/7 unique-local', function () {
            assertRejected('http://[fc00::1]/');
            assertRejected('http://[fd12:3456::1]/');
        });
        it('rejects fe80::/10 link-local', function () {
            assertRejected('http://[fe80::1]/');
        });
        it('rejects IPv4-mapped loopback ::ffff:127.0.0.1', function () {
            assertRejected('http://[::ffff:127.0.0.1]/');
        });
    });

    describe('malformed / empty input is rejected', function () {
        it('rejects empty string', function () { assertRejected(''); });
        it('rejects whitespace', function () { assertRejected('   '); });
        it('rejects a non-string', function () {
            const r = validateBotUrl(null);
            assert.ok(r); assert.strictEqual(r.status, 400);
        });
        it('rejects a garbage non-URL', function () { assertRejected('not a url'); });
    });
});
