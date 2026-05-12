/**
 * Unit test for migration/migrations/20260507000000-add-paused-session-status.js
 * down() guard.
 *
 * The migration cannot drop the 'paused' enum value (Postgres limitation), so
 * the down() function must refuse to remove the pausedAt column while any
 * session row is still in status='paused'. Otherwise the rollback silently
 * loses the pausedAt timestamp and leaves orphan rows that would not survive
 * a future column rebuild.
 *
 * This test is hosted in the Session-API mocha suite for convenience (the
 * migration package has no test infra of its own); it never touches a real
 * database.
 */

const assert = require('assert');
const path = require('path');
const { describe, it } = require('mocha');

const migrationPath = path.resolve(
    __dirname,
    '../../migration/migrations/20260507000000-add-paused-session-status.js'
);
const migration = require(migrationPath);

function makeQueryInterface(pausedCount) {
    const removed = [];
    return {
        sequelize: {
            query: async (sql) => {
                // The guard issues a single COUNT(*) — return the configured value.
                if (/COUNT\(\*\)/i.test(sql)) {
                    return [[{ n: pausedCount }]];
                }
                throw new Error(`Unexpected SQL in test: ${sql}`);
            },
        },
        removeColumn: async (table, column) => {
            removed.push({ table, column });
        },
        _removed: removed,
    };
}

describe('Migration: 20260507 add-paused-session-status — down() guard', () => {
    it('refuses to rollback when paused sessions exist', async () => {
        const qi = makeQueryInterface(3);

        let caught;
        try {
            await migration.down(qi);
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'down() must throw when paused rows remain');
        assert.match(caught.message, /3 session.*paused/i,
            'error message must mention the count and the status');
        assert.match(caught.message, /UPDATE sessions/i,
            'error message must point operators at the SQL fix');
        assert.strictEqual(qi._removed.length, 0,
            'removeColumn must NOT be called when the guard trips');
    });

    it('removes the pausedAt column when no paused sessions remain', async () => {
        const qi = makeQueryInterface(0);

        await migration.down(qi);

        assert.strictEqual(qi._removed.length, 1);
        assert.deepStrictEqual(qi._removed[0], { table: 'sessions', column: 'pausedAt' });
    });
});
