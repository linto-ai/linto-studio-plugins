/**
 * The migration of the Scheduler's bookkeeping of the system/out/sessions/ended
 * it owes: the claim's lease column, and a partial index for the Scheduler's
 * periodic query of the owed notices.
 *
 * Hosted in the Session-API suite (lib and migration have no test infra of
 * their own); never touches a real database.
 */

const assert = require('assert');
const path = require('path');
const { describe, it } = require('mocha');

const libDir = path.dirname(require.resolve('live-srt-lib'));
const migration = require(path.resolve(__dirname, '../../migration/migrations/20261013000000-session-ended-notice-claim.js'));

describe('Session endedNotice bookkeeping', () => {
    it('migration: adds the lease column and a partial index on the owed notices, and removes them', async () => {
        const calls = [];
        const queryInterface = {
            addColumn: async (...args) => calls.push(['addColumn', ...args]),
            addIndex: async (...args) => calls.push(['addIndex', ...args]),
            removeIndex: async (...args) => calls.push(['removeIndex', ...args]),
            removeColumn: async (...args) => calls.push(['removeColumn', ...args]),
        };
        const Sequelize = require(require.resolve('sequelize', { paths: [libDir] }));
        await migration.up(queryInterface, Sequelize);
        assert.deepStrictEqual(calls.map((c) => [c[0], c[1], c[2]]), [
            ['addColumn', 'sessions', 'endedNoticeLeaseUntil'],
            ['addIndex', 'sessions', ['endedNotice']],
        ]);
        assert.strictEqual(calls[0][3].allowNull, true);
        const index = calls[1][3];
        assert.strictEqual(index.name, 'sessions_ended_notice_owed');
        assert.deepStrictEqual(index.where, { endedNotice: { [Sequelize.Op.ne]: null } });
        calls.length = 0;
        await migration.down(queryInterface, Sequelize);
        assert.deepStrictEqual(calls, [
            ['removeIndex', 'sessions', 'sessions_ended_notice_owed'],
            ['removeColumn', 'sessions', 'endedNoticeLeaseUntil'],
        ]);
    });
});
