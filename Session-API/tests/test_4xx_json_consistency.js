/**
 * Regression test: every 4xx response in the route handlers must be sent as
 * JSON (res.status(4xx).json({error: '...'})), not as text/plain
 * (res.status(4xx).send('...')). The shape is contractual with the global
 * error handler in components/WebServer/index.js which always returns
 * {error: err.message}, and with the Swagger ErrorResponse schema.
 *
 * If a future change re-introduces res.status(4xx).send('text'), clients that
 * special-case the JSON shape will crash on parse — surface that early via
 * a static check.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { describe, it } = require('mocha');

const ROUTES_DIR = path.resolve(__dirname, '../components/WebServer/routes/api');

function listRouteFiles() {
    return fs.readdirSync(ROUTES_DIR)
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(ROUTES_DIR, f));
}

// Match `res.status(4xx).send(`. We only flag the literal-status form here —
// dynamic forms like `res.status(code).send` exist (e.g. validation passthrough
// in transcriber_profiles) and have been migrated to .json in the same patch.
const TEXT_4XX_REGEX = /res\.status\(\s*4\d\d\s*\)\.send\(/;
// Catch the dynamic form res.status(VAR).send( where VAR is clearly a 4xx
// (status/code/statusCode variable name) — heuristic but flags the cases we
// migrated.
const TEXT_DYNAMIC_REGEX = /res\.status\(\s*(?:status|code|statusCode|httpStatus|err\.status)\s*\)\.send\(/;

describe('4xx response shape consistency', () => {
    it('no route handler uses res.status(4xx).send("text") — must use .json({error})', () => {
        const offenders = [];
        for (const file of listRouteFiles()) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, idx) => {
                if (TEXT_4XX_REGEX.test(line) || TEXT_DYNAMIC_REGEX.test(line)) {
                    offenders.push(`${path.basename(file)}:${idx + 1}: ${line.trim()}`);
                }
            });
        }

        assert.strictEqual(
            offenders.length,
            0,
            `Found ${offenders.length} 4xx response(s) using text/plain .send() instead of .json({error}):\n  - ${offenders.join('\n  - ')}\nSwitch them to res.status(4xx).json({error: '...'}) so 4xx bodies have the canonical {error: string} shape (see swagger ErrorResponse).`
        );
    });
});
