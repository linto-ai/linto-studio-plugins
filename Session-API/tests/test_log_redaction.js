/**
 * Provider secrets must never reach the logs.
 *
 * Two historical leaks are pinned here:
 *   1. POST /transcriber_profiles logged the raw body (secret in clear, before
 *      encryption) — a static guard checks the route no longer stringifies it.
 *   2. The request logger middleware masked only field names containing the
 *      exact lowercase substring "key", so apiKey / credentials / password /
 *      token went through in clear text. The redaction is now case-insensitive
 *      over a list of sensitive markers, exercised through the REAL middleware.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { describe, it, before, after, beforeEach } = require('mocha');

const liveSrtLibPath = require.resolve('live-srt-lib');
const middlewaresPath = path.resolve(__dirname, '../components/WebServer/middlewares/index.js');
const profilesRoutePath = path.resolve(__dirname, '../components/WebServer/routes/api/transcriber_profiles.js');

describe('Log redaction of provider secrets', () => {
    let teardown;
    let logged;
    let middlewares;

    before(() => {
        const origLib = require.cache[liveSrtLibPath];
        logged = [];
        require.cache[liveSrtLibPath] = {
            id: liveSrtLibPath,
            filename: liveSrtLibPath,
            loaded: true,
            exports: {
                logger: {
                    debug: (...args) => logged.push(['debug', ...args]),
                    info() {}, warn: (...args) => logged.push(['warn', ...args]), error() {},
                },
            },
        };
        delete require.cache[middlewaresPath];
        middlewares = require(middlewaresPath);
        teardown = () => {
            if (origLib) require.cache[liveSrtLibPath] = origLib;
            else delete require.cache[liveSrtLibPath];
            delete require.cache[middlewaresPath];
        };
    });

    after(() => teardown && teardown());
    beforeEach(() => { logged.length = 0; });

    describe('obfuscateKeyValues()', () => {
        it('masks every secret-bearing field name regardless of case, nested or in arrays', () => {
            const body = {
                name: 'profile',
                config: {
                    type: 'openai_streaming',
                    key: 'k1',
                    apiKey: 'k2',
                    APIKEY: 'k3',
                    credentials: '{"private_key":"pem"}',
                    password: 'p',
                    passphrase: 'pp',
                    token: 't',
                    privateKey: 'pk',
                    Authorization: 'Bearer x',
                    clientSecret: 'cs',
                    endpoint: 'wss://asr.example.org',
                    languages: [{ candidate: 'fr-FR', endpoint: 'https://custom', apiKey: 'k4' }],
                },
            };
            const out = middlewares.obfuscateKeyValues(body);
            const cfg = out.config;
            for (const f of ['key', 'apiKey', 'APIKEY', 'credentials', 'password', 'passphrase', 'token', 'privateKey', 'Authorization', 'clientSecret']) {
                assert.strictEqual(cfg[f], '***', `${f} must be masked`);
            }
            assert.strictEqual(cfg.languages[0].apiKey, '***');
            // Non-sensitive fields are preserved verbatim.
            assert.strictEqual(out.name, 'profile');
            assert.strictEqual(cfg.type, 'openai_streaming');
            assert.strictEqual(cfg.endpoint, 'wss://asr.example.org');
            assert.strictEqual(cfg.languages[0].candidate, 'fr-FR');
            assert.strictEqual(cfg.languages[0].endpoint, 'https://custom');
            // Input is not mutated.
            assert.strictEqual(body.config.apiKey, 'k2');
        });

        it('passes scalars, null and undefined through', () => {
            assert.strictEqual(middlewares.obfuscateKeyValues('x'), 'x');
            assert.strictEqual(middlewares.obfuscateKeyValues(null), null);
            assert.strictEqual(middlewares.obfuscateKeyValues(undefined), undefined);
        });
    });

    describe('request logger middleware', () => {
        it('never writes a plaintext secret from the body to the log', () => {
            const secret = 'sk-live-SUPER-SECRET-VALUE';
            const req = {
                method: 'POST', url: '/v1/transcriber_profiles',
                body: { config: { type: 'openai_streaming', apiKey: secret, credentials: secret, key: secret } },
            };
            const res = { json() {}, send() {}, on() {}, locals: {} };
            let nextCalled = false;
            middlewares.logger(req, res, () => { nextCalled = true; });
            assert.ok(nextCalled);
            const serialized = JSON.stringify(logged);
            assert.ok(logged.length > 0, 'the request line is still logged');
            assert.ok(!serialized.includes(secret), `secret leaked into the log: ${serialized}`);
            assert.ok(serialized.includes('***'));
        });
    });

    describe('POST /transcriber_profiles route (static guard)', () => {
        it('no longer stringifies the request body anywhere', () => {
            const src = fs.readFileSync(profilesRoutePath, 'utf8');
            assert.ok(!/JSON\.stringify\(\s*req\.body\s*\)/.test(src),
                'transcriber_profiles.js must not serialize req.body (it carries the provider secret in clear)');
        });
    });
});
